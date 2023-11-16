import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
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

    // TODO: To avoid baking the secret into the CloudFormation template, please manually add as plaintext a GitHub PAT which is authorized to access restate-dist
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
    // TODO: send output to CloudWatch logs

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
    // restateInstanceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), "Allow inbound on port 8080");
    // restateInstanceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9070), "Allow inbound on port 9070");

    const greeterService = new lambda_node.NodejsFunction(this, "GreeterService", {
      description: "Greeter service handler",
      entry: path.join(__dirname, "restate-service/greeter.ts"),
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 128,
      bundling: {
        sourceMap: true,
        minify: true,
      },
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
    });
    greeterService.grantInvoke(restateInstanceRole);

    const greeterServiceEndpoint = new api_gw.RestApi(this, "Greeter", {
      binaryMediaTypes: ["application/proto", "application/restate"],
    });
    greeterServiceEndpoint.deploymentStage = new api_gw.Stage(this, "Default", {
      stageName: "default",
      deployment: new api_gw.Deployment(this, "GreeterApiDeployment", {
        api: greeterServiceEndpoint,
      }),
    });

    const usagePlan = greeterServiceEndpoint.addUsagePlan("UsagePlan", {
      name: "UsagePlan",
      throttle: {
        rateLimit: 5,
        burstLimit: 20,
      },
    });
    usagePlan.addApiStage({
      stage: greeterServiceEndpoint.deploymentStage,
    });

    const greeterProxy = greeterServiceEndpoint.root.addResource("greeter");
    greeterProxy.addProxy({
      defaultIntegration: new api_gw.LambdaIntegration(greeterService),
      anyMethod: true,
    });

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
    vpc.privateSubnets.forEach((subnet) => {
      restateInstanceSecurityGroup.addIngressRule(ec2.Peer.ipv4(subnet.ipv4CidrBlock), ec2.Port.tcp(9070), "Allow traffic from the VPC to Restate meta");
    });
    vpc.privateSubnets.forEach((subnet) => {
      restateInstanceSecurityGroup.addIngressRule(ec2.Peer.ipv4(subnet.ipv4CidrBlock), ec2.Port.tcp(8080), "Allow traffic from the VPC to Restate ingress");
    });
    restateInstance.addSecurityGroup(restateInstanceSecurityGroup);

    // After the Restate instance comes up (and reports as healthy!), we want to call it on port 9070 and register the Lambda service
    // We'll do this using a custom CDK resource that depends on the Lambda.
    const registrationHandler = new lambda_node.NodejsFunction(this, "RestateRegistrationHandler", {
      description: "Restate custom registration handler",
      entry: path.join(__dirname, "restate-constructs/register-service-handler.ts"),
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
      vpc, // This Lambda needs to be in the same VPC as the Restate instance to be able to access its meta endpoint
      vpcSubnets: {
        subnets: vpc.privateSubnets,
      },
    });
    const registerServiceProvider = new cr.Provider(this, "RestateServiceRegistrationProvider", {
      onEventHandler: registrationHandler,
    });

    const registerGreeterService = new cdk.CustomResource(this, "RegisterGreeterService", {
      serviceToken: registerServiceProvider.serviceToken,
      resourceType: "Custom::RestateRegisterService",
      properties: {
        ingressEndpoint: `http://${restateInstance.instancePrivateDnsName}:8080`,
        metaEndpoint: `http://${restateInstance.instancePrivateDnsName}:9070`,
        serviceEndpoint: `${greeterServiceEndpoint.urlForPath("/greeter")}`,
        functionVersion: greeterService.currentVersion.version,
      },
    });
    registerGreeterService.node.addDependency(restateInstance);
    registerGreeterService.node.addDependency(greeterService);

    new cdk.CfnOutput(this, "GreeterServiceEndpointUrl", {
      value: greeterServiceEndpoint.url,
    });
    new cdk.CfnOutput(this, "InstancePrivateDnsName", {
      value: `${restateInstance.instancePrivateDnsName}`,
    });
    new cdk.CfnOutput(this, "RestateLBEndpointUrl", {
      value: `http://${loadBalancer.loadBalancerDnsName}:80`,
    });
  }
}