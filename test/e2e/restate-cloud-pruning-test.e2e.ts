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
import { createStack, destroyStackAsync, queryRestateCloudDeployments } from "./cdk-util";

describe("Restate Cloud Drained Deployment Pruning E2E Test", () => {
  $.verbose = true;

  const cdkAppPath = "stacks/restate-cloud-lambda-stack.ts";
  const stackName = "e2e-RestateCloudPruning";
  let ingressUrl: string;
  let adminUrl: string;
  let lambdaFunctionName: string; // The specific Lambda function for THIS test run

  beforeAll(async () => {
    // Initial deployment with pruning enabled
    const outputs = await createStack({
      cdkAppPath,
      stackName,
      context: { configuration_version: "v1", enable_pruning: "true" },
    });
    ingressUrl = outputs["RestateIngressUrl"];
    adminUrl = outputs["RestateAdminUrl"];
  }, 600_000);

  afterAll(async () => {
    destroyStackAsync(stackName);
  });

  it("should prune drained deployments after re-registration", async () => {
    const authToken = process.env.RESTATE_API_KEY!;

    // Step 1: Verify initial deployment works
    const id = randomUUID();
    const response = await fetch(`${ingressUrl}/Greeter/greet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(id),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`"Hello ${id}!"`);

    // Step 2: Find the deployment from THIS run (most recent with our stack name)
    const allInitialDeployments = await queryRestateCloudDeployments(adminUrl, authToken);
    // Sort by created_at descending to get the most recent first
    const sortedDeployments = allInitialDeployments
      .filter((d) => d.arn?.includes(stackName))
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    console.log("All deployments for this stack:", sortedDeployments);
    expect(sortedDeployments.length).toBeGreaterThanOrEqual(1);

    const initialDeployment = sortedDeployments[0];
    const initialDeploymentId = initialDeployment.id;
    // Extract the Lambda function name (without version) to track THIS run's deployments
    lambdaFunctionName = initialDeployment.arn?.replace(/:\d+$/, "") ?? "";
    console.log(`Initial deployment: ${initialDeploymentId}, Lambda: ${lambdaFunctionName}`);

    // Step 3: Re-deploy with a new configuration version to trigger re-registration
    // This creates a new deployment (v2) and drains the old one (v1); pruning should clean up v1
    console.log("Re-deploying with new configuration version...");
    await createStack({
      cdkAppPath,
      stackName,
      context: { configuration_version: "v2", enable_pruning: "true" },
    });

    // Step 4: Verify the service still works
    const id2 = randomUUID();
    const response2 = await fetch(`${ingressUrl}/Greeter/greet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(id2),
    });
    expect(response2.status).toBe(200);
    expect(await response2.text()).toBe(`"Hello ${id2}!"`);

    // Step 5: Check that the initial deployment was pruned
    const allFinalDeployments = await queryRestateCloudDeployments(adminUrl, authToken);
    // Filter to only THIS Lambda function's deployments
    const thisRunDeployments = allFinalDeployments.filter((d) => d.arn?.startsWith(lambdaFunctionName + ":"));
    console.log("Final deployments for this Lambda:", thisRunDeployments);

    // Should have exactly 1 deployment for this Lambda (v2), because v1 was pruned
    expect(thisRunDeployments.length).toBe(1);

    // The remaining deployment should NOT be the initial one (it was pruned)
    const finalDeploymentId = thisRunDeployments[0].id;
    expect(finalDeploymentId).not.toBe(initialDeploymentId);
    console.log(`Final deployment: ${finalDeploymentId} (initial ${initialDeploymentId} was pruned)`);
  }, 600_000);
});
