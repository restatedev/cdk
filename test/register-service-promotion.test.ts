/*
 * Copyright (c) 2023-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/cdk/blob/main/LICENSE
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { buildSync } from "esbuild";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";
import type { RegistrationProperties } from "../lib/restate-constructs/register-service-handler/index.mts";

type Handler = (event: CloudFormationCustomResourceEvent, context: unknown) => Promise<unknown>;

const ROLLED_BACK_DEPLOYMENT = "dp_v1";
const NEWER_DEPLOYMENT = "dp_v2";
const ENDPOINT_PREFIX = "https://handlers.example.com/app/";

/**
 * Bundle the handler the way it ships (an ES module tree) into one CommonJS file Jest can load. The bundle is written
 * under node_modules so that its external `@aws-sdk/*` imports resolve.
 */
function loadHandler(): Handler {
  const outfile = path.join(__dirname, "..", "node_modules", ".cache", "restate-cdk-test", "promotion.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  buildSync({
    entryPoints: [path.join(__dirname, "..", "lib", "restate-constructs", "register-service-handler", "index.mts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    outfile,
    logLevel: "silent",
  });
  return require(outfile).handler;
}

interface AdminRequest {
  method: string;
  path: string;
  body: string;
}

/**
 * A Restate admin API in which a newer deployment holds the service, as after a rollback. Registering the rolled-back
 * endpoint again returns its existing private revision; registering it with `force` promotes it and, like Restate,
 * creates a new revision with default (public) visibility.
 */
async function startRollbackAdmin({
  forcedDeploymentId = ROLLED_BACK_DEPLOYMENT,
  queryStatus = 200,
  registeredPublic = false,
}: {
  forcedDeploymentId?: string;
  /** Status for every /query request; anything but 200 fails the promotion before it re-registers. */
  queryStatus?: number;
  /** Visibility of the revision a plain registration returns. */
  registeredPublic?: boolean;
} = {}): Promise<{ url: string; requests: AdminRequest[]; close: () => Promise<void> }> {
  const requests: AdminRequest[] = [];
  let latestDeployment = NEWER_DEPLOYMENT;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method!, path: req.url!, body });
      const reply = (payload: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/deployments") {
        const force = JSON.parse(body).force === true;
        if (force) latestDeployment = ROLLED_BACK_DEPLOYMENT;
        reply({
          id: force ? forcedDeploymentId : ROLLED_BACK_DEPLOYMENT,
          services: [{ name: "internal.Worker", revision: 1, public: force || registeredPublic }],
        });
      } else if (req.method === "POST" && req.url === "/query" && queryStatus !== 200) {
        res.writeHead(queryStatus);
        res.end();
      } else if (req.method === "POST" && req.url === "/query") {
        const sql = JSON.parse(body).query as string;
        reply({
          rows: sql.includes("sys_service")
            ? [{ name: "internal.Worker", deployment_id: latestDeployment }]
            : [{ id: NEWER_DEPLOYMENT, endpoint: `${ENDPOINT_PREFIX}v2` }],
        });
      } else {
        reply({});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function rollbackEvent(adminUrl: string): CloudFormationCustomResourceEvent {
  const properties: RegistrationProperties = {
    adminUrl,
    serviceUri: `${ENDPOINT_PREFIX}v1`,
    promoteToLatest: "true",
    ownedEndpointPrefix: ENDPOINT_PREFIX,
    removalPolicy: "retain",
    private: "true",
  };
  return {
    RequestType: "Update",
    ServiceToken: "token",
    ResponseURL: "https://example.com/response",
    StackId: "stack",
    RequestId: "request",
    LogicalResourceId: "RestateServiceDeployment",
    PhysicalResourceId: "physical",
    ResourceType: "Custom::RestateServiceDeployment",
    ResourceProperties: { ServiceToken: "token", ...properties },
    OldResourceProperties: { ServiceToken: "token" },
  };
}

const isForcedRegistration = (r: AdminRequest) =>
  r.method === "POST" && r.path === "/deployments" && JSON.parse(r.body).force === true;

describe("register-service handler promotion", () => {
  const handler = loadHandler();

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test("sets visibility after a forced promotion resets it", async () => {
    const admin = await startRollbackAdmin();
    try {
      await handler(rollbackEvent(admin.url), undefined);

      const patches = admin.requests
        .filter((r) => r.method === "PATCH")
        .map((r) => ({ path: r.path, body: JSON.parse(r.body) }));
      expect(patches).toEqual([{ path: "/services/internal.Worker", body: { public: false } }]);
    } finally {
      await admin.close();
    }
  });

  test("sets visibility when promotion fails after the forced re-registration", async () => {
    // The forced registration answers with an unexpected deployment id, which fails the promotion after Restate has
    // already reset the service to public.
    const admin = await startRollbackAdmin({ forcedDeploymentId: "dp_unexpected" });
    try {
      await expect(handler(rollbackEvent(admin.url), undefined)).rejects.toThrow(
        "Forced re-registration produced deployment dp_unexpected",
      );

      // One forced registration, followed by the visibility fix and nothing that could undo it.
      expect(admin.requests.filter(isForcedRegistration)).toHaveLength(1);
      const forced = admin.requests.findIndex(isForcedRegistration);
      const next = admin.requests.slice(forced + 1).find((r) => r.method !== "POST" || r.path !== "/query");
      expect(next).toEqual({ method: "PATCH", path: "/services/internal.Worker", body: '{"public":false}' });
    } finally {
      await admin.close();
    }
  });

  test("sets visibility when promotion fails before re-registering", async () => {
    // The registration returns a new public revision, then every promotion query fails.
    const admin = await startRollbackAdmin({ queryStatus: 503, registeredPublic: true });
    try {
      await expect(handler(rollbackEvent(admin.url), undefined)).rejects.toThrow("Query failed (503)");

      expect(admin.requests.filter((r) => r.method === "PATCH")).toEqual([
        { method: "PATCH", path: "/services/internal.Worker", body: '{"public":false}' },
      ]);
      expect(admin.requests.filter((r) => r.method === "POST" && r.path === "/deployments")).toHaveLength(1);
    } finally {
      await admin.close();
    }
  });
});
