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

/** Services the fake admin API reports after registration: one public facade and one service declared private. */
const REGISTERED_SERVICES = [
  { name: "api.Facade", revision: 1, public: true },
  { name: "internal.Worker", revision: 1, public: false },
];

/**
 * Bundle the handler the way it ships (an ES module tree) into one CommonJS file Jest can load. The bundle is written
 * under node_modules so that its external `@aws-sdk/*` imports resolve.
 */
function loadHandler(): Handler {
  const outfile = path.join(__dirname, "..", "node_modules", ".cache", "restate-cdk-test", "register-service.cjs");
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

interface FakeAdmin {
  url: string;
  requests: AdminRequest[];
  /** Status codes for the next PATCH requests, in order; once empty, PATCHes succeed. */
  patchStatuses: number[];
  close: () => Promise<void>;
}

/** A minimal Restate admin API that accepts every registration and records the requests it receives. */
async function startFakeAdmin(): Promise<FakeAdmin> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const admin: FakeAdmin = {
    url: `http://127.0.0.1:${port}`,
    requests: [],
    patchStatuses: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      admin.requests.push({ method: req.method!, path: req.url!, body });
      if (req.method === "POST" && req.url === "/deployments") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "dp_test", services: REGISTERED_SERVICES }));
      } else if (req.method === "PATCH" && admin.patchStatuses.length > 0) {
        res.writeHead(admin.patchStatuses.shift()!);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
  });
  return admin;
}

function createEvent(
  adminUrl: string,
  visibility: RegistrationProperties["private"],
): CloudFormationCustomResourceEvent {
  const properties: RegistrationProperties = {
    adminUrl,
    serviceLambdaArn: "arn:aws:lambda:region:account-id:function:service:1",
    removalPolicy: "retain",
    ...(visibility !== undefined ? { private: visibility } : {}),
  };
  return {
    RequestType: "Create",
    ServiceToken: "token",
    ResponseURL: "https://example.com/response",
    StackId: "stack",
    RequestId: "request",
    LogicalResourceId: "RestateServiceDeployment",
    ResourceType: "Custom::RestateServiceDeployment",
    ResourceProperties: { ServiceToken: "token", ...properties },
  };
}

describe("register-service handler visibility", () => {
  let handler: Handler;
  let admin: FakeAdmin;

  beforeAll(() => {
    handler = loadHandler();
  });

  beforeEach(async () => {
    admin = await startFakeAdmin();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await admin.close();
  });

  const patches = () =>
    admin.requests.filter((r) => r.method === "PATCH").map((r) => ({ path: r.path, body: JSON.parse(r.body) }));

  test("declared visibility sends no PATCH", async () => {
    await handler(createEvent(admin.url, "declared"), undefined);

    expect(admin.requests.some((r) => r.method === "POST" && r.path === "/deployments")).toBe(true);
    expect(patches()).toEqual([]);
  });

  test("private marks every public service private", async () => {
    await handler(createEvent(admin.url, "true"), undefined);

    expect(patches()).toEqual([{ path: "/services/api.Facade", body: { public: false } }]);
  });

  test("a failed PATCH is retried without registering again", async () => {
    admin.patchStatuses = [503];

    await handler(createEvent(admin.url, "true"), undefined);

    expect(admin.requests.filter((r) => r.method === "POST" && r.path === "/deployments")).toHaveLength(1);
    expect(patches()).toEqual([
      { path: "/services/api.Facade", body: { public: false } },
      { path: "/services/api.Facade", body: { public: false } },
    ]);
  });

  test("a PATCH that keeps failing fails the deployment after three attempts", async () => {
    admin.patchStatuses = [503, 503, 503];

    await expect(handler(createEvent(admin.url, "true"), undefined)).rejects.toThrow(
      "Marking service api.Facade as private failed: (503)",
    );
    expect(admin.requests.filter((r) => r.method === "POST" && r.path === "/deployments")).toHaveLength(1);
    expect(patches()).toHaveLength(3);
  }, 15_000);

  test("a PATCH rejected with a client error is not retried", async () => {
    admin.patchStatuses = [404];

    await expect(handler(createEvent(admin.url, "true"), undefined)).rejects.toThrow(
      "Marking service api.Facade as private failed: (404)",
    );
    expect(patches()).toHaveLength(1);
  });

  test("a PATCH does not start without enough Lambda time left", async () => {
    // Plenty of time for the health check and registration, then too little once the deployment is registered.
    const registered = () => admin.requests.some((r) => r.method === "POST" && r.path === "/deployments");
    const context = { getRemainingTimeInMillis: () => (registered() ? 5_000 : 300_000) };

    await expect(handler(createEvent(admin.url, "true"), context)).rejects.toThrow(
      "Marking service api.Facade as private did not start; only 5000 ms of Lambda time left",
    );
    expect(patches()).toEqual([]);
  });

  test("an unknown visibility fails before registering", async () => {
    const event = createEvent(admin.url, "TRUE" as RegistrationProperties["private"]);

    await expect(handler(event, undefined)).rejects.toThrow('Invalid private property "TRUE"');
    expect(admin.requests).toEqual([]);
  });

  test("an absent private property marks every private service public", async () => {
    await handler(createEvent(admin.url, undefined), undefined);

    expect(patches()).toEqual([{ path: "/services/internal.Worker", body: { public: true } }]);
  });
});
