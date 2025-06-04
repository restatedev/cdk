/*
 * Copyright (c) 2023-2025 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import type { CloudFormationCustomResourceEvent } from "aws-lambda/trigger/cloudformation-custom-resource";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NodeHttpHandler, streamCollector } from "@aws-sdk/node-http-handler";
import { HttpRequest } from "@aws-sdk/protocol-http";

import { randomInt } from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";

/**
 * Custom Resource event shape for registering Restate Lambda service handlers with a Restate environment.
 */
export interface RegistrationProperties {
  /** Where to find the Restate admin endpoint. */
  adminUrl?: string;

  /**
   * Optional service name to look for in the deployment. If more than one service is behind the same endpoint, any one
   * should match. Leave unset to skip the check.
   */
  servicePath?: string;

  serviceLambdaArn?: string;

  invokeRoleArn?: string;

  /**
   * Authentication token ARN to use with the admin endpoint. The secret value will be used as a bearer token, if set.
   */
  authTokenSecretArn?: string;

  /** Not used by the handler, purely used to trick CloudFormation to perform an update when it otherwise would not. */
  configurationVersion?: string;

  /**
   * Whether to mark the service as private, and make it unavailable to be called via Restate ingress. If there are
   * multiple services provided by the endpoint, they will all be marked as specified.
   */
  private?: "true" | "false";

  /** Whether to trust any certificate when connecting to the admin endpoint. */
  insecure?: "true" | "false";

  // removalPolicy?: string;
}

type RegisterDeploymentResponse = {
  id: string;
  services: { name: string; revision: number; public: boolean }[];
};

const MAX_HEALTH_CHECK_ATTEMPTS = 5; // This is intentionally quite long to allow some time for first-run EC2 and Docker boot up
const MAX_REGISTRATION_ATTEMPTS = 3;

const DEPLOYMENTS_PATH = "deployments";
const SERVICES_PATH = "services";

/**
 * Custom Resource event handler for Restate service registration. This handler backs the custom resources created by
 * {@link ServiceDeployer} to facilitate Lambda service handler discovery.
 */
export const handler = async function (event: CloudFormationCustomResourceEvent) {
  console.log({ event });

  const props = event.ResourceProperties as RegistrationProperties;

  const httpHandler = new NodeHttpHandler({
    httpsAgent: new https.Agent({
      keepAlive: true,
      rejectUnauthorized: props.insecure !== "true",
    }),
    httpAgent: new http.Agent({
      keepAlive: true,
    }),
  });

  if (event.RequestType === "Delete") {
    // Since we retain older Lambda handler versions on update, we also leave the registered service alone. There may
    // be unfinished invocations that require it; in the future we would want to inform Restate that we want to
    // de-register the service, and wait for Restate to let us know that it is safe to delete the deployed Function
    // version from Lambda.

    // const props = event.ResourceProperties as RegistrationProperties;
    // if (props.removalPolicy === cdk.RemovalPolicy.DESTROY) {
    //   console.log(`De-registering service ${props.serviceLambdaArn}`);
    //   const controller = new AbortController();
    //   const id = btoa(props.serviceLambdaArn!); // TODO: we should be treating service ids as opaque
    //   const deleteCallTimeout = setTimeout(() => controller.abort("timeout"), 5_000);
    //   const deleteResponse = await fetch(`${props.adminUrl}/${DEPLOYMENTS_PATH}/${id}?force=true`, {
    //     signal: controller.signal,
    //     method: "DELETE",
    //     agent: agentSelector,
    //   }).finally(() => clearTimeout(deleteCallTimeout));
    //
    //   console.log(`Got delete response back: ${deleteResponse.status}`);
    //   if (deleteResponse.status != 202) {
    //     throw new Error(`Removing service deployment failed: ${deleteResponse.statusText} (${deleteResponse.status})`);
    //   }
    // }

    console.warn("De-registering services is not supported currently. Previous version will remain registered.");
    return;
  }

  const authHeader = await createAuthHeader(props);

  let attempt;

  const healthCheckUrl = new URL(`${props.adminUrl}/health`);

  attempt = 1;
  console.log(`Performing health check against: ${healthCheckUrl}`);
  while (true) {
    console.log(`Making health check request #${attempt}...`);
    let healthResponse = undefined;
    let errorMessage = undefined;
    try {
      healthResponse = (
        await httpHandler.handle(
          new HttpRequest({
            headers: authHeader,
            protocol: healthCheckUrl.protocol,
            hostname: healthCheckUrl.hostname,
            port: healthCheckUrl.port ? Number(healthCheckUrl.port) : undefined,
            path: healthCheckUrl.pathname,
            method: "GET",
          }),
          { requestTimeout: 5_000 },
        )
      ).response;

      console.log(`Got health check response back: ${healthResponse.statusCode}`);
      if (healthResponse.statusCode >= 200 && healthResponse.statusCode < 300) {
        break;
      }
      console.error(
        `Restate health check failed: ${healthResponse.reason} (${healthResponse.statusCode}; attempt ${attempt})`,
      );
    } catch (e) {
      errorMessage = (e as Error)?.message;
      console.error(`Restate health check failed: "${errorMessage}" (attempt ${attempt})`);
    }

    if (attempt >= MAX_HEALTH_CHECK_ATTEMPTS) {
      console.error(`Admin service health check failing after ${attempt} attempts.`);
      throw new Error(errorMessage ?? `${healthResponse?.reason} (${healthResponse?.statusCode})`);
    }
    attempt += 1;

    const waitTimeMillis = randomInt(2_000) + 2 ** attempt * 1_000; // 3s -> 6s -> 10s -> 18s -> 34s
    console.log(`Retrying after ${waitTimeMillis} ms...`);
    await sleep(waitTimeMillis);
  }

  const deploymentsUrl = new URL(`${props.adminUrl}/${DEPLOYMENTS_PATH}`);
  const registrationRequest = JSON.stringify({
    arn: props.serviceLambdaArn,
    assume_role_arn: props.invokeRoleArn,
  });

  let failureReason;
  attempt = 1;
  console.log(`Registering services at ${deploymentsUrl}: ${registrationRequest}`);

  registration_retry_loop: while (true) {
    try {
      console.log(`Making registration request #${attempt}...`);

      const registerDeploymentResponse = (
        await httpHandler.handle(
          new HttpRequest({
            body: registrationRequest,
            headers: {
              "Content-Type": "application/json",
              ...authHeader,
            },
            protocol: deploymentsUrl.protocol,
            hostname: deploymentsUrl.hostname,
            port: deploymentsUrl.port ? Number(deploymentsUrl.port) : undefined,
            path: deploymentsUrl.pathname,
            method: "POST",
          }),
          { requestTimeout: 10_000 },
        )
      ).response;

      if (registerDeploymentResponse.statusCode >= 200 && registerDeploymentResponse.statusCode < 300) {
        const data = await streamCollector(registerDeploymentResponse.body);
        const dataStr = new TextDecoder().decode(data);
        const response = JSON.parse(dataStr) as RegisterDeploymentResponse;

        if (props.servicePath && !response.services.find((s) => s.name === props.servicePath)) {
          failureReason =
            "Registration succeeded, but none of the service names in the deployment match the specified name. " +
            `Expected "${props.servicePath}", got back: [` +
            response.services.map((svc) => svc?.name).join(", ") +
            "]";

          attempt = MAX_REGISTRATION_ATTEMPTS; // don't retry this
          break;
        }

        console.log("Successful registration! Services: ", JSON.stringify(response.services));

        const isPublic = (props.private ?? "false") === "false";

        for (const service of response.services ?? []) {
          if (service.public === isPublic) {
            console.log(`Service ${service.name} is ${isPublic ? "public" : "private"}.`);
            continue;
          }

          console.log(`Marking service ${service.name} as ${isPublic ? "public" : "private"}...`);
          const patchUrl = new URL(`${props.adminUrl}/${SERVICES_PATH}/${service.name}`);

          const patchResponse = (
            await httpHandler.handle(
              new HttpRequest({
                body: JSON.stringify({ public: isPublic }),
                headers: {
                  "Content-Type": "application/json",
                  ...authHeader,
                },
                protocol: patchUrl.protocol,
                hostname: patchUrl.hostname,
                port: patchUrl.port ? Number(patchUrl.port) : undefined,
                path: patchUrl.pathname,
                method: "PATCH",
              }),
              { requestTimeout: 10_000 },
            )
          ).response;

          console.log(`Got patch response back: ${patchResponse.statusCode}`);
          if (patchResponse.statusCode != 200) {
            failureReason = `Marking service as ${props.private ? "private" : "public"} failed: ${patchResponse.reason} (${patchResponse.statusCode})`;
            break registration_retry_loop; // don't throw immediately - let retry loop decide whether to abort s
          }

          console.log(`Successfully marked service as ${isPublic ? "public" : "private"}.`);
        }

        return; // Overall success!
      } else {
        const errorBody = await streamCollector(registerDeploymentResponse.body);
        const errorBodyStr = new TextDecoder().decode(errorBody);

        failureReason = `Registration failed (${registerDeploymentResponse.reason}): ${errorBodyStr}`;
        console.log({
          message: `Got error response from Restate.`,
          code: registerDeploymentResponse.statusCode,
          body: errorBody,
        });
      }
    } catch (e) {
      console.error(`Registration failed: ${(e as Error)?.message} (attempt ${attempt})`);
      failureReason = (e as Error)?.message;
    }

    if (attempt >= MAX_REGISTRATION_ATTEMPTS) {
      failureReason = `Giving up after ${attempt} attempts. Last error: ${failureReason}`;
      break;
    }
    attempt += 1;
    const waitTimeMillis = randomInt(2_000) + 2 ** attempt * 1_000; // 3s -> 6s -> 10s
    console.log(`Retrying registration after ${waitTimeMillis} ms...`);
    await sleep(waitTimeMillis);
  }

  console.error(failureReason);
  throw new Error(failureReason ?? "Restate service registration failed. Please see logs for details.");
};

async function createAuthHeader(props: RegistrationProperties): Promise<Record<string, string>> {
  if (!props.authTokenSecretArn) {
    return {};
  }

  console.log(`Using bearer authentication token from secret ${props.authTokenSecretArn}`);
  const ssm = new SecretsManagerClient();
  const response = await ssm.send(
    new GetSecretValueCommand({
      SecretId: props.authTokenSecretArn,
    }),
  );

  console.log(`Successfully retrieved secret "${response.Name}" version ${response.VersionId}`);
  return {
    Authorization: `Bearer ${response.SecretString}`,
  };
}

async function sleep(millis: number) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
