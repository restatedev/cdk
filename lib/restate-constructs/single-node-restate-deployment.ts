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
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { IRestateEnvironment } from "./restate-environment";
import { TracingMode } from "./deployments-common";
import * as cdk from "aws-cdk-lib";
import { RemovalPolicy } from "aws-cdk-lib";

export interface SingleNodeRestateProps {
  /** EC2 instance type to use. */
  instanceType?: ec2.InstanceType;

  /** Machine image. Note: startup script expects yum-based package management. */
  machineImage?: ec2.IMachineImage;

  /** The VPC in which to launch the Restate host. */
  vpc?: ec2.IVpc;

  networkConfiguration?: {
    /**
     * Subnet type for the Restate host.
     *
     * Available options:
     *  - [Default] {@link ec2.SubnetType.PRIVATE_WITH_EGRESS} will create the Restate instance with outbound internet
     *    access only, so that it can invoke HTTP endpoints. The security groups {@link ingressSecurityGroup} and
     *    {@link adminSecurityGroup} control inbound traffic to the service ingress and admin ports respectively.
     *    Configure {@link ServiceDeployer} to use the latter, and set up ingress traffic routing outside of this
     *    construct using the former.
     *  - Insecure, internet-facing {@link ec2.SubnetType.PUBLIC} will also provision an nginx reverse proxy
     *    and an HTTP listener with a self-signed certificate.
     */
    subnetType?: ec2.SubnetType.PRIVATE_WITH_EGRESS | ec2.SubnetType.PUBLIC;
  };

  /** Log group for Restate service logs. */
  logGroup?: logs.LogGroup;

  /** Tracing mode for Restate services. Defaults to {@link TracingMode.DISABLED}. */
  tracing?: TracingMode;

  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** Restate Docker image name. Defaults to `latest`. */
  restateImage?: string;

  /** Restate Docker image tag. Defaults to `latest`. */
  restateTag?: string;

  /**
   * EBS data volume settings for Restate data storage. If not specified, a default 8GB volume will be created.
   */
  dataVolumeOptions?: ec2.EbsDeviceProps | undefined;

  /** Restate high-level configuration options. Alternatively, you can set {@link restateConfigOverride}. */
  restateConfig?: {
    /** Defaults to the construct id if left unspecified. */
    clusterName?: string;
    /** Defaults to 4. Only takes effect on initial provisioning. */
    bootstrapNumPartitions?: number;
    /** RocksDB settings. */
    rocksdb?: {
      /** Defaults to 512 MB. */
      totalMemorySize?: cdk.Size;
    };
  };

  /**
   * Completely override the Restate server configuration. Note that other Restate configuration options
   * will effectively be ignored if this is set. See https://docs.restate.dev/operate/configuration/server/
   * for details.
   */
  restateConfigOverride?: string;

  /** Amazon Distro for Open Telemetry Docker image tag. Defaults to `latest`. */
  adotTag?: string;

  /**
   * Removal policy for long-lived resources (storage, logs). Default: `cdk.RemovalPolicy.DESTROY`.
   */
  removalPolicy?: cdk.RemovalPolicy;

  /**
   * The read timeout for proxyied ingress requests. Default: 3600 seconds.
   */
  ingressProxyReadTimeout?: cdk.Duration;

  /**
   * Completely override the default nginx configuration for the ingress proxy. Note that other
   * ingress proxy configuration options will effectively be ignored if this is set.
   */
  ingressNginxConfigOverride?: string;
}

const PUBLIC_INGRESS_PORT = 443;
const PUBLIC_ADMIN_PORT = 9070;
const RESTATE_INGRESS_PORT = 8080;
const RESTATE_ADMIN_PORT = 9070;
const RESTATE_IMAGE_DEFAULT = "docker.io/restatedev/restate";
const RESTATE_DOCKER_DEFAULT_TAG = "latest";
const ADOT_DOCKER_DEFAULT_TAG = "latest";
const DATA_DEVICE_NAME = "/dev/sdd";

/**
 * Creates a Restate service deployment backed by a single EC2 instance, suitable for development and testing purposes.
 *
 * The EC2 instance will be created in the default VPC unless otherwise specified.
 * See {@link SingleNodeRestateProps} for available configuration options.
 */
export class SingleNodeRestateDeployment extends Construct implements IRestateEnvironment {
  readonly instance: ec2.Instance;
  readonly instanceRole: iam.IRole;
  readonly invokerRole: iam.IRole;
  readonly vpc: ec2.IVpc;
  readonly ingressSecurityGroup: ec2.ISecurityGroup;
  readonly adminSecurityGroup: ec2.ISecurityGroup;

  readonly ingressUrl: string;
  readonly adminUrl: string;

  constructor(scope: Construct, id: string, props: SingleNodeRestateProps) {
    super(scope, id);

    this.vpc = props.vpc ?? ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });

    const subnetType = props.networkConfiguration?.subnetType ?? ec2.SubnetType.PRIVATE_WITH_EGRESS;

    this.instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    this.invokerRole = new iam.Role(this, "InvokerRole", {
      assumedBy: this.instanceRole,
    });

    new iam.Policy(this, "AssumeInvokerRolePolicy", {
      statements: [
        new iam.PolicyStatement({
          sid: "AllowAssumeInvokerRole",
          actions: ["sts:AssumeRole"],
          resources: [this.invokerRole.roleArn],
        }),
      ],
    }).attachToRole(this.instanceRole);

    const logGroup =
      props.logGroup ??
      new logs.LogGroup(this, "Logs", {
        logGroupName: `/restate/${id}`,
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      });
    logGroup.grantWrite(this.instanceRole);

    const restateImage = props.restateImage ?? RESTATE_IMAGE_DEFAULT;
    const restateTag = props.restateTag ?? RESTATE_DOCKER_DEFAULT_TAG;
    const adotTag = props.adotTag ?? ADOT_DOCKER_DEFAULT_TAG;

    const ingressNginxConfig = this.ingressNginxConfig(props);

    const initScript = ec2.UserData.forLinux();
    initScript.addCommands(
      "set -euf -o pipefail",
      `yum install -y npm && npm install -gq @restatedev/restate@${restateTag}`,
      "yum install -y docker",
      this.mountDataVolumeScript(),

      "mkdir -p /etc/restate",
      ["cat << EOF > /etc/restate/config.toml", this.restateConfig(id, props), "EOF"].join("\n"),

      "systemctl start docker.service",

      // Start the ADOT collector - needed for X-ray trace forwarding
      `if [ "$(docker ps -qa -f name=adot)" ]; then docker stop adot || true; docker rm adot; fi`,
      "docker run --name adot --restart on-failure --detach" +
        " -p 4317:4317 -p 55680:55680 -p 8889:8888" +
        ` public.ecr.aws/aws-observability/aws-otel-collector:${adotTag}`,

      // Start the Restate server container
      `if [ "$(docker ps -qa -f name=restate)" ]; then docker stop restate || true; docker rm restate; fi`,
      "docker run --name restate --restart on-failure --detach" +
        " --volume /etc/restate:/etc/restate" +
        " --volume /var/restate:/restate-data" +
        " --network=host" +
        " -e RESTATE_OBSERVABILITY__LOG__FORMAT=Json -e RUST_LOG=info,restate_worker::partition=warn" +
        " -e RESTATE_OBSERVABILITY__TRACING__ENDPOINT=http://localhost:4317" +
        ` --log-driver=awslogs --log-opt awslogs-group=${logGroup.logGroupName}` +
        ` ${restateImage}:${restateTag}` +
        " --config-file /etc/restate/config.toml",
    );

    if (subnetType == ec2.SubnetType.PUBLIC) {
      initScript.addCommands(
        "yum install -y nginx",
        "mkdir -p /etc/pki/private",
        [
          "openssl req -new -x509 -nodes -sha256 -days 365 -extensions v3_ca",
          " -subj '/C=DE/ST=Berlin/L=Berlin/O=restate.dev/OU=demo/CN=restate.example.com'",
          " -newkey rsa:2048 -keyout /etc/pki/private/restate-selfsigned.key -out /etc/pki/private/restate-selfsigned.crt",
        ].join(""),

        ["cat << EOF > /etc/nginx/conf.d/restate-ingress.conf", ingressNginxConfig, "EOF"].join("\n"),
        "systemctl start nginx",
      );
    }

    const cloudConfig = ec2.UserData.custom([`cloud_final_modules:`, `- [scripts-user, always]`].join("\n"));

    const userData = new ec2.MultipartUserData();
    userData.addUserDataPart(cloudConfig, "text/cloud-config");
    userData.addUserDataPart(initScript, "text/x-shellscript");

    const restateInstance = new ec2.Instance(this, "Host", {
      vpc: this.vpc,
      vpcSubnets: { subnetType },
      instanceType: props.instanceType ?? new ec2.InstanceType("t4g.micro"),
      machineImage:
        props.machineImage ??
        ec2.MachineImage.latestAmazonLinux2023({
          cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        }),
      role: this.instanceRole,
      blockDevices: [
        {
          deviceName: DATA_DEVICE_NAME,
          volume: {
            ebsDevice: {
              volumeSize: 8,
              deleteOnTermination: props.removalPolicy === RemovalPolicy.DESTROY,
              ...(props.dataVolumeOptions ?? {}),
            },
            virtualName: "restate-data",
          },
        },
      ],
      userData,
    });

    this.instance = restateInstance;

    // We start the ADOT collector regardless, and only control whether they will be published to X-Ray via instance
    // role permissions. This way historic traces will be buffered on the host, even if tracing is disabled initially.
    if (props.tracing === TracingMode.AWS_XRAY) {
      restateInstance.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"));
    }

    const ingressSecurityGroup = new ec2.SecurityGroup(this, "IngressSecurityGroup", {
      vpc: this.vpc,
      description: "Restate Ingress ACLs",
    });
    restateInstance.addSecurityGroup(ingressSecurityGroup);
    const adminSecurityGroup = new ec2.SecurityGroup(this, "AdminSecurityGroup", {
      vpc: this.vpc,
      description: "Restate Admin ACLs",
    });
    restateInstance.addSecurityGroup(adminSecurityGroup);

    if (subnetType == ec2.SubnetType.PUBLIC) {
      // Insecure, public-facing deployment
      ingressSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(PUBLIC_INGRESS_PORT),
        "Allow traffic from anywhere to Restate ingress port",
      );
      ingressSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(PUBLIC_ADMIN_PORT),
        "Allow traffic from anywhere to Restate admin port",
      );

      this.ingressUrl =
        `https://${restateInstance.instancePublicDnsName}` +
        (PUBLIC_INGRESS_PORT == 443 ? "" : `:${PUBLIC_INGRESS_PORT}`);
      this.adminUrl = `https://${restateInstance.instancePublicDnsName}:${PUBLIC_ADMIN_PORT}`;
    } else {
      ingressSecurityGroup.addIngressRule(
        ingressSecurityGroup,
        ec2.Port.tcp(RESTATE_INGRESS_PORT),
        "Allow traffic to Restate ingress port",
      );
      adminSecurityGroup.addIngressRule(
        adminSecurityGroup,
        ec2.Port.tcp(RESTATE_ADMIN_PORT),
        "Allow traffic to Restate admin port",
      );

      this.ingressUrl = `http://${restateInstance.instancePrivateDnsName}:${RESTATE_INGRESS_PORT}`;
      this.adminUrl = `http://${restateInstance.instancePrivateDnsName}:${RESTATE_ADMIN_PORT}`;
    }

    this.ingressSecurityGroup = ingressSecurityGroup;
    this.adminSecurityGroup = adminSecurityGroup;
  }

  protected restateConfig(id: string, props: SingleNodeRestateProps) {
    return (
      props.restateConfigOverride ??
      [
        `roles = [`,
        `    "worker",`,
        `    "admin",`,
        `    "metadata-store",`,
        `]`,
        `node-name = "restate-0"`,
        `cluster-name = "${props.restateConfig?.clusterName ?? id}"`,
        `allow-bootstrap = true`,
        `bootstrap-num-partitions = ${props.restateConfig?.bootstrapNumPartitions ?? 4}`,
        `default-thread-pool-size = 3`,
        `storage-high-priority-bg-threads = 3`,
        `storage-low-priority-bg-threads = 3`,
        `rocksdb-total-memory-size = "${props.restateConfig?.rocksdb?.totalMemorySize?.toMebibytes() ?? 512.0 + " MB"}"`,
        `rocksdb-total-memtables-ratio = 0.60`,
        `rocksdb-bg-threads = 3`,
        `rocksdb-high-priority-bg-threads = 3`,
        ``,
        `[worker]`,
        `internal-queue-length = 1000`,
        ``,
        `[worker.storage]`,
        `rocksdb-max-background-jobs = 3`,
        `rocksdb-statistics-level = "except-detailed-timers"`,
        `num-partitions-to-share-memory-budget = 4`,
        ``,
        `[admin.query-engine]`,
        `memory-size = "50.0 MB"`,
        `query-parallelism = 4`,
        ``,
        `[ingress]`,
        `rocksdb-max-background-jobs = 3`,
        `rocksdb-statistics-level = "except-detailed-timers"`,
        `writer-batch-commit-count = 1000`,
        ``,
        `[metadata-store.rocksdb]`,
        `rocksdb-max-background-jobs = 1`,
        `rocksdb-statistics-level = "except-detailed-timers"`,
      ].join("\n")
    );
  }

  protected mountDataVolumeScript() {
    return `
if mount | grep -qs '/var/restate'; then
  echo "/var/restate is mounted"
else
  if [ -d /var/restate ]; then
    if [ "$(ls -A /var/restate)" ]; then
      echo "Data exists in /var/restate that is not on data volume; refusing to overwrite!"
      exit 1
    fi
  else
    mkdir /var/restate
  fi
  if file -sL ${DATA_DEVICE_NAME} | grep -q ': data$'; then
    mkfs -t xfs ${DATA_DEVICE_NAME}
  fi
  mount ${DATA_DEVICE_NAME} /var/restate
  if ! grep -qs '/var/restate' /etc/fstab; then
    echo "${DATA_DEVICE_NAME} /var/restate xfs defaults 0 0" >> /etc/fstab
    echo "Added entry for ${DATA_DEVICE_NAME} to /etc/fstab"
  else
    echo "Entry for ${DATA_DEVICE_NAME} already exists in /etc/fstab"
  fi
fi
`;
  }

  /**
   * @param props construct properties
   * @returns nginx configuration to use for ingress reverse proxy, formatted as a multi-line string
   */
  protected ingressNginxConfig(props: SingleNodeRestateProps) {
    return (
      props.ingressNginxConfigOverride ??
      [
        "server {",
        `  listen ${PUBLIC_INGRESS_PORT} ssl http2;`,
        `  listen [::]:${PUBLIC_INGRESS_PORT} ssl http2;`,
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
        `    proxy_read_timeout ${props.ingressProxyReadTimeout?.toSeconds() ?? 3600};`,
        "  }",
        "}",
        "",
        "server {",
        `  listen ${PUBLIC_ADMIN_PORT} ssl http2;`,
        `  listen [::]:${PUBLIC_ADMIN_PORT} ssl http2;`,
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
      ].join("\n")
    );
  }
}
