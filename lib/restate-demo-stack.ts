import * as cdk from "aws-cdk-lib";
import * as api_gw from "aws-cdk-lib/aws-apigateway";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
// import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "node:path";
import { InstanceTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";

export class RestateDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { githubPat: string }) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "RestateVpc", {
      maxAzs: 3,
    });

    // To avoid baking the secret into the CloudFormation template, please manually add as plaintext a GitHub PAT which is authorized to access restate-dist
    // const githubPatSecret = new ssm.StringParameter(this, "GithubPatSecret", {
    //   parameterName: "/restate/gh-pat",
    //   stringValue: "replace-me",
    // });

    const runRestateDaemonCommands = ec2.UserData.forLinux();
    runRestateDaemonCommands.addCommands(
      "sudo yum update -y",
      "sudo yum install -y docker",
      // "aws secretsmanager get-secret-value --secret-id \"/restate/gh-pat\" --query SecretString --output text | sudo docker login ghcr.io -u NA --password-stdin",
      `echo ${props.githubPat} | sudo docker login ghcr.io -u NA --password-stdin`,
      "sudo service docker start",
      "sudo docker run --name restate --rm -d --network=host ghcr.io/restatedev/restate-dist:latest",
    );

    const restateInstanceRole = new iam.Role(this, "SSMRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // const machineImage = new ec2.AmazonLinuxImage({
    //   generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
    //   userData,
    // });

    // Temp workaround for insufficient SSM permissions to look up the al2023 AMI
    const machineImage = new ec2.GenericLinuxImage({
      "eu-central-1": "ami-0ca82fa36091d6ada", // al2023-ami-2023.2.20231030.1-kernel-6.1-arm64
    });

    const restateInstance = new ec2.Instance(this, "RestateHost", {
      vpc,
      instanceType: new ec2.InstanceType("t4g.micro"),
      machineImage,
      role: restateInstanceRole,
      userData: runRestateDaemonCommands,
    });

    const restateInstanceSecurityGroup = new ec2.SecurityGroup(this, "RestateSecurityGroup", {
      vpc,
      securityGroupName: "RestateSecurityGroup",
      description: "Allow inbound traffic to Restate",
    });
    restateInstanceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), "Allow inbound on port 8080");

    const greeterService = new lambda_node.NodejsFunction(this, "GreeterService", {
      entry: path.join(__dirname, "restate-service/greeter.ts"),
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 128,
      bundling: {
        sourceMap: true,
      },
    });
    greeterService.grantInvoke(restateInstanceRole);

    const api = new api_gw.RestApi(this, "Greeter", {
      binaryMediaTypes: ["application/proto", "application/restate"],
    });
    api.deploymentStage = new api_gw.Stage(this, "Default", {
      stageName: "default",
      deployment: new api_gw.Deployment(this, "GreeterApiDeployment", {
        api,
      }),
    });

    // const greeterBackendApiKey = api.addApiKey("ApiKey", {
    //   description: "Greeter backend API Key",
    //   apiKeyName: "greeterApiKey",
    //   value: "SuperSecretApiKey92481",
    // });

    const usagePlan = api.addUsagePlan("UsagePlan", {
      name: "UsagePlan",
      throttle: {
        rateLimit: 5,
        burstLimit: 20,
      },
      // You may want to further restrict the usage of your API by adding a quota:
      // quota: {
      //   limit: 10_000,
      //   period: api_gw.Period.DAY,
      // },
    });
    usagePlan.addApiStage({
      stage: api.deploymentStage,
    });

    const greeterProxy = api.root.addResource("greeter");
    greeterProxy.addProxy({
      defaultIntegration: new api_gw.LambdaIntegration(greeterService),
      anyMethod: true,
    });

    // Create a new Network Load Balancer - needed in front of the EC2 instance
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "RestateAlb", {
      vpc,
      internetFacing: true,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: 8080,
      targets: [new InstanceTarget(restateInstance)],
      healthCheck: {
        path: "/grpc.health.v1.Health/Check",
        protocol: elbv2.Protocol.HTTP,
      },
    });
    loadBalancer.addListener("Listener", {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "ALB security group",
      allowAllOutbound: false,
    });
    albSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), "Allow HTTP traffic to Restate service");
    loadBalancer.addSecurityGroup(albSecurityGroup);

    restateInstanceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(8080), "Allow traffic from ALB to Restate ingress");
    restateInstance.addSecurityGroup(restateInstanceSecurityGroup);

    new cdk.CfnOutput(this, "GreeterServiceEndpointUrl", {
      value: api.url,
    });
    new cdk.CfnOutput(this, "RestateLBEndpointUrl", {
      value: `http://${loadBalancer.loadBalancerDnsName}:80`,
    });
  }
}