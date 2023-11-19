import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "node:path";
import { SingleNodeRestateInstance } from "./restate-constructs/single-node-restate-instance";
import { RestateLambdaServiceCollection } from "./restate-constructs/restate-lambda-services";

export class RestateSelfHostedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { githubTokenSecretName: string }) {
    super(scope, id, props);

    const greeterHandler = new lambda_node.NodejsFunction(this, "Greeter", {
      description: "Greeter service handler",
      entry: path.join(__dirname, "restate-services/greeter.ts"),
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

    const restateInstance = new SingleNodeRestateInstance(this, "Restate", {
      githubTokenSecretName: props.githubTokenSecretName,
      logGroup: new logs.LogGroup(this, "RestateLogGroup", {
        logGroupName: "restate",
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });

    const services = new RestateLambdaServiceCollection(this, "RestateServices", {
      serviceHandlers: {
        "greeter": greeterHandler,
      },
    });
    services.register(restateInstance);

    new cdk.CfnOutput(this, "RestateIngressEndpoint", {
      value: restateInstance.publicIngressEndpoint,
    });
  }
}