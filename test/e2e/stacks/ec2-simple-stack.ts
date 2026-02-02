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

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import path from "node:path";

import { ServiceDeployer, SingleNodeRestateDeployment } from "../../../lib/restate-constructs";

// Deploy with: npx cdk --app 'npx tsx ec2-simple-stack.ts' deploy --context vpc_id=...
const app = new cdk.App();
const stackName = app.node.tryGetContext("stack_name") ?? "e2e-RestateSingleNode";
const stack = new cdk.Stack(app, stackName);

const handler: lambda.Function = new lambda.Function(stack, "Service", {
  runtime: lambda.Runtime.NODEJS_22_X,
  code: lambda.Code.fromAsset(path.join(__dirname, "../../handlers/dist/")),
  handler: "bundle.handler",
});

const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 1 });

const environment = new SingleNodeRestateDeployment(stack, "Restate", {
  restateImage: "ghcr.io/restatedev/restate:main",
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
environment.instance.connections.allowFrom(ec2.Peer.anyIpv4(), ec2.Port.tcp(22));

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  vpc: environment.vpc,
  securityGroups: [environment.adminSecurityGroup], // the admin SG can access the admin port 9070
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  code: lambda.Code.fromAsset(path.join(__dirname, "../../../dist/register-service-handler")),
});

deployer.register(handler.latestVersion, environment, {
  // insecure: true, // accept self-signed cert
});

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });
new cdk.CfnOutput(stack, "RestateAdminUrl", { value: environment.adminUrl });
new cdk.CfnOutput(stack, "RestateInstanceId", { value: environment.instance.instanceId });

app.synth();
