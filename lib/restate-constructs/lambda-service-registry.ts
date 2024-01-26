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

import { RestateEnvironment } from "./restate-environment";

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
  environment: RestateEnvironment;

  /**
   * Lambda Restate service handlers to deploy.
   */
  handlers: Record<RestatePath, lambda.Function>;
}

/**
 * Manage registration of a set of Lambda-deployed Restate RPC Service handlers with a Restate environment. This
 * construct creates a custom resource which will trigger Restate service discovery on handler function changes.
 */
export class LambdaServiceRegistry extends Construct {
  private readonly registrationProviderToken: cdk.CfnOutput;
  private readonly serviceHandlers: Record<RestatePath, lambda.Function>;

  constructor(scope: Construct, id: string, props: LambdaServiceRegistryProps) {
    super(scope, id);

    if (Object.values(props.handlers).length == 0) {
      throw new Error("Please specify at least one service handler.");
    }

    this.serviceHandlers = props.handlers;
    this.registrationProviderToken = props.environment.registrationProviderToken;
    this.registerServices(props.environment);
  }

  private registerServices(environment: RestateEnvironment) {
    const invokerRole = environment.invokerRole ? iam.Role.fromRoleArn(this, "InvokerRole", environment.invokerRole.roleArn) : undefined;

    if (invokerRole) {
      const allowInvokeFunction = new iam.Policy(this, "AllowInvokeFunction", {
        statements: [
          new iam.PolicyStatement({
            sid: "AllowInvokeAnyFunctionVersion",
            actions: ["lambda:InvokeFunction"],
            resources: Object.values(this.serviceHandlers)
              .map(handler => handler.functionArn + ":*"),
          }),
        ],
      });
      invokerRole.attachInlinePolicy(allowInvokeFunction);
    }

    for (const [path, handler] of Object.entries(this.serviceHandlers)) {
      this.registerHandler({
        adminUrl: environment.adminUrl,
        invokerRoleArn: invokerRole?.roleArn,
        authTokenSecretArn: environment.authToken?.secretArn,
      }, { path, handler }, invokerRole);
    }
  }

  private registerHandler(restate: EnvironmentDetails, service: {
    path: RestatePath,
    handler: lambda.Function
  }, innvokerRole?: iam.IRole) {
    const registrar = new RestateServiceRegistrar(this, service.handler.node.id + "Discovery", {
      environment: restate,
      service,
      serviceToken: this.registrationProviderToken.value,
    });

    if (innvokerRole) {
      // CloudFormation doesn't know that Restate depends on this role to call services; we must ensure that Lambda
      // permission changes are applied before we can trigger discovery (represented by the registrar).
      registrar.node.addDependency(innvokerRole);
    }
  }
}

class RestateServiceRegistrar extends Construct {
  constructor(scope: Construct, id: string,
              props: {
                environment: EnvironmentDetails,
                service: {
                  path: RestatePath,
                  handler: lambda.Function
                },
                serviceToken: string,
              },
  ) {
    super(scope, id);

    new cdk.CustomResource(this, props.service.handler.node.id + "Discovery", {
      serviceToken: props.serviceToken,
      resourceType: "Custom::RestateServiceRegistrar",
      properties: {
        servicePath: props.service.path,
        adminUrl: props.environment.adminUrl,
        authTokenSecretArn: props.environment.authTokenSecretArn,
        serviceLambdaArn: props.service.handler.currentVersion.functionArn,
        invokeRoleArn: props.environment.invokerRoleArn,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      } satisfies RegistrationProperties,
    });
  }
}

interface EnvironmentDetails {
  readonly adminUrl: string;
  readonly invokerRoleArn?: string;
  readonly authTokenSecretArn?: string;
}