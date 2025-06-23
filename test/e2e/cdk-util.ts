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
}

interface StackOutput {
  OutputKey: string;
  OutputValue: string;
  Description?: string;
}

export async function createStack(config: CdkStackProps): Promise<Record<string, string>> {
  const noRollback = new Boolean(process.env["NO_ROLLBACK"]).valueOf();

  cd(path.resolve(__dirname));
  await $`npx cdk --app 'npx tsx ${config.cdkAppPath}' deploy \
          --context stack_name="${config.stackName}" \
          --output "cdk.${config.stackName}.out" \
          --require-approval never \
          ${noRollback ? "--no-rollback" : ""}`.timeout("575s");

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
    await $`npx cdk --app 'npx tsx ${config.cdkAppPath}' destroy \
      --context stack_name=${config.stackName} \
      --output "cdk.${config.stackName}.out" \
      --force`.timeout("595s");
  }
}
