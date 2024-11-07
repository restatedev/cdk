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
import * as logs from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elb2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elb2_targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as r53 from "aws-cdk-lib/aws-route53";
import * as r53_targets from "aws-cdk-lib/aws-route53-targets";
import "source-map-support/register";

import { ServiceDeployer, SingleNodeRestateDeployment } from "../../lib/restate-constructs";

// Deploy with: npx cdk --app 'npx tsx single-node-ec2-alb.e2e.ts' deploy --context vpc_id=... --context domainName=... --context hostname=...
const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateSingleNodeAlb", {
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
    subnetType: ec2.SubnetType.PUBLIC,
  },
  logGroup: new logs.LogGroup(stack, "ServerLogs", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  entry: "../../dist/register-service-handler/index.js", // only needed for in-tree tests
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  // An alternative to deploying via the LB is to put the deployer itself in the VPC:
  // vpc: environment.vpc,
  // allowPublicSubnet: true,
  // securityGroups: [environment.adminSecurityGroup],
});

const alb = new elb2.ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: true,
  securityGroup: environment.ingressSecurityGroup,
});
alb.addSecurityGroup(environment.adminSecurityGroup);

const hostedZone = r53.HostedZone.fromLookup(stack, "HostedZone", {
  domainName: app.node.getContext("domainName"),
});
const hostname = app.node.getContext("hostname");

const dnsRecord = new r53.ARecord(stack, "AlbAlias", {
  zone: hostedZone,
  recordName: hostname,
  target: r53.RecordTarget.fromAlias(new r53_targets.LoadBalancerTarget(alb)),
});

const publicApiCertificate = new acm.Certificate(stack, "Certificate", {
  domainName: dnsRecord.domainName,
  validation: acm.CertificateValidation.fromDns(hostedZone),
});

const ingressListener = alb.addListener("IngressListener", {
  port: 443,
  protocol: elb2.ApplicationProtocol.HTTPS,
  certificates: [publicApiCertificate],
  open: true,
});

ingressListener.addTargets("IngressTarget", {
  targets: [new elb2_targets.InstanceTarget(environment.instance)],
  protocol: elb2.ApplicationProtocol.HTTP,
  port: 8080,
  healthCheck: {
    path: "/grpc.health.v1.Health/Check",
    interval: cdk.Duration.seconds(5),
    healthyThresholdCount: 3,
    unhealthyThresholdCount: 3,
    timeout: cdk.Duration.seconds(2),
  },
  deregistrationDelay: cdk.Duration.seconds(30),
});

// Danger! In this example, we deliberately expose the admin port to the world via the LB - this also allows us to
// demonstrate overriding the admin URL when deploying services below. A better option would be to put the service
// deployer in the VPC and add it to the Restate admin security group. Alternatively, secure access to the VPC.
const adminListener = alb.addListener("AdminListener", {
  port: 9070,
  protocol: elb2.ApplicationProtocol.HTTPS,
  certificates: [publicApiCertificate],
  open: true,
});

adminListener.addTargets("AdminTarget", {
  targets: [new elb2_targets.InstanceTarget(environment.instance)],
  protocol: elb2.ApplicationProtocol.HTTP,
  port: 9070,
  healthCheck: {
    path: "/health",
    interval: cdk.Duration.seconds(5),
    healthyThresholdCount: 3,
    unhealthyThresholdCount: 3,
    timeout: cdk.Duration.seconds(2),
  },
  deregistrationDelay: cdk.Duration.seconds(30),
});

deployer.deployService("Greeter", handler.currentVersion, environment, {
  adminUrl: `https://${dnsRecord.domainName}:9070`,
  insecure: true, // needed to accept self-signed certificate if we enable on-host TLS termination
});

new cdk.CfnOutput(stack, "RestateInstanceId", { value: environment.instance.instanceId });
new cdk.CfnOutput(stack, "RestateIngressUrl", { value: `https://${dnsRecord.domainName}` });
new cdk.CfnOutput(stack, "RestateAdminUrl", { value: `https://${dnsRecord.domainName}:9070` });

app.synth();
