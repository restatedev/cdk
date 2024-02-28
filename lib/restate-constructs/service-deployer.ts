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
import { IRestateEnvironment } from "./restate-environment";
import { RegistrationProperties } from "./register-service-handler";

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
 *
 * You can share the same instance across multiple service registries provided the configuration options are compatible
 * (e.g. the Restate environments it needs to communicate with for deployment are all accessible via the same VPC and
 * Security Groups).
 */
export class ServiceDeployer extends Construct {
  /** The custom resource provider for handling "deployment" resources. */
  readonly deploymentResourceProvider: cr.Provider;

  constructor(
    scope: Construct,
    id: string,
    props: {
      authToken?: ssm.ISecret;
    } & Pick<lambda.FunctionOptions, "functionName" | "logGroup" | "timeout" | "vpc" | "vpcSubnets" | "securityGroups">,
  ) {
    super(scope, id);

    const eventHandler = new lambda_node.NodejsFunction(this, "EventHandler", {
      functionName: props.functionName,
      logGroup: props.logGroup,
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
      ...(props.vpc
        ? ({
            vpc: props.vpc,
            vpcSubnets: props.vpcSubnets,
            securityGroups: props.securityGroups,
          } satisfies Pick<lambda.FunctionOptions, "vpc" | "vpcSubnets" | "securityGroups">)
        : {}),
    });
    props.authToken?.grantRead(eventHandler);

    this.deploymentResourceProvider = new cr.Provider(this, "CustomResourceProvider", { onEventHandler: eventHandler });
  }

  /**
   * Deploy a Lambda-backed Restate service to a given environment. This will register a deployment that will trigger
   * a Restate registration whenever the handler resource changes.
   *
   * @param serviceName the service name within Restate - this must match the service's self-reported name during discovery
   * @param handler service handler - must be a specific function version, use "latest" if you don't care about explicit versioning
   * @param environment target Restate environment
   * @param options additional options; see field documentation for details
   */
  deployService(
    serviceName: string,
    handler: lambda.IVersion,
    environment: IRestateEnvironment,
    options?: {
      /**
       * SSM secret ARN for the authentication token to use with the admin API. Takes precedence over the environment's
       * token, if it is set.
       */
      authToken?: ssm.ISecret;
      /**
       * Whether to skip granting the invoker role permission to invoke the service handler.
       */
      skipInvokeFunctionGrant?: boolean;
      /**
       * Whether to mark the service as private, and make it unavailable to be called via Restate ingress.
       * @see https://docs.restate.dev/services/invocation/#private-services
       */
      private?: boolean;
      /**
       * A dummy parameter to force CloudFormation to update the deployment when the configuration changes. Useful if
       * you want to target the "latest version" of a service handler and need to force a deployment in order to trigger
       * discovery.
       */
      configurationVersion?: string;
    },
  ) {
    const authToken = options?.authToken ?? environment.authToken;
    authToken?.grantRead(this.deploymentResourceProvider.onEventHandler);

    const deployment = new cdk.CustomResource(handler, "RestateDeployment", {
      serviceToken: this.deploymentResourceProvider.serviceToken,
      resourceType: "Custom::RestateServiceDeployment",
      properties: {
        servicePath: serviceName,
        adminUrl: environment.adminUrl,
        authTokenSecretArn: authToken?.secretArn,
        serviceLambdaArn: handler.functionArn,
        invokeRoleArn: environment.invokerRole?.roleArn,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        private: (options?.private ?? false).toString() as "true" | "false",
        configurationVersion: options?.configurationVersion,
      } satisfies RegistrationProperties,
    });

    if (environment.invokerRole) {
      if (!options?.skipInvokeFunctionGrant) {
        handler.lambda.grantInvoke(environment.invokerRole);
      }

      // Despite the ARN reference above, CloudFormation sometimes tries to invoke the custom resource handler before
      // all permissions are applied. Adding an explicit dependency includes a dependency on any pending policy updates
      // defined in the same stack as the service deployer, which seems to help. Some propagation delay might still mean
      // we lean on retries in the deployer event handler in any event but this reduces the probability of failure.
      deployment.node.addDependency(environment.invokerRole);
    }
  }
}
