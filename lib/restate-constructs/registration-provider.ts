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

const DEFAULT_TIMEOUT = cdk.Duration.seconds(180);

/**
 * This construct implements a custom CloudFormation resource provider that handles deploying Lambda-based service
 * handlers with a Restate environment. It is used internally by the Cloud and self-hosted Restate environment
 * constructs and not intended for direct use by end users of Restate.
 *
 * This functionality is implemented as a custom resource so that we are notified of any updates to service handler
 * functions: by creating a CloudFormation component, we can model the dependency that any changes to the handlers need
 * to be communicated to the registrar. Without this dependency, CloudFormation might perform an update deployment that
 * triggered by a Lambda handler code or configuration change, and the Restate environment would be unaware of it.
 */
export class RegistrationProvider extends Construct {
  /** The ARN of the custom resource provider Lambda handler. */
  readonly serviceToken: string;

  constructor(scope: Construct, id: string, props: { authToken?: ssm.ISecret; timeout?: cdk.Duration; vpc?: ec2.Vpc }) {
    super(scope, id);

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
