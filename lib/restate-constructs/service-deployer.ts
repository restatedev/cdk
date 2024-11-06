/*
 * Copyright (c) 2023-2024 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import path from "node:path";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
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
 * You can share the same deployer across multiple service registries provided the configuration options are compatible
 * (e.g. the Restate environments it needs to communicate with for deployment are all accessible via the same VPC and
 * Security Groups, accept the same authentication token, and so on).
 *
 * Deployment logs are retained for 30 days by default.
 */
export class ServiceDeployer extends Construct {
  /** The custom resource provider for handling "deployment" resources. */
  readonly deploymentResourceProvider: cr.Provider;

  private invocationPolicy?: iam.Policy;

  constructor(
    scope: Construct,
    id: string,
    /**
     * Allows the custom resource event handler properties to be overridden. The main use case for this is specifying
     * VPC and security group settings for Restate environments that require it.
     */
    props?: Pick<
      lambda.FunctionOptions,
      "functionName" | "logGroup" | "timeout" | "vpc" | "vpcSubnets" | "securityGroups" | "allowPublicSubnet"
    > &
      Pick<lambda_node.NodejsFunctionProps, "entry"> &
      Pick<logs.LogGroupProps, "removalPolicy">,
  ) {
    super(scope, id);

    const eventHandler = new lambda_node.NodejsFunction(this, "EventHandler", {
      functionName: props?.functionName,
      logGroup: props?.logGroup,
      description: "Restate custom registration handler",
      entry: props?.entry ?? path.join(__dirname, "register-service-handler/index.js"),
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_LATEST,
      memorySize: 128,
      timeout: props?.timeout ?? DEFAULT_TIMEOUT,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: false,
        sourceMap: true,
      },
      ...(props?.vpc
        ? ({
            vpc: props?.vpc,
            vpcSubnets: props?.vpcSubnets,
            securityGroups: props?.securityGroups,
          } satisfies Pick<lambda.FunctionOptions, "vpc" | "vpcSubnets" | "securityGroups">)
        : {}),
      allowPublicSubnet: props?.allowPublicSubnet,
    });

    if (!props?.logGroup) {
      // By default, Lambda Functions have a log group with never-expiring retention policy.
      new logs.LogGroup(this, "DeploymentLogs", {
        logGroupName: `/aws/lambda/${eventHandler.functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });
    }

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
       * Secrets Manager secret ARN for the authentication token to use when calling the admin API. Takes precedence
       * over the environment's token.
       */
      authToken?: secrets.ISecret;
      /**
       * Whether to skip granting the invoker role permission to invoke the service handler.
       */
      skipInvokeFunctionGrant?: boolean;
      /**
       * Whether to mark the service as private, and make it unavailable to be called via Restate ingress.
       * @see https://docs.restate.dev/operate/registration#private-services
       */
      private?: boolean;
      /**
       * A dummy parameter to force CloudFormation to update the deployment when the configuration changes. Useful if
       * you want to target the "latest version" of a service handler and need to force a deployment in order to trigger
       * discovery.
       */
      configurationVersion?: string;
      /**
       * Whether to accept self-signed certificates.
       */
      insecure?: boolean;
      /**
       * Specify a custom admin endpoint URL, overriding the one exposed by the target environment.
       */
      adminUrl?: string;
    },
  ) {
    const authToken = options?.authToken ?? environment.authToken;
    authToken?.grantRead(this.deploymentResourceProvider.onEventHandler);

    const deployment = new cdk.CustomResource(handler, "RestateDeployment", {
      serviceToken: this.deploymentResourceProvider.serviceToken,
      resourceType: "Custom::RestateServiceDeployment",
      properties: {
        servicePath: serviceName,
        adminUrl: options?.adminUrl ?? environment.adminUrl,
        authTokenSecretArn: authToken?.secretArn,
        serviceLambdaArn: handler.functionArn,
        invokeRoleArn: environment.invokerRole?.roleArn,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        private: (options?.private ?? false).toString() as "true" | "false",
        configurationVersion: options?.configurationVersion,
        insecure: (options?.insecure ?? false).toString() as "true" | "false",
      } satisfies RegistrationProperties,
    });

    if (environment.invokerRole && !options?.skipInvokeFunctionGrant) {
      // We create a separate policy which we'll attach to the provided invoker role. This breaks a circular cross-stack
      // dependency that would otherwise be created between the service deployer and the invoker role.
      if (!this.invocationPolicy) {
        this.invocationPolicy = new iam.Policy(this, "InvocationPolicy");
        // Despite the ARN reference above, CloudFormation sometimes tries to invoke the custom resource handler before
        // all permissions are applied. Adding an explicit dependency includes a dependency on any pending policy updates
        // defined in the same stack as the service deployer, which seems to help. Some propagation delay might still mean
        // we lean on retries in the deployer event handler in any event but this reduces the probability of failure.
        deployment.node.addDependency(this.invocationPolicy);
        this.invocationPolicy.attachToRole(environment.invokerRole);
      }
      this.invocationPolicy.addStatements(
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: handler.lambda.resourceArnsForGrantInvoke,
        }),
      );
    }
  }
}
