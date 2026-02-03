/*
 * Copyright (c) 2023-2025 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import path from "node:path";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_node from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import { IRestateEnvironment } from "./restate-environment";
import type { RegistrationProperties } from "./register-service-handler/index.mts";

const DEFAULT_TIMEOUT = cdk.Duration.seconds(300);

export interface ServiceRegistrationProps {
  /**
   * Secrets Manager secret ARN for the authentication token to use when calling the admin API. Takes precedence
   * over the environment's token.
   */
  authToken?: secrets.ISecret;

  /**
   * The external invoker role that Restate can assume to execute service handlers. If left unset, it's assumed that
   * the Restate deployment has sufficient permissions to invoke the handler directly. Takes precedence over the
   * environment's invokerRole.
   */
  invokerRole?: iam.IRole;

  /**
   * Whether to skip granting the invoker role permission to invoke the service handler. The deployer by default
   * will grant the invoker role permission to invoke the handler, but you can set this to `true` to handle this
   * manually.
   */
  skipInvokeFunctionGrant?: boolean;

  /**
   * Private services are only available to other Restate services in the same environment, and are not accessible for
   * ingress-based invocation. If multiple services are exposed by the same handler, all of them will be updated.
   * Default: `false`, i.e. services will be made public and reachable via ingress by default.
   *
   * @see https://docs.restate.dev/operate/registration#private-services
   */
  private?: boolean;

  /**
   * A dummy parameter to force CloudFormation to update the deployment when the configuration changes. Useful if
   * you want to target the "latest version" of a service handler and need to force a deployment in order to trigger
   * discovery. Set this to a new value every time you want to force a service registration to happen, e.g. a timestamp.
   */
  configurationVersion?: string;

  /**
   * Accept self-signed certificates.
   */
  insecure?: boolean;

  /**
   * Specify a custom admin endpoint URL, overriding the one exposed by the target environment. You may need this if
   * the `Environment` construct is reporting a different URL from the one that the deployer can reach, e.g. if your
   * Restate service is behind a load balancer.
   */
  adminUrl?: string;

  /**
   * What to do when the handler is removed from the stack.
   * - RETAIN: Leave deployment registered in Restate (default). Use this if you want to transition to managing
   *   deployments manually, or if you want to remove the ServiceDeployer without affecting existing registrations.
   * - DESTROY: Force-remove the deployment from Restate. Use this if you are decommissioning the service.
   *
   * Default: RETAIN
   */
  removalPolicy?: cdk.RemovalPolicy;

  /**
   * Prune fully drained deployments of the same handler after each successful registration. Only removes deployments
   * that have no associated services and no pinned invocations. This helps clean up old deployment versions that
   * accumulate over time as new versions are registered.
   *
   * Default: false
   */
  pruneDrainedDeployments?: boolean;

  /**
   * Number of old drained deployment revisions to retain. Only applies if `pruneDrainedDeployments` is enabled.
   * Drained deployments beyond this limit will be removed, oldest first.
   *
   * Default: 0
   */
  revisionHistoryLimit?: number;

  /**
   * Maximum number of drained deployments to prune per registration. Limits the cleanup work done in each
   * deployment to avoid long-running operations. Only applies if `pruneDrainedDeployments` is enabled.
   *
   * Default: 10
   */
  maxPrunedPerRun?: number;
}

/**
 * Register Lambda-backed restate services with Restate environments.
 *
 * You can reuse the same deployer to register the services exposed by multiple handlers. You can also reuse the
 * deployer to target multiple Restate environments, provided the configuration options are compatible (e.g. the Restate
 * environments it needs to communicate with are all accessible from the same VPC and Security Groups, accept the same
 * authentication token, and so on). Conversely, you can create multiple deployers in cases when you need to deploy to
 * multiple environments that require distinct configuration.
 *
 * Deployment logs are retained for 30 days by default.
 *
 * @see {register}
 */
export class ServiceDeployer extends Construct {
  /** The custom resource provider for handling "deployment" resources. */
  readonly eventHandler: lambda_node.NodejsFunction;

  private invocationPolicy?: iam.Policy;

  constructor(
    scope: Construct,
    id: string,
    /**
     * Allows the custom resource event handler properties to be overridden. The main use case for this is specifying
     * VPC and security group settings for Restate environments that require it. The event handler must be able
     * to reach the S3 API, so if the subnet has no egress, it will need an S3 VPC endpoint.
     */
    props?: Partial<
      Pick<
        lambda.FunctionProps,
        | "allowPublicSubnet"
        | "architecture"
        | "runtime"
        | "code"
        | "handler"
        | "functionName"
        | "logGroup"
        | "role"
        | "securityGroups"
        | "timeout"
        | "vpc"
        | "vpcSubnets"
      > &
        Pick<logs.LogGroupProps, "removalPolicy">
    >,
  ) {
    super(scope, id);

    this.eventHandler = new lambda.Function(this, "EventHandler", {
      functionName: props?.functionName,
      logGroup: props?.logGroup,
      description: "Restate custom registration handler",
      code: props?.code ?? cdk.aws_lambda.Code.fromAsset(path.join(__dirname, "register-service-handler")),
      handler: props?.handler ?? "entrypoint.handler",
      architecture: props?.architecture ?? lambda.Architecture.ARM_64,
      runtime: props?.runtime ?? lambda.Runtime.NODEJS_22_X,
      role: props?.role,
      memorySize: 128,
      timeout: props?.timeout ?? DEFAULT_TIMEOUT,
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
        logGroupName: `/aws/lambda/${this.eventHandler.functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: props?.removalPolicy ?? cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });
    }
  }

  /**
   * Deploy a Lambda-backed Restate handler to a given environment.
   *
   * Note that a change in the handler properties is necessary to trigger re-discovery due to how CloudFormation updates
   * work. If you deploy a fixed Lambda alias such as `$LATEST` which isn't changing on every handler code or
   * configuration update, you will want to set the `configurationVersion` property in `options` to a new value (e.g. a
   * timestamp) to ensure an update to the Restate environment is triggered on stack deployment.
   *
   * @param handler service handler - must be a specific function version, use "latest" if you don't care about explicit versioning
   * @param environment target Restate environment
   * @param options additional options; see field documentation for details
   * @see {ServiceRegistrationProps}
   */
  register(handler: lambda.IVersion, environment: IRestateEnvironment, options?: ServiceRegistrationProps) {
    this.registerServiceInternal(undefined, handler, environment, options);
  }

  /**
   * Deploy a Lambda-backed Restate handler to a given environment, ensuring that a particular service name exists.
   *
   * Note that a change in the handler properties is necessary to trigger re-discovery due to how CloudFormation updates
   * work. If you deploy a fixed Lambda alias such as `$LATEST` which isn't changing on every handler code or
   * configuration update, you will want to set the `configurationVersion` property in `options` to a new value (e.g. a
   * timestamp) to ensure an update to the Restate environment is triggered on stack deployment.
   *
   * @param serviceName the service name within Restate - as a safety mechanism, this must match the service's
   *        self-reported name during discovery; if there are multiple services, one of them must match or the
   *        deployment fails
   * @param handler service handler - must be a specific function version, use "latest" if you don't care about explicit versioning
   * @param environment target Restate environment
   * @param options additional options; see field documentation for details
   */
  deployService(
    serviceName: string,
    handler: lambda.IVersion,
    environment: IRestateEnvironment,
    options?: ServiceRegistrationProps,
  ) {
    this.registerServiceInternal(serviceName, handler, environment, options);
  }

  private registerServiceInternal(
    serviceName: string | undefined,
    handler: lambda.IVersion,
    environment: IRestateEnvironment,
    options?: ServiceRegistrationProps,
  ) {
    const authToken = options?.authToken ?? environment.authToken;
    authToken?.grantRead(this.eventHandler);

    const invokerRole = options?.invokerRole ?? environment.invokerRole;

    const deployment = new cdk.CustomResource(handler, "RestateServiceDeployment", {
      serviceToken: this.eventHandler.functionArn,
      resourceType: "Custom::RestateServiceDeployment",
      properties: {
        servicePath: serviceName,
        adminUrl: options?.adminUrl ?? environment.adminUrl,
        authTokenSecretArn: authToken?.secretArn,
        serviceLambdaArn: handler.functionArn,
        invokeRoleArn: invokerRole?.roleArn,
        removalPolicy: options?.removalPolicy === cdk.RemovalPolicy.DESTROY ? "destroy" : ("retain" as const),
        private: (options?.private ?? false).toString() as "true" | "false",
        configurationVersion:
          options?.configurationVersion ??
          (handler.functionArn.endsWith(":$LATEST") ? new Date().toISOString() : undefined),
        insecure: (options?.insecure ?? false).toString() as "true" | "false",
        pruneDrainedDeployments: (options?.pruneDrainedDeployments ?? false).toString() as "true" | "false",
        revisionHistoryLimit: options?.revisionHistoryLimit ?? 0,
        maxPrunedPerRun: options?.maxPrunedPerRun ?? 10,
      } satisfies RegistrationProperties,
    });

    if (invokerRole && !options?.skipInvokeFunctionGrant) {
      // We create a separate policy which we'll attach to the provided invoker role. This breaks a circular cross-stack
      // dependency that would otherwise be created between the service deployer and the invoker role.
      if (!this.invocationPolicy) {
        this.invocationPolicy = new iam.Policy(this, "InvocationPolicy");
        // Despite the ARN reference above, CloudFormation sometimes tries to invoke the custom resource handler before
        // all permissions are applied. Adding an explicit dependency includes a dependency on any pending policy updates
        // defined in the same stack as the service deployer, which seems to help. Some propagation delay might still mean
        // we lean on retries in the deployer event handler in any event but this reduces the probability of failure.
        deployment.node.addDependency(this.invocationPolicy);
        this.invocationPolicy.attachToRole(invokerRole);
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
