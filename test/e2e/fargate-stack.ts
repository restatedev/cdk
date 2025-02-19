/*
 * Copyright (c) 2024 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as r53 from "aws-cdk-lib/aws-route53";
import "source-map-support/register";

import { ServiceDeployer } from "../../lib/restate-constructs";
import { FargateRestateDeployment } from "../../lib/restate-constructs/fargate-restate-deployment";

// Deploy with: npx cdk --app 'npx tsx fargate.e2e.ts' --output cdk.fargate.out --context domainName=dev.restate.cloud --context name=fargate-e2e-test deploy
const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateEcsFargate", {
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

const hostedZone = r53.HostedZone.fromLookup(stack, "HostedZone", {
  domainName: app.node.getContext("domainName"),
});

const environment = new FargateRestateDeployment(stack, "Restate", {
  dnsName: `${app.node.getContext("name")}.${hostedZone.zoneName}`,
  hostedZone: hostedZone,
});

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  entry: "../../dist/register-service-handler/index.js", // only needed for in-tree tests
});

deployer.deployService("Greeter", handler.currentVersion, environment);

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });

app.synth();
