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

const MAX_HEALTH_CHECK_ATTEMPTS = 10; // This is intentionally quite long to allow some time for first-run EC2 and Docker boot up
const MAX_REGISTRATION_ATTEMPTS = 3;

const DEPLOYMENTS_PATH = "deployments";
const SERVICES_PATH = "services";

interface HttpResponse {
  statusCode: number;
  body: string;
}

async function httpRequest(
  url: URL,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
    rejectUnauthorized?: boolean;
  },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method,
      headers: options.headers,
      timeout: options.timeout,
      rejectUnauthorized: options.rejectUnauthorized,
    };

    const req = lib.request(reqOptions, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Custom Resource event handler for Restate service registration. This handler backs the custom resources created by
 * {@link ServiceDeployer} to facilitate Lambda service handler discovery.
 */
export const handler = async function (event: CloudFormationCustomResourceEvent) {
  console.log({ event });

  const props = event.ResourceProperties as RegistrationProperties;
  const rejectUnauthorized = props.insecure !== "true";

  if (event.RequestType === "Delete") {
    // Since we retain older Lambda handler versions on update, we also leave the registered service alone. There may
    // be unfinished invocations that require it; in the future we would want to inform Restate that we want to
    // de-register the service, and wait for Restate to let us know that it is safe to delete the deployed Function
    // version from Lambda.
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
    let healthResponse: HttpResponse | undefined = undefined;
    let errorMessage: string | undefined = undefined;
    try {
      healthResponse = await httpRequest(healthCheckUrl, {
        method: "GET",
        headers: authHeader,
        timeout: 5_000,
        rejectUnauthorized,
      });

      console.log(`Got health check response back: ${healthResponse.statusCode}`);
      if (healthResponse.statusCode >= 200 && healthResponse.statusCode < 300) {
        break;
      }
      console.error(`Restate health check failed: (${healthResponse.statusCode}; attempt ${attempt})`);
    } catch (e) {
      errorMessage = (e as Error)?.message;
      console.error(`Restate health check failed: "${errorMessage}" (attempt ${attempt})`);
    }

    if (attempt >= MAX_HEALTH_CHECK_ATTEMPTS) {
      console.error(`Admin service health check failing after ${attempt} attempts.`);
      throw new Error(errorMessage ?? `(${healthResponse?.statusCode})`);
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

      const registerDeploymentResponse = await httpRequest(deploymentsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: registrationRequest,
        timeout: 10_000,
        rejectUnauthorized,
      });

      if (registerDeploymentResponse.statusCode >= 200 && registerDeploymentResponse.statusCode < 300) {
        const response = JSON.parse(registerDeploymentResponse.body) as RegisterDeploymentResponse;

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

          const patchResponse = await httpRequest(patchUrl, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...authHeader,
            },
            body: JSON.stringify({ public: isPublic }),
            timeout: 10_000,
            rejectUnauthorized,
          });

          console.log(`Got patch response back: ${patchResponse.statusCode}`);
          if (patchResponse.statusCode != 200) {
            failureReason = `Marking service as ${props.private ? "private" : "public"} failed: (${patchResponse.statusCode})`;
            break registration_retry_loop; // don't throw immediately - let retry loop decide whether to abort s
          }

          console.log(`Successfully marked service as ${isPublic ? "public" : "private"}.`);
        }

        return; // Overall success!
      } else {
        failureReason = `Registration failed (${registerDeploymentResponse.statusCode}): ${registerDeploymentResponse.body}`;
        console.log({
          message: `Got error response from Restate.`,
          code: registerDeploymentResponse.statusCode,
          body: registerDeploymentResponse.body,
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
