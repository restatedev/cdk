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
import * as ssm from "aws-cdk-lib/aws-secretsmanager";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
import path from "node:path";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as ec2 from "aws-cdk-lib/aws-ec2";

const DEFAULT_TIMEOUT = cdk.Duration.seconds(120);

export class RegistrationProvider extends Construct {
  readonly serviceToken: string;

  constructor(scope: Construct, id: string, props: { authToken?: ssm.ISecret; timeout?: cdk.Duration; vpc?: ec2.Vpc }) {
    super(scope, id);

    if (props.vpc) {
      console.log("Using VPC!");
    }

    const registrationHandler = new lambda_node.NodejsFunction(this, "RegistrationHandler", {
      description: "Restate custom registration handler",
      entry: path.join(__dirname, "register-service-handler/index.js"),
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 128,
      timeout: props.timeout ?? DEFAULT_TIMEOUT,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: false,
        sourceMap: true,
      },
      ...(props.vpc ? { vpc: props.vpc, subnets: props.vpc.privateSubnets } : {}),
    });
    props.authToken?.grantRead(registrationHandler);

    const registrationProvider = new cr.Provider(this, "RegistrationProvider", {
      onEventHandler: registrationHandler,
    });
    this.serviceToken = registrationProvider.serviceToken;
  }
}
