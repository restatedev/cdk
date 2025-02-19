import { $, cd } from "zx";
import * as path from "path";
import { randomUUID } from "crypto";

// Make zx print all output
$.verbose = true;

describe("Single Node EC2 E2E Test", () => {
  let cdkAppPath = "ec2-simple-stack.ts";
  let stackName = "e2e-RestateSingleNode";
  let retainStack = new Boolean(process.env["RETAIN_STACK"]).valueOf();
  let ingressUrl: string;

  beforeAll(async () => {
    // Deploy the stack
    try {
      cd(path.resolve(__dirname));
      await $`npx cdk --app 'npx tsx ${cdkAppPath}' deploy \
            --context stack_name="${stackName}" \
            --require-approval never \
            ${retainStack ? "--no-rollback" : ""}`.timeout("575s");

      const result =
        await $`aws cloudformation describe-stacks --stack-name "${stackName}" --query 'Stacks[0].Outputs'`;

      const stackOutputs = JSON.parse(result.stdout);
      ingressUrl = stackOutputs.find((output: any) => output.OutputKey === "RestateIngressUrl").OutputValue;

      // Wait for the service to be ready (you might want to add a proper health check here)
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    } catch (error) {
      console.error("Failed to deploy stack:", error);
      throw error;
    }
  }, 600_000);

  afterAll(async () => {
    // Clean up the stack
    if (retainStack) {
      console.log(`Retaining stack "${stackName}"`);
    } else {
      try {
        // await $`npx cdk --app 'npx tsx ${cdkAppPath}' destroy --context stack_name=${stackName} --force`.timeout("595s");
        console.log(`Asynchronously deleting stack "${stackName}"...`);
        await $`aws cloudformation delete-stack --stack-name "${stackName}"`;
      } catch (error) {
        console.error("Failed to destroy stack:", error);
        throw error;
      }
    }
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
