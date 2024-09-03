import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import "source-map-support/register";

import { ServiceDeployer, SingleNodeRestateDeployment } from "../../lib/restate-constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

// Deploy with: npx cdk --app 'npx tsx single-node-ec2.e2e.ts' deploy --context vpc_id=...
const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateSingleNodeEc2Lite", {
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

const vpc = ec2.Vpc.fromLookup(stack, "Vpc", { vpcId: app.node.getContext("vpc_id") });

const environment = new SingleNodeRestateDeployment(stack, "Restate", {
  vpc,
  networkConfiguration: {
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
  },
  logGroup: new logs.LogGroup(stack, "ServerLogs", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  vpc: environment.vpc,
  securityGroups: [environment.adminSecurityGroup],
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  entry: "../../dist/register-service-handler/index.js", // only for tests
});

deployer.deployService("Greeter", handler.currentVersion, environment, {
  configurationVersion: new Date().toISOString(),
});

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });
new cdk.CfnOutput(stack, "RestateInstanceId", { value: environment.instance.instanceId });

app.synth();
