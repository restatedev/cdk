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

deployer.deployService("Greeter", handler.currentVersion, environment);

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: environment.ingressUrl });
new cdk.CfnOutput(stack, "RestateInstanceId", { value: environment.instance.instanceId });

const alb = new elb2.ApplicationLoadBalancer(stack, "Alb", {
  vpc,
  internetFacing: true,
  securityGroup: environment.ingressSecurityGroup,
});

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

new cdk.CfnOutput(stack, "PublicIngressUrl", { value: `https://${dnsRecord.domainName}` });

app.synth();
