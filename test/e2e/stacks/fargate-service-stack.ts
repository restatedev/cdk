/*
 * Copyright (c) 2023-2025 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elb2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as r53 from "aws-cdk-lib/aws-route53";
import * as r53_targets from "aws-cdk-lib/aws-route53-targets";
import path from "path";

import { RestateFargateService, ServiceDeployer, SingleNodeRestateDeployment } from "../../../lib/restate-constructs";

// Deploy with: npx cdk --app 'npx tsx fargate-service-stack.ts' deploy --all -c domainName=... -c hostname=... [-c release=...] [-c vpc_id=...]
// Run `npm run build` and `npx tsx test/handlers/build.mts` first. Changing `release` creates a new version.
const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateFargateService", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const domainName = app.node.getContext("domainName");
const hostname = app.node.getContext("hostname");
const release = app.node.tryGetContext("release") ?? "1";
const fqdn = `${hostname}.${domainName}`;

// VPC endpoints live in their own stack, so that a rolled-back release of the service stack never removes them. That
// stack also owns the VPC, unless an existing one is reused because the account is short of VPCs (-c vpc_id=vpc-...).
const network = new cdk.Stack(app, "e2e-RestateFargateServiceNetwork", { env: stack.env });
stack.addDependency(network);
const vpcId = app.node.tryGetContext("vpc_id");
const vpc: ec2.IVpc = vpcId
  ? ec2.Vpc.fromLookup(stack, "Vpc", { vpcId })
  : new ec2.Vpc(network, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "Public", subnetType: ec2.SubnetType.PUBLIC }],
    });
const networkVpc = vpcId ? ec2.Vpc.fromLookup(network, "Vpc", { vpcId }) : vpc;
// The deployer Lambda has no internet access: it answers CloudFormation through S3, and manages superseded versions
// through the interface endpoints.
vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3 });
for (const [id, service] of Object.entries({
  Ecs: ec2.InterfaceVpcEndpointAwsService.ECS,
  Elb: ec2.InterfaceVpcEndpointAwsService.ELASTIC_LOAD_BALANCING,
  AutoScaling: ec2.InterfaceVpcEndpointAwsService.APPLICATION_AUTOSCALING,
  CloudFormation: ec2.InterfaceVpcEndpointAwsService.CLOUDFORMATION,
  CloudWatch: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
})) {
  new ec2.InterfaceVpcEndpoint(network, id, {
    vpc: networkVpc,
    service,
    subnets: { subnetType: ec2.SubnetType.PUBLIC },
  });
}

const restate = new SingleNodeRestateDeployment(stack, "Restate", {
  vpc,
  networkConfiguration: { subnetType: ec2.SubnetType.PUBLIC },
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  logGroup: new logs.LogGroup(stack, "ServerLogs", {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
});

const deployer = new ServiceDeployer(stack, "ServiceDeployer", {
  code: lambda.Code.fromAsset(path.join(__dirname, "../../../dist/register-service-handler")),
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
  allowPublicSubnet: true,
  securityGroups: [restate.adminSecurityGroup],
});

const hostedZone = r53.HostedZone.fromLookup(stack, "HostedZone", { domainName });
const certificate = new acm.Certificate(stack, "Certificate", {
  domainName: fqdn,
  validation: acm.CertificateValidation.fromDns(hostedZone),
});

const alb = new elb2.ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: false,
  vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
  idleTimeout: cdk.Duration.seconds(900),
});
alb.connections.allowFrom(restate.instance, ec2.Port.tcp(443));

const listener = alb.addListener("Https", {
  port: 443,
  protocol: elb2.ApplicationProtocol.HTTPS,
  certificates: [certificate],
  open: false,
  defaultAction: elb2.ListenerAction.fixedResponse(404),
});

new r53.ARecord(stack, "AlbAlias", {
  zone: hostedZone,
  recordName: hostname,
  target: r53.RecordTarget.fromAlias(new r53_targets.LoadBalancerTarget(alb)),
});

const cluster = new ecs.Cluster(stack, "Cluster", { vpc });

const taskDefinition = new ecs.FargateTaskDefinition(stack, "Task", {
  cpu: 256,
  memoryLimitMiB: 512,
  runtimePlatform: {
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
  },
});
taskDefinition.addContainer("app", {
  image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../handlers"), {
    file: "Dockerfile.fargate",
    platform: ecr_assets.Platform.LINUX_ARM64,
  }),
  portMappings: [{ containerPort: 9080 }],
  environment: { RELEASE: release },
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "spike",
    logGroup: new logs.LogGroup(stack, "AppLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  }),
});

// Failure injection for e2e tests (-c fail=...):
// - "before": a resource that fails a minute in, before the release registers the new version;
// - "release": registration itself fails, because the admin URL is unreachable.
const fail = app.node.tryGetContext("fail");
if (fail === "before") {
  const handle = new cdk.CfnWaitConditionHandle(stack, "PlantedFailureHandle");
  new cdk.CfnWaitCondition(stack, "PlantedFailure", { handle: handle.ref, timeout: "60" });
}

const spike = new RestateFargateService(stack, "Spike", {
  cluster,
  taskDefinition,
  listener,
  baseUrl: `https://${fqdn}`,
  pathPrefix: "spike",
  environment: restate,
  deployer,
  ...(fail === "release" ? { registration: { adminUrl: "http://192.0.2.1:9070", healthCheckRetryAttempts: 2 } } : {}),
  desiredCount: 2,
  vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
  assignPublicIp: true,
  enableExecuteCommand: true,
  // Short lifecycle timings so the test observes pruning within minutes.
  drainDelay: cdk.Duration.minutes(1),
  pruneSchedule: events.Schedule.rate(cdk.Duration.minutes(5)),
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

new cdk.CfnOutput(stack, "RestateInstanceId", { value: restate.instance.instanceId });
new cdk.CfnOutput(stack, "VersionId", { value: spike.currentVersion.versionId });
new cdk.CfnOutput(stack, "DeploymentUri", { value: spike.currentVersion.deploymentUri });
new cdk.CfnOutput(stack, "ClusterName", { value: cluster.clusterName });
new cdk.CfnOutput(stack, "ServiceName", { value: spike.currentVersion.service.serviceName });

app.synth();
