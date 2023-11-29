/*
 * Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elb_v2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ApplicationProtocol } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { InstanceTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
import path from "node:path";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

const RESTATE_INGRESS_PORT = 8080;
const RESTATE_META_PORT = 9070;
const RESTATE_DOCKER_DEFAULT_TAG = "latest";
const ADOT_DOCKER_DEFAULT_TAG = "latest";

/**
 * Represents an instance of the Restate service. This could represent a self-hosted broker, or Restate's managed
 * service.
 */
export interface RestateInstance {
  readonly invokerRole: iam.Role;
  readonly metaEndpoint: string;
  readonly registrationProviderToken: cdk.CfnOutput;
}

export enum TracingMode {
  DISABLED = "DISABLED",
  AWS_XRAY = "AWS_XRAY",
}

export interface RestateInstanceProps {
  /** Log group for Restate service logs. */
  logGroup: logs.LogGroup;

  /** Tracing mode for Restate services. Disabled by default. */
  tracing?: TracingMode;

  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** Restate Docker image tag. Defaults to `latest`. */
  restateTag?: string;

  /** Amazon Distro for Open Telemetry Docker image tag. Defaults to `latest`. */
  adotTag?: string;

  /** Optional certificate for ingress endpoint. If unspecified, a plain HTTP listener will be created. */
  certificate?: acm.ICertificate;
}

/**
 * Creates a Restate service deployment backed by a single EC2 instance,
 * suitable for development and testing purposes.
 */
export class SingleNodeRestateInstance extends Construct implements RestateInstance {
  readonly instance: ec2.Instance;
  readonly invokerRole: iam.Role;
  readonly vpc: ec2.Vpc;

  readonly publicIngressEndpoint: string;
  readonly privateIngressEndpoint: string;
  readonly metaEndpoint: string;
  readonly registrationProvider: cr.Provider;
  readonly registrationProviderToken: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: RestateInstanceProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "RestateVpc", {
      maxAzs: 3,
    });

    this.invokerRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    props.logGroup.grantWrite(this.invokerRole);

    const restateTag = props.restateTag ?? RESTATE_DOCKER_DEFAULT_TAG;
    const adotTag = props.adotTag ?? ADOT_DOCKER_DEFAULT_TAG;
    const restateInitCommands = ec2.UserData.forLinux();
    restateInitCommands.addCommands(
      "yum update -y",
      "yum install -y docker",
      "systemctl enable docker.service",
      "systemctl start docker.service",
      [
        "docker run --name adot --restart unless-stopped --detach",
        " -p 4317:4317 -p 55680:55680 -p 8889:8888",
        ` public.ecr.aws/aws-observability/aws-otel-collector:${adotTag}`,
      ].join(""),
      [
        "docker run --name restate --restart unless-stopped --detach",
        " --volume /var/restate:/target --network=host",
        " -e RESTATE_OBSERVABILITY__LOG__FORMAT=Json -e RUST_LOG=info,restate_worker::partition=warn",
        " -e RESTATE_OBSERVABILITY__TRACING__ENDPOINT=http://localhost:4317",
        ` --log-driver=awslogs --log-opt awslogs-group=${props.logGroup.logGroupName}`,
        ` docker.io/restatedev/restate:${restateTag}`,
      ].join(""),
    );

    const restateInstance = new ec2.Instance(this, "Host", {
      vpc: this.vpc,
      instanceType: new ec2.InstanceType("t4g.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: this.invokerRole,
      userData: restateInitCommands,
    });
    this.instance = restateInstance;

    // We start the ADOT collector regardless, and only control whether they will be published to X-Ray via instance
    // role permissions. This way historic traces will be buffered on the host, even if tracing is disabled initially.
    if (props.tracing === TracingMode.AWS_XRAY) {
      restateInstance.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"));
    }

    const restateInstanceSecurityGroup = new ec2.SecurityGroup(this, "RestateSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: "RestateSecurityGroup",
      description: "Allow inbound traffic to Restate",
    });

    const ingressLoadBalancer = new elb_v2.ApplicationLoadBalancer(this, "RestateAlb", {
      vpc: this.vpc,
      internetFacing: true,
    });
    const targetGroup = new elb_v2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: this.vpc,
      protocol: elb_v2.ApplicationProtocol.HTTP,
      port: RESTATE_INGRESS_PORT,
      targets: [new InstanceTarget(restateInstance)],
      healthCheck: {
        protocol: elb_v2.Protocol.HTTP,
        path: "/grpc.health.v1.Health/Check",
        interval: cdk.Duration.seconds(60),
      },
    });
    ingressLoadBalancer.addListener("Listener", {
      port: props.certificate ? 443 : 80,
      protocol: props.certificate ? ApplicationProtocol.HTTPS : ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
      certificates: props.certificate ? [elb_v2.ListenerCertificate.fromCertificateManager(props.certificate)] : [],
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "ALB security group",
      allowAllOutbound: false,
    });
    albSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(RESTATE_INGRESS_PORT), "Allow outbound HTTP traffic to Restate ingress");
    ingressLoadBalancer.addSecurityGroup(albSecurityGroup);

    restateInstanceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(RESTATE_INGRESS_PORT), "Allow traffic from ALB to Restate ingress");

    // These rules allow the service registration component to trigger service discovery as needed; the requests
    // originate from a VPC-bound Lambda function that backs the custom resource.
    this.vpc.privateSubnets.forEach((subnet) => {
      restateInstanceSecurityGroup.addIngressRule(ec2.Peer.ipv4(subnet.ipv4CidrBlock), ec2.Port.tcp(RESTATE_META_PORT), "Allow traffic from the VPC to Restate meta");
    });
    this.vpc.privateSubnets.forEach((subnet) => {
      restateInstanceSecurityGroup.addIngressRule(ec2.Peer.ipv4(subnet.ipv4CidrBlock), ec2.Port.tcp(RESTATE_INGRESS_PORT), "Allow traffic from the VPC to Restate ingress");
    });
    restateInstance.addSecurityGroup(restateInstanceSecurityGroup);

    const registrationProvider = this.createRegistrationProvider();
    this.registrationProvider = registrationProvider;
    this.registrationProviderToken = new cdk.CfnOutput(this, "RegistrationProviderToken", {
      description: "Custom resource provider service token, needed by the Restate service registry component to trigger discovery",
      exportName: [props.prefix, "RegistrationProviderToken"].join("-"),
      value: registrationProvider.serviceToken,
    });

    this.publicIngressEndpoint = `${props.certificate ? "https" : "http"}://${ingressLoadBalancer.loadBalancerDnsName}`;
    this.privateIngressEndpoint = `http://${this.instance.instancePrivateDnsName}:${RESTATE_INGRESS_PORT}`;
    this.metaEndpoint = `http://${this.instance.instancePrivateDnsName}:${RESTATE_META_PORT}`;
  }

  /**
   * Creates a custom resource provider to facilitate service discovery. Note that the custom resource event handler
   * must be able to reach the Restate instance's meta endpoint - which is why it is deployed within the same VPC.
   */
  private createRegistrationProvider() {
    const registrationHandler = new lambda_node.NodejsFunction(this, "RegistrationHandler", {
      description: "Restate custom registration handler",
      entry: path.join(__dirname, "register-service-handler/index.js"),
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 128,
      timeout: cdk.Duration.seconds(60),
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
      vpc: this.vpc,
      vpcSubnets: {
        subnets: this.vpc.privateSubnets,
      },
    });

    return new cr.Provider(this, "RegistrationProvider", {
      onEventHandler: registrationHandler,
    });
  }
}