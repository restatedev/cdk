import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { RestateEnvironment, ServiceDeployer, SingleNodeRestateDeployment } from "../../lib/restate-constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";

const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateServerEC2", {
  env: { account: app.node.getContext("account"), region: app.node.getContext("region") },
});

const handler: lambda.Function = new lambda.Function(stack, "Service", {
  runtime: lambda.Runtime.NODEJS_LATEST,
  code: lambda.Code.fromAsset("bundle.js"),
  handler: "handler",
});

const environment = new SingleNodeRestateDeployment(stack, "Restate", {
  logGroup: new logs.LogGroup(stack, "RestateLogs", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
});

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  logGroup: new logs.LogGroup(stack, "Deployer", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
  // vpc,
  // vpcSubnets,
});

deployer.deployService("Greeter", handler.currentVersion, environment, {
  private: false,
  insecure: true, // self-signed certificate
  skipInvokeFunctionGrant: true,
});

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });

app.synth();
