/*
 * Copyright (c) 2023-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import * as https from "node:https";
import * as http from "node:http";

export interface HttpResponse {
  statusCode: number;
  body: string;
}

export async function httpRequest(
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

type QueryResponse = {
  rows: Record<string, unknown>[];
};

export async function queryRestate(
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

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export interface RestateAdmin {
  adminUrl: string;
  headers: Record<string, string>;
  rejectUnauthorized: boolean;
}

/**
 * Ensures the given deployment is the latest one for every listed service.
 *
 * Restate reports a repeated registration of an already-known endpoint as "unchanged" and leaves the existing
 * deployment in place, which is not enough when a CloudFormation rollback re-registers an older version. In that case
 * we re-register with `force`, which keeps the deployment id but re-runs discovery and makes it latest.
 */
export async function ensureLatestDeployment(
  admin: RestateAdmin,
  deploymentId: string,
  serviceNames: string[],
  reregisterWithForce: () => Promise<{ id: string }>,
  ownedEndpointPrefix?: string,
): Promise<void> {
  if (serviceNames.length === 0) {
    throw new Error("Cannot promote a deployment to latest without any service names.");
  }

  const latestDeployments = await queryLatestServiceDeployments(admin, serviceNames);
  if (serviceNames.every((name) => latestDeployments.get(name) === deploymentId)) {
    console.log(`Deployment ${deploymentId} is already the latest for all of its services.`);
    return;
  }

  for (const name of serviceNames) {
    const latestDeploymentId = latestDeployments.get(name) ?? "<unknown>";
    console.log(
      `Service ${name} currently points at deployment ${latestDeploymentId}, expected ${deploymentId}; promoting.`,
    );
  }

  if (ownedEndpointPrefix !== undefined) {
    const holders = [...new Set([...latestDeployments.values()].filter((id) => id !== deploymentId))];
    const endpoints = await queryDeploymentEndpoints(admin, holders);
    const foreign = holders.filter((id) => !(endpoints.get(id) ?? "").startsWith(ownedEndpointPrefix));
    if (foreign.length > 0) {
      throw new Error(
        `Refusing to promote ${deploymentId}: services are held by deployments outside ${ownedEndpointPrefix} ` +
          `(${foreign.map((id) => `${id} at ${endpoints.get(id) ?? "<unknown>"}`).join(", ")}). ` +
          "Another owner registered these services; resolve that before releasing.",
      );
    }
  }

  const reregistered = await reregisterWithForce();
  if (reregistered.id !== deploymentId) {
    throw new Error(
      `Forced re-registration produced deployment ${reregistered.id}, expected ${deploymentId}. ` +
        "Restate created a new deployment instead of promoting the existing one; refusing to continue.",
    );
  }

  const afterPromotion = await queryLatestServiceDeployments(admin, serviceNames);
  const notPromoted = serviceNames.filter((name) => afterPromotion.get(name) !== deploymentId);
  if (notPromoted.length > 0) {
    const details = notPromoted.map((name) => `${name} -> ${afterPromotion.get(name) ?? "<unknown>"}`).join(", ");
    throw new Error(
      `Deployment ${deploymentId} is still not the latest for all services after forced re-registration: ${details}.`,
    );
  }

  console.log(`Deployment ${deploymentId} is now the latest for all of its services.`);
}

async function queryDeploymentEndpoints(admin: RestateAdmin, deploymentIds: string[]): Promise<Map<string, string>> {
  if (deploymentIds.length === 0) return new Map();
  const ids = deploymentIds.map((id) => `'${escapeSqlString(id)}'`).join(", ");
  const rows = await queryRestate(
    admin.adminUrl,
    `SELECT id, endpoint FROM sys_deployment WHERE id IN (${ids})`,
    admin.headers,
    admin.rejectUnauthorized,
  );
  const endpoints = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.endpoint === "string") endpoints.set(row.id, row.endpoint);
  }
  return endpoints;
}

async function queryLatestServiceDeployments(
  admin: RestateAdmin,
  serviceNames: string[],
): Promise<Map<string, string>> {
  const names = serviceNames.map((name) => `'${escapeSqlString(name)}'`).join(", ");
  const sql = `SELECT name, deployment_id FROM sys_service WHERE name IN (${names})`;
  const rows = await queryRestate(admin.adminUrl, sql, admin.headers, admin.rejectUnauthorized);

  const latestDeployments = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.name === "string" && typeof row.deployment_id === "string") {
      latestDeployments.set(row.name, row.deployment_id);
    }
  }
  return latestDeployments;
}
