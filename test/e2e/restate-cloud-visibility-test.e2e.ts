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

import { $ } from "zx";
import { callGreet, createStack, destroyStackAsync, isServicePublic } from "./cdk-util";

// Restate ingress answers 400 for a service that is not public.
const PRIVATE_SERVICE_STATUS = 400;

describe("Restate Cloud declared service visibility E2E Test", () => {
  $.verbose = true;

  const cdkAppPath = "stacks/restate-cloud-lambda-stack.ts";
  const stackName = "e2e-RestateCloudVisibility";
  const privateService = "InternalVisibility";
  const authToken = process.env.RESTATE_API_KEY!;
  let ingressUrl: string;
  let adminUrl: string;

  const deploy = async (configurationVersion: string) => {
    const outputs = await createStack({
      cdkAppPath,
      stackName,
      context: { configuration_version: configurationVersion, private_service_name: privateService },
    });
    ingressUrl = outputs["RestateIngressUrl"];
    adminUrl = outputs["RestateAdminUrl"];
  };

  const expectDeclaredVisibility = async () => {
    expect(await callGreet(ingressUrl, "Greeter", authToken)).toBe(200);
    expect(await isServicePublic(adminUrl, "Greeter", authToken)).toBe(true);
    expect(await callGreet(ingressUrl, privateService, authToken)).toBe(PRIVATE_SERVICE_STATUS);
    expect(await isServicePublic(adminUrl, privateService, authToken)).toBe(false);
  };

  afterAll(async () => {
    destroyStackAsync(stackName);
  });

  it("keeps each service's declared visibility across deploys", async () => {
    // The registration sets neither `private` nor `visibility`, so it uses the "declared" default.
    await deploy("v1");
    await expectDeclaredVisibility();

    // A new Lambda version registers new service revisions, which follow the declaration again.
    await deploy("v2");
    await expectDeclaredVisibility();
  }, 1_200_000);
});
