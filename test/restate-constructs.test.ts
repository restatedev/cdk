import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import "jest-cdk-snapshot";
import {
  RestateCloudEnvironment,
  RestateEnvironment,
  ServiceDeployer,
  SingleNodeRestateDeployment,
  TlsTermination,
} from "../lib/restate-constructs";
import { FargateRestateDeployment } from "../lib/restate-constructs/fargate-restate-deployment";

describe("Restate constructs", () => {
  test("Deploy a Lambda service handler to Restate Cloud environment", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "RestateCloudStack", {
      env: { account: "account-id", region: "region" },
    });

    const cloudEnvironment = new RestateCloudEnvironment(stack, "Restate", {
      environmentId: "env_test",
      apiKey: secrets.Secret.fromSecretNameV2(stack, "CloudApiKey", "secret_name"),
    });

    const handler: lambda.Function = new lambda.Function(stack, "RestateServiceHandler", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromInline("{ ... }"),
    });

    const serviceDeployer = new ServiceDeployer(stack, "ServiceDeployer", {
      // only needed in testing, where the relative path of the registration function is different from how customers would use it
      entry: "dist/register-service-handler/index.js",
    });
    serviceDeployer.register(handler.currentVersion, cloudEnvironment);

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Deploy a Lambda service handler to existing Restate environment", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "LambdaServiceDeployment", {});

    const invokerRole = new iam.Role(stack, "InvokerRole", { assumedBy: new iam.AccountRootPrincipal() });

    const authToken = new secrets.Secret(stack, "RestateApiKey", {
      secretStringValue: cdk.SecretValue.unsafePlainText("api-key-raw"),
    });

    const restateEnvironment = RestateEnvironment.fromAttributes({
      invokerRole,
      adminUrl: "https://restate.example.com:9070",
      authToken,
    });

    const handler: lambda.Function = new lambda.Function(stack, "RestateServiceHandler", {
      runtime: lambda.Runtime.NODEJS_LATEST,
      handler: "index.handler",
      code: lambda.Code.fromInline("{ ... }"),
    });
    handler.grantInvoke(invokerRole);

    const serviceDeployer = new ServiceDeployer(stack, "ServiceDeployer", {
      // only needed in testing, where the relative path of the registration function is different from how customers would use it
      entry: "dist/register-service-handler/index.js",
    });
    serviceDeployer.register(handler.currentVersion, restateEnvironment);

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Create a self-hosted Restate environment deployed on EC2", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "RestateSelfHostedServerEc2Stack", {
      env: { account: "account-id", region: "region" },
    });

    new SingleNodeRestateDeployment(stack, "Restate", {
      vpc: ec2.Vpc.fromLookup(stack, "Vpc", { isDefault: true }),
      restateTag: "custom-version",
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("Create a self-hosted Restate environment deployed on EC2 (TLS termination)", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "RestateSelfHostedServerEc2Stack", {
      env: { account: "account-id", region: "region" },
    });

    new SingleNodeRestateDeployment(stack, "Restate", {
      tlsTermination: TlsTermination.ON_HOST_SELF_SIGNED_CERTIFICATE,
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });

  test("[Experimental] Create a self-hosted Restate environment deployed on ECS Fargate", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "RestateOnFargateStack", {
      env: { account: "account-id", region: "region" },
    });

    new FargateRestateDeployment(stack, "RestateContainer", {
      hostedZone: new route53.HostedZone(stack, "Zone", { zoneName: "example.com" }),
      dnsName: "restate.example.com",
    });

    expect(stack).toMatchCdkSnapshot({
      ignoreAssets: true,
      yaml: true,
    });
  });
});
