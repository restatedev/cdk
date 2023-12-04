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
import * as cdk from "aws-cdk-lib";
import { RestateInstance } from "./restate-instance";
import { RegistrationProvider } from "./registration-provider";

const RESTATE_INGRESS_PORT = 8080;
const RESTATE_META_PORT = 9070;
const RESTATE_DOCKER_DEFAULT_TAG = "latest";
const ADOT_DOCKER_DEFAULT_TAG = "latest";

export enum TracingMode {
  DISABLED = "DISABLED",
  AWS_XRAY = "AWS_XRAY",
}

export interface RestateInstanceProps {
  /** Log group for Restate service logs. */
  logGroup: logs.LogGroup;

  /** Tracing mode for Restate services. Defaults to {@link TracingMode.DISABLED}. */
  tracing?: TracingMode;

  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** Restate Docker image tag. Defaults to `latest`. */
  restateTag?: string;

  /** Amazon Distro for Open Telemetry Docker image tag. Defaults to `latest`. */
  adotTag?: string;
}

/**
 * Creates a Restate service deployment backed by a single EC2 instance,
 * suitable for development and testing purposes. The instance will be created
 * in a dedicated VPC (unless one is provided). EC2 instance will be allocated
 * a public IP address.
 */
export class SingleNodeRestateInstance extends Construct implements RestateInstance {
  readonly instance: ec2.Instance;
  readonly invokerRole: iam.IRole;
  readonly vpc: ec2.Vpc;

  readonly ingressEndpoint: string;
  readonly metaEndpoint: string;
  readonly registrationProviderToken: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: RestateInstanceProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 3,
      createInternetGateway: true,
      natGateways: 0,
    });

    this.invokerRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
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
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
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
      description: "Restate service ACLs",
    });
    restateInstance.addSecurityGroup(restateInstanceSecurityGroup);

    restateInstanceSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(RESTATE_INGRESS_PORT),
      "Allow traffic from anywhere to Restate ingress",
    );
    restateInstanceSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(RESTATE_META_PORT),
      "Allow traffic from anywhere to Restate meta",
    );

    const registrationProvider = new RegistrationProvider(this, "RegistrationProvider", {});
    this.registrationProviderToken = new cdk.CfnOutput(this, "RegistrationProviderToken", {
      description:
        "Custom resource provider service token, needed by the Restate service registry component to trigger discovery",
      exportName: [props.prefix, "RegistrationProviderToken"].join("-"),
      value: registrationProvider.serviceToken,
    });

    this.ingressEndpoint = `http://${restateInstance.instancePublicDnsName}:${RESTATE_INGRESS_PORT}`;
    this.metaEndpoint = `http://${restateInstance.instancePublicDnsName}:${RESTATE_META_PORT}`;
  }
}
