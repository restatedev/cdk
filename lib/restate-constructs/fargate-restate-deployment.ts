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
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elb2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as r53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { IRestateEnvironment } from "./restate-environment";
import { TracingMode } from "./deployments-common";

const PUBLIC_INGRESS_PORT = 443;
const PUBLIC_ADMIN_PORT = 9070;
const RESTATE_INGRESS_PORT = 8080;
const RESTATE_ADMIN_PORT = 9070;
const RESTATE_IMAGE_DEFAULT = "docker.io/restatedev/restate";
const RESTATE_DOCKER_DEFAULT_TAG = "latest";
const ADOT_DOCKER_DEFAULT_TAG = "latest";

export interface RestateFargateProps {
  /** The VPC in which to launch the Restate host. */
  vpc?: ec2.IVpc;

  /** Log group for Restate service logs. */
  logGroup?: logs.LogGroup;

  /** Tracing mode for Restate services. Defaults to {@link TracingMode.DISABLED}. */
  tracing?: TracingMode;

  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** ECS cluster name. */
  clusterName?: string;

  /** Restate Docker image name. Defaults to `latest`. */
  restateImage?: string;

  /** Restate Docker image tag. Defaults to `latest`. */
  restateTag?: string;

  /** Amazon Distro for Open Telemetry Docker image tag. Defaults to `latest`. */
  adotTag?: string;

  /**
   * Environment for Restate container. Use it to configure logging and other process-level settings.
   */
  environment?: Record<string, string>;

  /**
   * Restate container extra arguments.
   */
  command?: string[];

  /**
   * The full name for the public endpoint.
   */
  dnsName: string;

  /**
   * DNS zone in which to create the public endpoint.
   */
  hostedZone: r53.IHostedZone;

  /**
   * Removal policy for long-lived resources (storage, logs). Default: `cdk.RemovalPolicy.DESTROY`.
   */
  removalPolicy?: cdk.RemovalPolicy;

  /**
   * Load balancer configuration.
   */
  loadBalancer?: {
    /** @see BaseLoadBalancerProps.internetFacing */
    internetFacing?: boolean;

    /**
     * If you set this to false, you can customize the access to the pair of ALB listeners via
     * {@link FargateRestateDeployment.ingressListener} and {@link FargateRestateDeployment.adminListener}.
     *
     * @see BaseApplicationListenerProps.open */
    open?: boolean;
  };
}

/**
 * Creates a Restate service deployment running as a Fargate task and backed by EFS.
 *
 * Please note that this construct is still experimental! Use with caution.
 */
export class FargateRestateDeployment extends Construct implements IRestateEnvironment {
  readonly invokerRole: iam.IRole;
  readonly vpc: ec2.IVpc;

  readonly ingressUrl: string;
  readonly adminUrl: string;
  readonly securityGroup: ec2.SecurityGroup;
  readonly dataStore: efs.FileSystem;
  readonly ingressListener: elb2.ApplicationListener;
  readonly adminListener: elb2.ApplicationListener;

  constructor(scope: Construct, id: string, props: RestateFargateProps) {
    super(scope, id);

    this.vpc = props.vpc ?? ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });

    const restateImage = props.restateImage ?? RESTATE_IMAGE_DEFAULT;
    const restateTag = props.restateTag ?? RESTATE_DOCKER_DEFAULT_TAG;
    const adotTag = props.adotTag ?? ADOT_DOCKER_DEFAULT_TAG; // TODO: add X-Ray support like we have for EC2

    const fs = new efs.FileSystem(this, "DataStore", {
      vpc: this.vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });
    fs.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowEfsMount",
        actions: ["elasticfilesystem:ClientMount"],
        // Restricting to the ECS execution role does not work; probably doesn't matter - EFS access is secured by a security group
        principals: [new iam.AnyPrincipal()],
        conditions: {
          Bool: {
            "elasticfilesystem:AccessedViaMountTarget": "true",
          },
        },
      }),
    );
    this.dataStore = fs;

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: this.vpc,
      clusterName: props.clusterName,
    });

    const restateTask = new ecs.FargateTaskDefinition(this, "RestateTask", {
      cpu: 4096,
      memoryLimitMiB: 8192,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      volumes: [
        {
          name: "restateStore",
          efsVolumeConfiguration: {
            fileSystemId: fs.fileSystemId,
            authorizationConfig: {},
          },
        },
      ],
    });

    // TODO: Start an ADOT container and hook it up to Restate and AWS X-Ray or another OTel sink
    // if (props.tracing === TracingMode.AWS_XRAY) {
    //   restateTask.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"));
    // }

    new iam.Policy(this, "TaskPolicy", {
      statements: [
        new iam.PolicyStatement({
          sid: "AllowAssumeAnyRole",
          actions: ["sts:AssumeRole"],
          resources: ["*"], // we don't know upfront what invoker roles we may be asked to assume at runtime
        }),
      ],
    }).attachToRole(restateTask.taskRole);

    const invokerRole = new iam.Role(this, "InvokerRole", {
      assumedBy: new iam.ArnPrincipal(restateTask.taskRole.roleArn),
      description: "Assumed by Restate deployment to invoke Lambda-based services",
    });
    invokerRole.grantAssumeRole(restateTask.taskRole);
    this.invokerRole = invokerRole;

    const logGroup =
      props.logGroup ??
      new logs.LogGroup(this, "Logs", {
        logGroupName: `/restate/${id}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
      });

    const restate = restateTask.addContainer("Restate", {
      containerName: "restate-runtime",
      image: ecs.ContainerImage.fromRegistry(`${restateImage}:${restateTag}`),
      portMappings: [{ containerPort: RESTATE_INGRESS_PORT }, { containerPort: RESTATE_ADMIN_PORT }],
      logging: ecs.LogDriver.awsLogs({
        logGroup,
        streamPrefix: "restate",
      }),
      environment: {
        RESTATE_LOG_FORMAT: "json",
        RESTATE_NODE_NAME: "fargate",
      },
      command: props.command,
      startTimeout: cdk.Duration.seconds(20),
      stopTimeout: cdk.Duration.seconds(20),
    });
    restate.addMountPoints({
      containerPath: "/restate-data",
      readOnly: false,
      sourceVolume: "restateStore",
    });

    const restateSecurityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    this.securityGroup = restateSecurityGroup;

    const restateFargateService = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: restateTask,
      assignPublicIp: true,
      circuitBreaker: {
        enable: true,
        rollback: true,
      },
      minHealthyPercent: 0, // allow scale down to zero during deployments (required for at-most-1 max setting)
      maxHealthyPercent: 100, // don't start more than one copy
      securityGroups: [restateSecurityGroup],
    });

    fs.connections.allowDefaultPortFrom(restateSecurityGroup);
    fs.connections.allowDefaultPortTo(restateSecurityGroup);
    fs.grantRootAccess(restateFargateService.taskDefinition.taskRole.grantPrincipal);

    const alb = new elb2.ApplicationLoadBalancer(this, "Alb", {
      vpc: this.vpc,
      internetFacing: props.loadBalancer?.internetFacing,
    });

    const publicApiCertificate = new acm.Certificate(this, "Certificate", {
      domainName: props.dnsName,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    const ingressListener = alb.addListener("IngressListener", {
      port: PUBLIC_INGRESS_PORT,
      protocol: elb2.ApplicationProtocol.HTTPS,
      certificates: [publicApiCertificate],
      open: props.loadBalancer?.open,
    });
    ingressListener.addTargets("FargateIngressTarget", {
      targets: [
        restateFargateService.loadBalancerTarget({
          containerName: restate.containerName,
          containerPort: RESTATE_INGRESS_PORT,
        }),
      ],
      port: RESTATE_INGRESS_PORT,
      protocol: elb2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: "/restate/health",
        interval: cdk.Duration.seconds(5),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(2),
      },
      deregistrationDelay: cdk.Duration.seconds(5),
    });
    this.ingressListener = ingressListener;

    const adminListener = alb.addListener("AdminListener", {
      port: PUBLIC_ADMIN_PORT,
      protocol: elb2.ApplicationProtocol.HTTPS,
      certificates: [publicApiCertificate],
    });
    adminListener.addTargets("FargateAdminTarget", {
      targets: [
        restateFargateService.loadBalancerTarget({
          containerName: restate.containerName,
          containerPort: RESTATE_ADMIN_PORT,
        }),
      ],
      port: RESTATE_ADMIN_PORT,
      protocol: elb2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(5),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(2),
      },
      deregistrationDelay: cdk.Duration.seconds(5),
    });
    this.adminListener = adminListener;

    new r53.ARecord(this, "AlbAlias", {
      zone: props.hostedZone,
      recordName: props.dnsName.split(".")[0],
      target: r53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
      // other ARecord configuration...
    });

    this.ingressUrl = `https://${props.dnsName}${PUBLIC_INGRESS_PORT == 443 ? "" : `:${PUBLIC_INGRESS_PORT}`}`;
    this.adminUrl = `https://${props.dnsName}:${PUBLIC_ADMIN_PORT}`;
  }
}
