/*
 * Copyright (c) 2023-2025 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/cdk/blob/main/LICENSE
 */

import { randomUUID } from "crypto";
import { $ } from "zx";
import { createStack, destroyStackAsync } from "./cdk-util";

describe("Single Node EC2 E2E Test", () => {
  // Make zx print all output
  $.verbose = true;

  let cdkAppPath = "stacks/ec2-simple-stack.ts";
  let stackName = "e2e-RestateSingleNode";
  let ingressUrl: string;

  beforeAll(async () => {
    const outputs = await createStack({
      cdkAppPath,
      stackName,
    });
    ingressUrl = outputs["RestateIngressUrl"];
  }, 600_000);

  afterAll(async () => {
    destroyStackAsync(stackName);
  });

  it("should successfully call the Greeter service", async () => {
    const id = randomUUID();

    const response = await fetch(`${ingressUrl}/Greeter/greet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(id),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`"Hello ${id}!"`);
  });
});
