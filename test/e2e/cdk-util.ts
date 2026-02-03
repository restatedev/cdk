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

import { $, cd, path } from "zx";

export interface CdkStackProps {
  stackName: string;
  cdkAppPath: string;
  context?: Record<string, string>;
}

interface StackOutput {
  OutputKey: string;
  OutputValue: string;
  Description?: string;
}

export async function createStack(config: CdkStackProps): Promise<Record<string, string>> {
  const noRollback = process.env["NO_ROLLBACK"] === "true";

  const contextArgs = Object.entries(config.context ?? {}).flatMap(([key, value]) => ["--context", `${key}=${value}`]);
  const extraArgs = noRollback ? ["--no-rollback"] : [];

  cd(path.resolve(__dirname));
  await $`npx cdk --app 'npx tsx ${config.cdkAppPath}' deploy ${config.stackName} \
          --context stack_name=${config.stackName} \
          ${contextArgs} \
          --output cdk.${config.stackName}.out \
          --require-approval never \
          ${extraArgs}`.timeout("575s");

  const result =
    await $`aws cloudformation describe-stacks --stack-name "${config.stackName}" --query 'Stacks[0].Outputs'`;

  const outputs: StackOutput[] = JSON.parse(result.stdout);
  return outputs.reduce(
    (acc, output) => ({
      ...acc,
      [output.OutputKey]: output.OutputValue,
    }),
    {},
  );
}

export async function destroyStackAsync(stackName: string) {
  const retainStack = new Boolean(process.env["RETAIN_STACK"]).valueOf();

  if (retainStack) {
    console.log(`Retaining stack "${stackName}"`);
  } else {
    console.log(`Asynchronously deleting stack "${stackName}"...`);
    await $`aws cloudformation delete-stack --stack-name "${stackName}"`;
  }
}

export async function destroyStack(config: CdkStackProps) {
  const retainStack = new Boolean(process.env["RETAIN_STACK"]).valueOf();

  if (retainStack) {
    console.log(`Retaining stack "${config.stackName}"`);
  } else {
    const contextArgs = Object.entries(config.context ?? {}).flatMap(([key, value]) => [
      "--context",
      `${key}=${value}`,
    ]);

    await $`npx cdk --app 'npx tsx ${config.cdkAppPath}' destroy \
      --context stack_name=${config.stackName} \
      ${contextArgs} \
      --output "cdk.${config.stackName}.out" \
      --force`.timeout("595s");
  }
}

interface Deployment {
  id: string;
  endpoint?: string;
  arn?: string;
  created_at?: string;
}

async function runSsmCommand(instanceId: string, command: string): Promise<string> {
  const result =
    await $`aws ssm send-command --instance-ids ${instanceId} --document-name "AWS-RunShellScript" --parameters commands=${JSON.stringify([command])} --output json`;

  const commandObj = JSON.parse(result.stdout);
  const commandId = commandObj.Command.CommandId;

  // Wait for command to complete (with timeout handling)
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const statusResult =
      await $`aws ssm get-command-invocation --command-id ${commandId} --instance-id ${instanceId} --output json`;
    const status = JSON.parse(statusResult.stdout);
    if (status.Status === "Success") {
      return status.StandardOutputContent;
    }
    if (status.Status === "Failed") {
      throw new Error(`SSM command failed: ${status.StandardErrorContent}`);
    }
  }
  throw new Error("SSM command timed out");
}

export async function queryRestateDeployments(instanceId: string): Promise<Deployment[]> {
  // Use SSM to query the admin API via curl from the instance
  const output = await runSsmCommand(instanceId, "curl -s http://localhost:9070/deployments");
  const response = JSON.parse(output) as { deployments: Deployment[] };
  return response.deployments;
}

export async function queryRestateCloudDeployments(adminUrl: string, authToken: string): Promise<Deployment[]> {
  const response = await fetch(`${adminUrl}/deployments`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to query deployments: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { deployments: Deployment[] };
  return data.deployments;
}
