import * as cdk from "aws-cdk-lib";
import {
  FargateRestateDeployment,
  RestateEnvironment,
  ServiceDeployer,
  SingleNodeRestateDeployment,
} from "../lib/restate-constructs";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import "jest-cdk-snapshot";

describe("Restate constructs", () => {
  test("Deploy a Lambda service handler to a remote Restate environment", () => {
    const app = new cdk.App();
    const stack = new LambdaServiceDeployment(app, "LambdaServiceDeployment", {});

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Create a self-hosted Restate environment deployed on ECS Fargate", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "RestateOnFargateStack", {
      env: { account: "account-id", region: "region" },
    });

    new FargateRestateDeployment(stack, "Restate", {
      hostedZone: new route53.HostedZone(stack, "Zone", { zoneName: "example.com" }),
      dnsName: "restate.example.com",
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Create a self-hosted Restate environment deployed on EC2", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "RestateOnFargateStack", {
      env: { account: "account-id", region: "region" },
    });

    new SingleNodeRestateDeployment(stack, "Restate", {});

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });
});

class LambdaServiceDeployment extends cdk.Stack {
  constructor(scope: Construct, id: string, props: {} & cdk.StackProps) {
    super(scope, id, props);

    const invokerRole = new iam.Role(this, "InvokerRole", { assumedBy: new iam.AccountRootPrincipal() });

    const authToken = new secretsmanager.Secret(this, "RestateApiKey", {
      secretStringValue: cdk.SecretValue.unsafePlainText("api-key"),
    });

    const restateEnvironment = RestateEnvironment.fromAttributes({
      invokerRole,
      adminUrl: "https://restate.example.com:9070",
      authToken,
    });

    const handler: lambda.Function = new lambda.Function(this, "RestateServiceHandler", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromInline("{ ... }"),
    });
    handler.grantInvoke(invokerRole);

    const serviceDeployer = new ServiceDeployer(this, "ServiceDeployer", {
      // only needed in testing, where the relative path of the registration function is different from how customers would use it
      entry: "dist/register-service-handler/index.js",
    });
    serviceDeployer.deployService("Service", handler.currentVersion, restateEnvironment);
  }
}
