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

/**
 * Upgrading from 1.7.0, whose default made every service public, to the "declared" default. The release note says the
 * upgrade itself registers each deployment again without changing visibility, and services that declare
 * `ingressPrivate` turn private on the next deploy that ships new code.
 */
describe("Restate Cloud upgrade from 1.7.0 E2E Test", () => {
  $.verbose = true;

  const cdkAppPath = "stacks/restate-cloud-lambda-stack.ts";
  const stackName = "e2e-RestateCloudUpgrade";
  const privateService = "InternalUpgrade";
  const authToken = process.env.RESTATE_API_KEY!;
  let ingressUrl: string;
  let adminUrl: string;

  const deploy = async (configurationVersion: string, cdkLibrary?: "1.7.0") => {
    const outputs = await createStack({
      cdkAppPath,
      stackName,
      context: {
        configuration_version: configurationVersion,
        private_service_name: privateService,
        ...(cdkLibrary ? { cdk_library: cdkLibrary } : {}),
      },
    });
    ingressUrl = outputs["RestateIngressUrl"];
    adminUrl = outputs["RestateAdminUrl"];
  };

  const expectPrivateServicePublic = async (expected: boolean) => {
    expect(await callGreet(ingressUrl, "Greeter", authToken)).toBe(200);
    expect(await callGreet(ingressUrl, privateService, authToken)).toBe(expected ? 200 : PRIVATE_SERVICE_STATUS);
    expect(await isServicePublic(adminUrl, privateService, authToken)).toBe(expected);
  };

  afterAll(async () => {
    destroyStackAsync(stackName);
  });

  it("makes declared-private services private on the first code change after the upgrade", async () => {
    // 1.7.0 makes every service public, including one that declares ingressPrivate.
    await deploy("v1", "1.7.0");
    await expectPrivateServicePublic(true);

    // The upgrade changes the registration's `private` property, so CloudFormation registers the unchanged
    // deployment again. Restate creates no new revision, and nothing is PATCHed.
    await deploy("v1");
    await expectPrivateServicePublic(true);

    // New code means a new Lambda version, whose new service revisions follow the declaration.
    await deploy("v2");
    await expectPrivateServicePublic(false);
  }, 1_800_000);
});
