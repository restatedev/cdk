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

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { RegistrationProperties } from "./register-service-handler";

import { IRestateEnvironment, RestateEnvironment } from "./restate-environment";

/**
 * A Restate RPC service path. Example: `greeter`.
 */
export type RestatePath = string;

/**
 * Manage registration of a set of Lambda-deployed Restate RPC Service handlers with a Restate environment.
 */
export type LambdaServiceRegistryProps = {
  /**
   * Custom resource provider token required for service discovery.
   */
  environment: IRestateEnvironment;

  /**
   * Lambda Restate service handlers to deploy.
   */
  handlers: Record<RestatePath, lambda.Function>;
};

/**
 * Manage registration of a set of Lambda-deployed Restate RPC Service handlers with a Restate environment. This
 * construct creates a custom resource which will trigger Restate service discovery on handler function changes.
 *
 * @deprecated use {@link ServiceDeployer.deployService} instead
 */
export class LambdaServiceRegistry extends Construct {
  private readonly deployerServiceToken: string;
  private readonly serviceHandlers: Record<RestatePath, lambda.Function>;

  constructor(scope: Construct, id: string, props: LambdaServiceRegistryProps) {
    super(scope, id);

    if (Object.values(props.handlers).length == 0) {
      throw new Error("Please specify at least one service handler.");
    }

    this.serviceHandlers = props.handlers;
    this.deployerServiceToken = props.environment.serviceDeployer.deploymentResourceProvider.serviceToken;
    this.registerServices(props.environment);
  }

  private registerServices(environment: RestateEnvironment) {
    const invokerRole = environment.invokerRole
      ? iam.Role.fromRoleArn(this, "InvokerRole", environment.invokerRole.roleArn)
      : undefined;

    if (invokerRole) {
      const allowInvokeFunction = new iam.Policy(this, "AllowInvokeFunction", {
        statements: [
          new iam.PolicyStatement({
            sid: "AllowInvokeAnyFunctionVersion",
            actions: ["lambda:InvokeFunction"],
            resources: Object.values(this.serviceHandlers).map((handler) => handler.functionArn + ":*"),
          }),
        ],
      });
      invokerRole.attachInlinePolicy(allowInvokeFunction);
    }

    for (const [path, handler] of Object.entries(this.serviceHandlers)) {
      this.registerHandler(
        {
          adminUrl: environment.adminUrl,
          invokerRoleArn: invokerRole?.roleArn,
          authTokenSecretArn: environment.authToken?.secretArn,
        },
        { path, handler },
        invokerRole,
      );
    }
  }

  private registerHandler(
    deploymentMetadata: DeploymentMetadata,
    service: {
      path: RestatePath;
      handler: lambda.Function;
    },
    invokerRole?: iam.IRole,
  ) {
    // We create a unique custom resource for each service handler. This way CloudFormation triggers an update to the
    // specific deployment resource whenever it makes a change to the handler Lambda. The logical resource is named
    // "<HandlerFunction>Deployment" since it represents the specific service deployment in the Restate environment.
    const deployment = lambdaServiceDeployment({
      deploymentMetadata,
      service,
      deployerServiceToken: this.deployerServiceToken,
    });

    if (invokerRole) {
      // CloudFormation doesn't know that Restate depends on this role to call services; we must ensure that Lambda
      // permission changes are applied before we can trigger discovery.
      deployment.node.addDependency(invokerRole);
    }
  }
}

function lambdaServiceDeployment(props: {
  deploymentMetadata: DeploymentMetadata;
  service: {
    path: RestatePath;
    handler: lambda.Function;
  };
  deployerServiceToken: string;
}) {
  return new cdk.CustomResource(props.service.handler, "RestateDeployment", {
    serviceToken: props.deployerServiceToken,
    resourceType: "Custom::RestateServiceDeployment",
    properties: {
      servicePath: props.service.path,
      adminUrl: props.deploymentMetadata.adminUrl,
      authTokenSecretArn: props.deploymentMetadata.authTokenSecretArn,
      serviceLambdaArn: props.service.handler.currentVersion.functionArn,
      invokeRoleArn: props.deploymentMetadata.invokerRoleArn,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    } satisfies RegistrationProperties,
  });
}

/**
 * Minimal deployment metadata required for Restate service registration.
 */
interface DeploymentMetadata {
  readonly adminUrl: string;
  readonly invokerRoleArn?: string;
  readonly authTokenSecretArn?: string;
}
