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
import { IRestateEnvironment } from "./restate-environment";
import { ServiceDeployer } from "./service-deployer";

const PUBLIC_INGRESS_PORT = 443;
const PUBLIC_ADMIN_PORT = 9073;
const RESTATE_INGRESS_PORT = 8080;
const RESTATE_ADMIN_PORT = 9070;
const RESTATE_IMAGE_DEFAULT = "docker.io/restatedev/restate";
const RESTATE_DOCKER_DEFAULT_TAG = "latest";
const ADOT_DOCKER_DEFAULT_TAG = "latest";

export enum TracingMode {
  DISABLED = "DISABLED",
  AWS_XRAY = "AWS_XRAY",
}

export interface RestateInstanceProps {
  /** The VPC in which to launch the Restate host. */
  vpc?: ec2.IVpc;

  /** Log group for Restate service logs. */
  logGroup: logs.LogGroup;

  /** Tracing mode for Restate services. Defaults to {@link TracingMode.DISABLED}. */
  tracing?: TracingMode;

  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** Restate Docker image name. Defaults to `latest`. */
  restateImage?: string;

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
export class SingleNodeRestateDeployment extends Construct implements IRestateEnvironment {
  readonly instance: ec2.Instance;
  readonly invokerRole: iam.IRole;
  readonly vpc: ec2.IVpc;

  readonly ingressUrl: string;
  readonly adminUrl: string;
  readonly serviceDeployer: ServiceDeployer;

  constructor(scope: Construct, id: string, props: RestateInstanceProps) {
    super(scope, id);

    this.vpc =
      props.vpc ??
      new ec2.Vpc(this, "Vpc", {
        maxAzs: 3,
        createInternetGateway: true,
        natGateways: 0,
      });

    this.invokerRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    props.logGroup.grantWrite(this.invokerRole);

    const restateImage = props.restateImage ?? RESTATE_IMAGE_DEFAULT;
    const restateTag = props.restateTag ?? RESTATE_DOCKER_DEFAULT_TAG;
    const adotTag = props.adotTag ?? ADOT_DOCKER_DEFAULT_TAG;
    const restateInitCommands = ec2.UserData.forLinux();
    restateInitCommands.addCommands(
      "yum update -y",
      "yum install -y docker nginx",

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
        ` ${restateImage}:${restateTag}`,
      ].join(""),

      "mkdir -p /etc/pki/private",
      [
        "openssl req -new -x509 -nodes -sha256 -days 365 -extensions v3_ca",
        " -subj '/C=DE/ST=Berlin/L=Berlin/O=restate.dev/OU=demo/CN=restate.example.com'",
        " -newkey rsa:2048 -keyout /etc/pki/private/restate-selfsigned.key -out /etc/pki/private/restate-selfsigned.crt",
      ].join(""),
      ["cat << EOF > /etc/nginx/conf.d/restate-ingress.conf", NGINX_REVERSE_PROXY_CONFIG, "EOF"].join("\n"),
      "systemctl enable nginx",
      "systemctl start nginx",
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
      ec2.Port.tcp(443),
      "Allow traffic from anywhere to Restate ingress port",
    );
    restateInstanceSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(9073),
      "Allow traffic from anywhere to Restate admin port",
    );

    this.serviceDeployer = new ServiceDeployer(this, "RegistrationProvider", {});

    this.ingressUrl = `https://${restateInstance.instancePublicDnsName}${
      PUBLIC_INGRESS_PORT == 443 ? "" : `:${PUBLIC_INGRESS_PORT}`
    }`;
    this.adminUrl = `https://${restateInstance.instancePublicDnsName}:${PUBLIC_ADMIN_PORT}`;
  }
}

const NGINX_REVERSE_PROXY_CONFIG = [
  "server {",
  "  listen 443 ssl http2;",
  "  listen [::]:443 ssl http2;",
  "  server_name _;",
  "  root /usr/share/nginx/html;",
  "",
  '  ssl_certificate "/etc/pki/private/restate-selfsigned.crt";',
  '  ssl_certificate_key "/etc/pki/private/restate-selfsigned.key";',
  "  ssl_session_cache shared:SSL:1m;",
  "  ssl_session_timeout 10m;",
  "  ssl_ciphers PROFILE=SYSTEM;",
  "  ssl_prefer_server_ciphers on;",
  "",
  "  location / {",
  `    proxy_pass http://localhost:${RESTATE_INGRESS_PORT};`,
  "  }",
  "}",
  "",
  "server {",
  "  listen 9073 ssl http2;",
  "  listen [::]:9073 ssl http2;",
  "  server_name _;",
  "  root /usr/share/nginx/html;",
  "",
  '  ssl_certificate "/etc/pki/private/restate-selfsigned.crt";',
  '  ssl_certificate_key "/etc/pki/private/restate-selfsigned.key";',
  "  ssl_session_cache shared:SSL:1m;",
  "  ssl_session_timeout 10m;",
  "  ssl_ciphers PROFILE=SYSTEM;",
  "  ssl_prefer_server_ciphers on;",
  "",
  "  location / {",
  `    proxy_pass http://localhost:${RESTATE_ADMIN_PORT};`,
  "  }",
  "}",
].join("\n");
