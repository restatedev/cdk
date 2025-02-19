/*
 * Copyright (c) 2023-2025 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/cdk/blob/main/LICENSE
 */

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { ServiceDeployer, SingleNodeRestateDeployment } from "../../lib/restate-constructs";

// Deploy with: npx cdk --app 'npx tsx ec2-simple-stack.ts' deploy --context vpc_id=...
const app = new cdk.App();
const stackName = app.node.tryGetContext("stack_name") ?? "e2e-RestateSingleNode";
const stack = new cdk.Stack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const handler: lambda.Function = new lambda.Function(stack, "Service", {
  runtime: lambda.Runtime.NODEJS_22_X,
  code: lambda.Code.fromAsset("../handlers/dist/"),
  handler: "bundle.handler",
});

const vpcId = app.node.tryGetContext("vpc_id");
const vpc = ec2.Vpc.fromLookup(stack, "Vpc", vpcId ? { vpcId } : { isDefault: true });

const environment = new SingleNodeRestateDeployment(stack, "Restate", {
  publicIngress: true,
  vpc,
  networkConfiguration: {
    subnetType: ec2.SubnetType.PUBLIC,
  },
  logGroup: new logs.LogGroup(stack, "ServerLogs", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  // tlsTermination: TlsTermination.ON_HOST_SELF_SIGNED_CERTIFICATE,
});

// Setting publicIngress=true is equivalent to:
// environment.ingressSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(environment.ingressPort));

// Safer option: add the deployer to the VPC + security group
const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  vpc: environment.vpc,
  allowPublicSubnet: true, // necessary to deploy to a public VPC subnet - no internet access but we don't need it
  securityGroups: [environment.adminSecurityGroup], // the admin SG can access the admin port 9070
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  entry: "../../dist/register-service-handler/index.js", // only needed for in-tree tests
});

// Alternative, more dangerous option: anyone can control the service over the internet, not just hit the ingress port
// const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
//   removalPolicy: cdk.RemovalPolicy.DESTROY,
//   entry: "../../dist/register-service-handler/index.js", // only needed for in-tree tests
// });
// environment.adminSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(environment.adminPort));

deployer.register(handler.latestVersion, environment, {
  private: false,
  // insecure: true, // accept self-signed cert
});

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });
new cdk.CfnOutput(stack, "RestateAdminUrl", { value: environment.adminUrl });
new cdk.CfnOutput(stack, "RestateInstanceId", { value: environment.instance.instanceId });

app.synth();
