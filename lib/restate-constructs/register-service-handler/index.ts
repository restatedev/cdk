/*
 * Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
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
import * as https from "https";

export interface RegistrationProperties {
  servicePath?: string;
  metaEndpoint?: string;
  serviceEndpoint?: string;
  serviceLambdaArn?: string;
  invokeRoleArn?: string;
  removalPolicy?: cdk.RemovalPolicy;
  authTokenSecretArn?: string;
}

type EndpointResponse = {
  id?: string;
  services?: { name?: string; revision?: number }[];
};

const MAX_HEALTH_CHECK_ATTEMPTS = 3;
const MAX_REGISTRATION_ATTEMPTS = 3;

const INSECURE = true;

/**
 * Custom Resource event handler for Restate service registration. This handler backs the custom resources created by
 * {@link LambdaServiceRegistry} to facilitate Lambda service handler discovery.
 */
export const handler: Handler<CloudFormationCustomResourceEvent, void> = async function (event) {
  console.log({ event });

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
    //   const deleteResponse = await fetch(`${props.metaEndpoint}/deployments/${id}?force=true`, {
    //     signal: controller.signal,
    //     method: "DELETE",
    //     agent: INSECURE ? new https.Agent({ rejectUnauthorized: false }) : undefined,
    //   }).finally(() => clearTimeout(deleteCallTimeout));
    //
    //   console.log(`Got delete response back: ${deleteResponse.status}`);
    //   if (deleteResponse.status != 202) {
    //     throw new Error(`Deleting service endpoint failed: ${deleteResponse.statusText} (${deleteResponse.status})`);
    //   }
    // }

    console.warn("De-registering services is not supported currently. Previous version will remain registered.");
    return;
  }

  const props = event.ResourceProperties as RegistrationProperties;
  const authHeader = await createAuthHeader(props);

  let attempt;
  const controller = new AbortController();

  const healthCheckUrl = `${props.metaEndpoint}/health`;

  console.log(`Performing health check against: ${healthCheckUrl}`);
  attempt = 1;
  while (true) {
    const healthCheckTimeout = setTimeout(() => controller.abort("timeout"), 5_000);
    let healthResponse = undefined;
    let errorMessage = undefined;
    try {
      healthResponse = await fetch(healthCheckUrl, {
        signal: controller.signal,
        headers: authHeader,
        agent: INSECURE ? new https.Agent({ rejectUnauthorized: false }) : undefined,
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

    if (attempt > MAX_HEALTH_CHECK_ATTEMPTS) {
      console.error(`Meta health check still failing after ${attempt} attempts.`);
      throw new Error(errorMessage ?? `${healthResponse?.statusText} (${healthResponse?.status})`);
    }
    attempt += 1;

    const waitTimeMillis = 2 ** attempt * 1_000;
    console.log(`Retrying after ${waitTimeMillis} ms...`);
    await sleep(waitTimeMillis);
  }

  const deploymentsUrl = `${props.metaEndpoint}/deployments`;
  const registrationRequest = JSON.stringify({
    arn: props.serviceLambdaArn,
    assume_role_arn: props.invokeRoleArn,
  });

  let failureReason;
  console.log(`Triggering registration at ${deploymentsUrl}: ${registrationRequest}`);
  attempt = 1;
  while (true) {
    try {
      const registerCallTimeout = setTimeout(() => controller.abort("timeout"), 10_000);
      const discoveryResponse = await fetch(deploymentsUrl, {
        signal: controller.signal,
        method: "POST",
        body: registrationRequest,
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        agent: INSECURE ? new https.Agent({ rejectUnauthorized: false }) : undefined,
      }).finally(() => clearTimeout(registerCallTimeout));

      console.log(`Got registration response back: ${discoveryResponse.status}`);

      if (discoveryResponse.status >= 200 && discoveryResponse.status < 300) {
        const response = (await discoveryResponse.json()) as EndpointResponse;

        if (response?.services?.[0]?.name !== props.servicePath) {
          failureReason =
            "Restate service registration failed: service name indicated by service response" +
            ` ("${response?.services?.[0]?.name})) does not match the expected value ("${props.servicePath}")!`;
          console.error(failureReason);
          break; // don't throw immediately - let retry loop decide whether to abort
        }

        console.log("Success!");
        return;
      }
    } catch (e) {
      console.error(`Service registration call failed: ${(e as Error)?.message} (attempt ${attempt})`);
    }

    if (attempt > MAX_REGISTRATION_ATTEMPTS) {
      console.error(`Service registration failed after ${attempt} attempts.`);
      break;
    }
    attempt += 1;
    const waitTimeMillis = 2_000 + 2 ** attempt * 1_000; // 3s -> 6s -> 10s
    console.log(`Retrying registration after ${waitTimeMillis} ms...`);
    await sleep(waitTimeMillis);
  }

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
  await new Promise((resolve) => setTimeout(resolve, millis));
}
