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

import { CloudFormationCustomResourceResponse } from "aws-lambda";
import { Handler } from "aws-lambda/handler";
import {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceFailedResponse,
} from "aws-lambda/trigger/cloudformation-custom-resource";
import fetch from "node-fetch";
import * as cdk from "aws-cdk-lib";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

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

/**
 * Custom Resource event handler for Restate service registration. This handler backs the custom resources created by
 * {@link RestateLambdaServiceCollection} to facilitate Lambda service handler discovery.
 */
export const handler: Handler<
  CloudFormationCustomResourceEvent,
  Partial<CloudFormationCustomResourceResponse>
> = async function (event) {
  console.log({ event });

  if (event.RequestType === "Delete") {
    // Since we retain older Lambda handler versions on update, we also leave the registered service alone. There may
    // be unfinished invocations that require it; in the future we would want to inform Restate that we want to
    // de-register the service, and wait for Restate to let us know that it is safe to delete the deployed Function
    // version from Lambda.

    // const props = event.ResourceProperties as RegistrationProperties;
    // if (props.removalPolicy === cdk.RemovalPolicy.DESTROY) {
    //   const controller = new AbortController();
    //   const id = btoa(props.serviceLambdaArn!); // TODO: we should be treating service ids as opaque
    //   const deleteResponse = await fetch(`${props.metaEndpoint}/endpoints/${id}?force=true`,
    //     {
    //       signal: controller.signal,
    //       method: "DELETE",
    //     })
    //     .finally(() => clearTimeout(registerCallTimeout));
    //   console.log(`Got delete response back: ${deleteResponse.status}`);
    // }

    return {
      Status: "SUCCESS",
    } satisfies Partial<CloudFormationCustomResourceResponse>;
  }

  const props = event.ResourceProperties as RegistrationProperties;

  const controller = new AbortController();
  const healthCheckTimeout = setTimeout(() => controller.abort("timeout"), 5_000);
  const healthCheckUrl = `${props.metaEndpoint}/health`;
  const authHeader = await createAuthHeader(props);
  console.log(`Performing health check against: ${healthCheckUrl}`);
  const healthResponse = await fetch(healthCheckUrl, {
    signal: controller.signal,
    headers: authHeader,
  }).finally(() => clearTimeout(healthCheckTimeout));

  console.log(`Got health check response back: ${healthResponse.status}`);
  if (!(healthResponse.status >= 200 && healthResponse.status < 300)) {
    console.error(`Restate health check failed: ${healthResponse.statusText} (${healthResponse.status})`);
    return {
      Reason: `Restate health check failed: ${healthResponse.statusText} (${healthResponse.status})`,
      Status: "FAILED",
    } satisfies Partial<CloudFormationCustomResourceFailedResponse>;
  }

  let attempt = 1;
  const registerCallTimeout = setTimeout(() => controller.abort("timeout"), 10_000);
  const discoveryEndpointUrl = `${props.metaEndpoint}/endpoints`;
  const registrationRequest = JSON.stringify({
    arn: props.serviceLambdaArn,
    assume_role_arn: props.invokeRoleArn,
  });
  console.log(`Triggering registration at ${discoveryEndpointUrl}: ${registrationRequest} (attempt ${attempt})`);
  while (true) {
    try {
      const discoveryResponse = await fetch(discoveryEndpointUrl, {
        signal: controller.signal,
        method: "POST",
        body: registrationRequest,
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
      }).finally(() => clearTimeout(registerCallTimeout));

      console.log(`Got registration response back: ${discoveryResponse.status}`);

      if (discoveryResponse.status >= 200 && discoveryResponse.status < 300) {
        const response = (await discoveryResponse.json()) as EndpointResponse;

        if (response?.services?.[0]?.name !== props.servicePath) {
          console.error(`Service registration failed: ${discoveryResponse.statusText} (${discoveryResponse.status})`);
          return {
            Reason: `Restate service registration failed: name returned by service ("${response?.services?.[0]?.name})) does not match expected ("${props.servicePath}")`,
            Status: "FAILED",
          } satisfies Partial<CloudFormationCustomResourceFailedResponse>;
        }

        return {
          Data: response,
          Status: "SUCCESS",
        } satisfies Partial<CloudFormationCustomResourceResponse>;
      }
    } catch (e) {
      console.log(`Service registration call failed: ${(e as Error)?.message} (attempt ${attempt})`);
    }

    attempt += 1;
    if (attempt >= 3) {
      console.error(`Service registration failed after ${attempt} attempts.`);
      break;
    }
  }

  return {
    Reason: `Restate service registration failed: ${healthResponse.statusText} (${healthResponse.status})`,
    Status: "FAILED",
  } satisfies Partial<CloudFormationCustomResourceResponse>;
};

async function createAuthHeader(props: RegistrationProperties): Promise<Record<string, string>> {
  if (!props.authTokenSecretArn) {
    return {};
  }

  console.log(`Using bearer authentication token from secret ${props.authTokenSecretArn}`)
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
