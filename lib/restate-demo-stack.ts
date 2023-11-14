import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
// import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export class RestateDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { githubPat: string }) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "RestateVpc", {
      maxAzs: 1,
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
      "sudo docker run --name restate_dev --rm -p 8081:8081 -p 9091:9091 -p 9090:9090 -p 5432:5432 ghcr.io/restatedev/restate-dist:latest",
    );

    const ssmEnabledInstanceRole = new iam.Role(this, "SSMRole", {
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

    const restateHost = new ec2.Instance(this, "RestateHost", {
      vpc,
      instanceType: new ec2.InstanceType("t4g.micro"),
      machineImage,
      role: ssmEnabledInstanceRole,
      userData: runRestateDaemonCommands,
    });

    new cdk.CfnOutput(this, "RestateHostInstanceId", {
      value: restateHost.instanceId,
    });
  }
}