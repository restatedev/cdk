import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import "source-map-support/register";

import { ServiceDeployer, SingleNodeRestateDeployment } from "../../lib/restate-constructs";

// Deploy with: npx cdk --app 'npx tsx single-node-ec2.e2e.ts' deploy
const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateSingleNodeEc2", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const handler: lambda.Function = new lambda.Function(stack, "Service", {
  runtime: lambda.Runtime.NODEJS_LATEST,
  code: lambda.Code.fromAsset("../handlers/dist/"),
  handler: "bundle.handler",
});

const environment = new SingleNodeRestateDeployment(stack, "Restate", {
  logGroup: new logs.LogGroup(stack, "ServerLogs", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
});

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  entry: "../../dist/register-service-handler/index.js", // only for tests
});

deployer.deployService("Greeter", handler.currentVersion, environment, {
  insecure: true, // accept self-signed certificate from server
});

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });

app.synth();
