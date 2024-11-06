/*
 * Copyright (c) 2023-2024 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import { Handler } from "aws-lambda/handler";
import { CloudFormationCustomResourceEvent } from "aws-lambda/trigger/cloudformation-custom-resource";
import fetch from "node-fetch";
import * as cdk from "aws-cdk-lib";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { randomInt } from "crypto";
import * as https from "node:https";
import * as http from "node:http";

export interface RegistrationProperties {
  servicePath?: string;
  adminUrl?: string;
  serviceLambdaArn?: string;
  invokeRoleArn?: string;
  removalPolicy?: cdk.RemovalPolicy;
  authTokenSecretArn?: string;
  /* Not used by the handler, purely used to trick CloudFormation to perform an update when it otherwise would not. */
  configurationVersion?: string;
  /* Whether to mark the service as private, and make it unavailable to be called via Restate ingress. */
  private?: "true" | "false";
  /* Whether to trust any certificate from the admin endpoint. */
  insecure?: "true" | "false";
}

type RegisterDeploymentResponse = {
  id?: string;
  services?: { name?: string; revision?: number }[];
};

const MAX_HEALTH_CHECK_ATTEMPTS = 5; // This is intentionally quite long to allow some time for first-run EC2 and Docker boot up
const MAX_REGISTRATION_ATTEMPTS = 3;

// const INSECURE = true;

const DEPLOYMENTS_PATH = "deployments";
const SERVICES_PATH = "services";
const DEPLOYMENTS_PATH_LEGACY = "endpoints"; // temporarily fall back for legacy clusters

/**
 * Custom Resource event handler for Restate service registration. This handler backs the custom resources created by
 * {@link ServiceDeployer} to facilitate Lambda service handler discovery.
 */
export const handler: Handler<CloudFormationCustomResourceEvent, void> = async function (event) {
  console.log({ event });

  const props = event.ResourceProperties as RegistrationProperties;

  const httpAgent = new http.Agent({
    keepAlive: true,
  });
  const httpsAgent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: props.insecure !== "true",
  });
  const agentSelector = (url: URL) => {
    if (url.protocol == "http:") {
      return httpAgent;
    } else {
      return httpsAgent;
    }
  };

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

  const healthCheckUrl = `${props.adminUrl}/health`;

  attempt = 1;
  console.log(`Performing health check against: ${healthCheckUrl}`);
  while (true) {
    console.log(`Making health check request #${attempt}...`);
    const controller = new AbortController();
    const healthCheckTimeout = setTimeout(() => controller.abort("timeout"), 5_000);
    let healthResponse = undefined;
    let errorMessage = undefined;
    try {
      healthResponse = await fetch(healthCheckUrl, {
        signal: controller.signal,
        headers: authHeader,
        agent: agentSelector,
      }).finally(() => clearTimeout(healthCheckTimeout));

      console.log(`Got health check response back: ${healthResponse.status}`);
      if (healthResponse.status >= 200 && healthResponse.status < 300) {
        break;
      }
      console.error(
        `Restate health check failed: ${healthResponse.statusText} (${healthResponse.status}; attempt ${attempt})`,
      );
    } catch (e) {
      errorMessage = (e as Error)?.message;
      console.error(`Restate health check failed: "${errorMessage}" (attempt ${attempt})`);
    }

    if (attempt >= MAX_HEALTH_CHECK_ATTEMPTS) {
      console.error(`Admin service health check failing after ${attempt} attempts.`);
      throw new Error(errorMessage ?? `${healthResponse?.statusText} (${healthResponse?.status})`);
    }
    attempt += 1;

    const waitTimeMillis = randomInt(2_000) + 2 ** attempt * 1_000; // 3s -> 6s -> 10s -> 18s -> 34s
    console.log(`Retrying after ${waitTimeMillis} ms...`);
    await sleep(waitTimeMillis);
  }

  let deploymentsUrl = `${props.adminUrl}/${DEPLOYMENTS_PATH}`;
  const registrationRequest = JSON.stringify({
    arn: props.serviceLambdaArn,
    assume_role_arn: props.invokeRoleArn,
  });

  let failureReason;
  attempt = 1;
  console.log(`Triggering registration at ${deploymentsUrl}: ${registrationRequest}`);
  while (true) {
    try {
      console.log(`Making registration request #${attempt}...`);
      const controller = new AbortController();
      const registerCallTimeout = setTimeout(() => controller.abort("timeout"), 10_000);
      const registerDeploymentResponse = await fetch(deploymentsUrl, {
        signal: controller.signal,
        method: "POST",
        body: registrationRequest,
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        agent: agentSelector,
      }).finally(() => clearTimeout(registerCallTimeout));

      if (registerDeploymentResponse.status == 404 && attempt == 1) {
        deploymentsUrl = `${props.adminUrl}/${DEPLOYMENTS_PATH_LEGACY}`;
        console.log(`Got 404, falling back to <0.7.0 legacy endpoint registration at: ${deploymentsUrl}`);
      }

      if (registerDeploymentResponse.status >= 200 && registerDeploymentResponse.status < 300) {
        const response = (await registerDeploymentResponse.json()) as RegisterDeploymentResponse;

        // TODO: there may be more than one! support optional exact/partial matching
        if (!response?.services?.find((s) => s.name === props.servicePath)) {
          failureReason =
            "Restate service registration failed: service name indicated by service response" +
            ` ("${response?.services?.[0]?.name})) does not match the expected value ("${props.servicePath}")!`;

          attempt = MAX_REGISTRATION_ATTEMPTS; // don't retry this
          break;
        }

        console.log("Successful registration!");

        const isPublic = (props.private ?? "false") === "false";
        console.log(`Marking service ${props.servicePath} as ${isPublic ? "public" : "private"}...`);
        const controller = new AbortController();
        const privateCallTimeout = setTimeout(() => controller.abort("timeout"), 10_000);
        const patchResponse = await fetch(`${props.adminUrl}/${SERVICES_PATH}/${props.servicePath}`, {
          signal: controller.signal,
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...authHeader,
          },
          body: JSON.stringify({ public: isPublic }),
          agent: agentSelector,
        }).finally(() => clearTimeout(privateCallTimeout));

        console.log(`Got patch response back: ${patchResponse.status}`);
        if (patchResponse.status != 200) {
          failureReason = `Marking service as ${props.private ? "private" : "public"} failed: ${patchResponse.statusText} (${patchResponse.status})`;
          break; // don't throw immediately - let retry loop decide whether to abort s
        }

        console.log(`Successfully marked service as ${isPublic ? "public" : "private"}.`);

        return; // Overall success!
      } else {
        const errorBody = await registerDeploymentResponse.text();
        failureReason = `Registration failed (${registerDeploymentResponse.status}): ${errorBody}`;
        console.log({
          message: `Got error response from Restate.`,
          code: registerDeploymentResponse.status,
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
