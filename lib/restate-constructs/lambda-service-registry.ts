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
type RestatePath = string;

export interface RestateInstanceRef {
  readonly adminUrl: string;
  readonly invokerRoleArn: string;
  readonly authTokenSecretArn?: string;
}

/**
 * A collection of Lambda Restate RPC Service handlers.
 */
export type LambdaServiceRegistryProps = {
  /**
   * Mappings from service path to Lambda handler.
   */
  serviceHandlers: Record<RestatePath, lambda.Function>;

  /**
   * Custom resource provider token required for service discovery.
   */
  restate: RestateEnvironment;
}

/**
 * Represents a collection of Lambda-based Restate RPC services. This component is used to register
 * them with a single Restate instance. This creates a custom resource which will trigger service
 * discovery on any handler changes deployed through CDK/CloudFormation.
 */
export class LambdaServiceRegistry extends Construct {
  private readonly serviceHandlers: Record<RestatePath, lambda.Function>;
  private readonly registrationProviderToken: string;

  constructor(scope: Construct, id: string, props: LambdaServiceRegistryProps) {
    super(scope, id);

    if (Object.values(props.serviceHandlers).length == 0) {
      throw new Error("Please specify at least one service handler.");
    }

    this.serviceHandlers = props.serviceHandlers;
    this.registrationProviderToken = props.restate.registrationProviderToken.value;
  }

  public register(restate: RestateInstanceRef) {
    const invokerRole = iam.Role.fromRoleArn(this, "InvokerRole", restate.invokerRoleArn);

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

    for (const [path, handler] of Object.entries(this.serviceHandlers)) {
      this.registerHandler(restate, { path, handler }, allowInvokeFunction);
    }
  }

  private registerHandler(restate: RestateInstanceRef, service: {
    path: RestatePath,
    handler: lambda.Function
  }, allowInvokeFunction: iam.Policy) {
    const registrar = new RestateServiceRegistrar(this, service.handler.node.id + "Discovery", {
      restate,
      service,
      serviceToken: this.registrationProviderToken,
    });

    // CloudFormation doesn't know that Restate depends on this role to call services; we must ensure that Lambda
    // permission changes are applied before we can trigger discovery (represented by the registrar).
    registrar.node.addDependency(allowInvokeFunction);
  }
}

class RestateServiceRegistrar extends Construct {
  constructor(scope: Construct, id: string,
              props: {
                restate: RestateInstanceRef,
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
        adminUrl: props.restate.adminUrl,
        authTokenSecretArn: props.restate.authTokenSecretArn,
        serviceLambdaArn: props.service.handler.currentVersion.functionArn,
        invokeRoleArn: props.restate.invokerRoleArn,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      } satisfies RegistrationProperties,
    });
  }
}