import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as elb_v2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { InstanceTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as api_gw from "aws-cdk-lib/aws-apigateway";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
import path from "node:path";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import { LogGroup } from "aws-cdk-lib/aws-logs";

const RESTATE_INGRESS_PORT = 8080;
const RESTATE_META_PORT = 9070;

export type RestateInstanceProps = {
  /**
   * The name of the CloudWatch Logs group to use for Restate log output. NB: the construct will
   * grant the necessary permissions to the instance role to write to this log group.
   */
  logGroup: logs.LogGroup;

  /**
   * The name of the Secrets Store secret that contains the GitHub token to use for Docker login.
   * This is `/restate/docker/github-token` by default.
   */
  githubTokenPath?: string;

  /**
   * Temporary! This will disappear once we move to direct Lambda calls.
   */
  serviceApiThrottle?: {
    rateLimit?: number,
    burstLimit?: number,
  },
};

/**
 * Creates a Restate service deployment backed by a single EC2 instance,
 * suitable for development and testing purposes.
 */
export class SingleNodeRestateInstance extends Construct {
  readonly instance: ec2.Instance;
  readonly instanceRole: iam.Role;
  readonly vpc: ec2.Vpc;
  readonly serviceDiscoveryProvider: cr.Provider;

  readonly publicIngressEndpoint: string;
  readonly privateIngressEndpoint: string;
  readonly metaEndpoint: string;

  // This API is used to provide an HTTP endpoint to call handlers; we'll shortly be migrating to direct Lambda access
  readonly serviceApi: api_gw.RestApi;

  constructor(scope: Construct, id: string, props: { githubTokenSecretName: string; logGroup: LogGroup }) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "RestateVpc", {
      maxAzs: 3,
    });

    this.instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    props.logGroup.grantWrite(this.instanceRole);

    const secretName = props.githubTokenSecretName ?? "/restate/docker/github-token";
    const githubToken = secrets.Secret.fromSecretNameV2(this, "GithubToken", secretName);
    githubToken.grantRead(this.instanceRole);

    const restateInitCommands = ec2.UserData.forLinux();
    restateInitCommands.addCommands(
      "sudo yum update -y",
      "sudo yum install -y docker",
      "aws secretsmanager get-secret-value --secret-id \"/restate/docker/github-token\" --query SecretString --output text | sudo docker login ghcr.io -u NA --password-stdin",
      "sudo service docker start",
      `sudo docker run --name restate --rm -d --network=host -e RESTATE_OBSERVABILITY__LOG__FORMAT=Json -e RUST_LOG=info,restate_worker::partition=warn --log-driver=awslogs --log-opt awslogs-group=restate ghcr.io/restatedev/restate-dist:latest`,
    );

    const restateInstance = new ec2.Instance(this, "Host", {
      vpc: this.vpc,
      instanceType: new ec2.InstanceType("t4g.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: this.instanceRole,
      userData: restateInitCommands,
    });
    this.instance = restateInstance;

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
      port: RESTATE_INGRESS_PORT,
      targets: [new InstanceTarget(restateInstance)],
      healthCheck: {
        path: "/grpc.health.v1.Health/Check",
        protocol: elb_v2.Protocol.HTTP,
      },
    });
    // TODO: Make this HTTPS (https://github.com/restatedev/restate-cdk-support/issues/2)
    ingressLoadBalancer.addListener("Listener", {
      port: 80,
      defaultTargetGroups: [targetGroup],
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

    this.serviceApi = this.serviceHttpApi(props);
    this.serviceDiscoveryProvider = this.registrationProvider();

    this.publicIngressEndpoint = `http://${ingressLoadBalancer.loadBalancerDnsName}`;
    this.privateIngressEndpoint = `http://${this.instance.instancePrivateDnsName}:${RESTATE_INGRESS_PORT}`;
    this.metaEndpoint = `http://${this.instance.instancePrivateDnsName}:${RESTATE_META_PORT}`;
  }

  private registrationProvider() {
    const registrationHandler = new lambda_node.NodejsFunction(this, "RegistrationHandler", {
      description: "Restate custom registration handler",
      entry: path.join(__dirname, "lambda/register-service-handler.ts"),
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        sourceMap: true,
        minify: true,
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
      vpc: this.vpc, // This Lambda must be in the same VPC as the Restate instance to be able to access its meta endpoint
      vpcSubnets: {
        subnets: this.vpc.privateSubnets,
      },
    });

    return new cr.Provider(this, "RegistrationProvider", {
      onEventHandler: registrationHandler,
    });
  }

  // TODO: Remove API Gateway and switch to direct Lambda integration (https://github.com/restatedev/restate-cdk-support/issues/3)
  private serviceHttpApi(props: RestateInstanceProps) {
    const serviceApi = new api_gw.RestApi(this, "ServiceApi", {
      binaryMediaTypes: ["application/proto", "application/restate"],
    });
    serviceApi.deploymentStage = new api_gw.Stage(this, "Default", {
      stageName: "default",
      deployment: new api_gw.Deployment(this, "Deployment", {
        api: serviceApi,
      }),
    });

    const usagePlan = serviceApi.addUsagePlan("UsagePlan", {
      name: "UsagePlan",
      throttle: {
        rateLimit: props.serviceApiThrottle?.rateLimit ?? 10,
        burstLimit: props.serviceApiThrottle?.burstLimit ?? 20,
      },
    });
    usagePlan.addApiStage({
      stage: serviceApi.deploymentStage,
    });

    return serviceApi;
  }
}