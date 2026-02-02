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

  /** What to do when the handler is removed: "retain" (default) or "destroy". */
  removalPolicy?: "retain" | "destroy";

  /** Whether to prune drained deployments for the same handler after registration. */
  pruneDrainedDeployments?: "true" | "false";

  /** Number of old drained deployment revisions to retain when pruning. */
  revisionHistoryLimit?: number;

  /** Maximum number of drained deployments to prune per run. */
  maxPrunedPerRun?: number;
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
    if (props.removalPolicy !== "destroy") {
      console.log("Removal policy is 'retain'; leaving deployment registered in Restate.");
      return;
    }

    let authHeader: Record<string, string> = {};
    try {
      authHeader = await createAuthHeader(props);
    } catch (e) {
      console.warn(`Failed to load auth token for deletion: ${(e as Error)?.message}`);
      console.warn("Proceeding with deletion without auth header.");
    }

    console.log(`Removal policy is 'destroy'; finding deployment for ${props.serviceLambdaArn}`);

    // Best-effort deletion: log errors but don't fail CloudFormation delete
    try {
      const deploymentIds = await findDeploymentsByEndpoint(
        props.adminUrl!,
        props.serviceLambdaArn!,
        authHeader,
        rejectUnauthorized,
      );

      if (deploymentIds.length === 0) {
        console.log("No deployments found for this endpoint; nothing to delete.");
        return;
      }

      for (const deploymentId of deploymentIds) {
        try {
          console.log(`Deleting deployment ${deploymentId}...`);
          await deleteDeployment(props.adminUrl!, deploymentId, authHeader, rejectUnauthorized);
          console.log(`Deleted deployment ${deploymentId}.`);
        } catch (e) {
          console.warn(`Failed to delete deployment ${deploymentId}: ${(e as Error)?.message}`);
        }
      }
    } catch (e) {
      console.warn(`Failed to query/delete deployments: ${(e as Error)?.message}`);
    }
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

        if (props.pruneDrainedDeployments === "true") {
          try {
            if (!props.serviceLambdaArn) {
              console.warn("Pruning requested but no serviceLambdaArn provided; skipping.");
            } else {
              await pruneDrainedDeployments(
                props.adminUrl!,
                props.serviceLambdaArn,
                props.revisionHistoryLimit ?? 0,
                props.maxPrunedPerRun ?? 10,
                authHeader,
                rejectUnauthorized,
              );
            }
          } catch (e) {
            console.warn(`Failed to prune drained deployments: ${(e as Error)?.message}`);
          }
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

async function deleteDeployment(
  adminUrl: string,
  deploymentId: string,
  authHeader: Record<string, string>,
  rejectUnauthorized: boolean,
) {
  const deleteUrl = new URL(`${adminUrl}/${DEPLOYMENTS_PATH}/${deploymentId}?force=true`);

  const deleteResponse = await httpRequest(deleteUrl, {
    method: "DELETE",
    headers: authHeader,
    timeout: 10_000,
    rejectUnauthorized,
  });

  const isSuccess =
    (deleteResponse.statusCode >= 200 && deleteResponse.statusCode < 300) || deleteResponse.statusCode === 404;
  if (!isSuccess) {
    throw new Error(`Delete deployment failed (${deleteResponse.statusCode}): ${deleteResponse.body}`);
  }
}

type QueryResponse = {
  rows: Record<string, unknown>[];
};

async function queryRestate(
  adminUrl: string,
  sql: string,
  authHeader: Record<string, string>,
  rejectUnauthorized: boolean,
): Promise<Record<string, unknown>[]> {
  const queryUrl = new URL(`${adminUrl}/query`);

  const queryResponse = await httpRequest(queryUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json", // Request JSON format (default is Apache Arrow IPC binary)
      ...authHeader,
    },
    body: JSON.stringify({ query: sql }),
    timeout: 30_000,
    rejectUnauthorized,
  });

  if (queryResponse.statusCode !== 200) {
    throw new Error(`Query failed (${queryResponse.statusCode}): ${queryResponse.body}`);
  }

  const response = JSON.parse(queryResponse.body) as QueryResponse;
  return response.rows;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

async function findDeploymentsByEndpoint(
  adminUrl: string,
  endpointArn: string,
  authHeader: Record<string, string>,
  rejectUnauthorized: boolean,
): Promise<string[]> {
  const sql = `
    SELECT id FROM sys_deployment
    WHERE endpoint = '${escapeSqlString(endpointArn)}'
  `;

  const rows = await queryRestate(adminUrl, sql, authHeader, rejectUnauthorized);
  return rows.map((row) => row.id as string);
}

async function pruneDrainedDeployments(
  adminUrl: string,
  _endpointArn: string,
  revisionHistoryLimit: number,
  maxPrunedPerRun: number,
  authHeader: Record<string, string>,
  rejectUnauthorized: boolean,
) {
  const safeOffset = Math.max(0, revisionHistoryLimit);
  const safeLimit = Math.max(1, maxPrunedPerRun);

  console.log(`Pruning drained deployments (keeping ${safeOffset} revisions, max ${safeLimit} per run)`);

  // Find drained deployments: no associated services and no active pinned invocations
  // Deployments with only completed invocations can be pruned
  // Prune oldest first, skip the N most recent drained ones
  const sql = `
    SELECT d.id, d.created_at
    FROM sys_deployment d
    LEFT JOIN sys_service s ON (d.id = s.deployment_id)
    LEFT JOIN sys_invocation_status i ON (d.id = i.pinned_deployment_id AND i.status != 'completed')
    WHERE s.name IS NULL
      AND i.id IS NULL
    ORDER BY d.created_at DESC
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `;

  const drainedDeployments = await queryRestate(adminUrl, sql, authHeader, rejectUnauthorized);

  if (drainedDeployments.length === 0) {
    console.log("No drained deployments to prune.");
    return;
  }

  console.log(`Found ${drainedDeployments.length} drained deployment(s) to prune.`);

  for (const deployment of drainedDeployments) {
    const deploymentId = deployment.id as string;
    try {
      console.log(`Deleting drained deployment ${deploymentId}...`);
      await deleteDeployment(adminUrl, deploymentId, authHeader, rejectUnauthorized);
      console.log(`Deleted drained deployment ${deploymentId}.`);
    } catch (e) {
      console.warn(`Failed to delete drained deployment ${deploymentId}: ${(e as Error)?.message}`);
    }
  }
}
