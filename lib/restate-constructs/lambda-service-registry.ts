import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { RegistrationProperties } from "./register-service-handler";

/**
 * A Restate RPC service path. Example: `greeter`.
 */
type RestatePath = string;

export interface RestateInstanceRef {
  readonly metaEndpoint: string;
  readonly invokerRoleArn: string;
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
  registrationProviderToken: string;
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

    this.serviceHandlers = props.serviceHandlers;
    this.registrationProviderToken = props.registrationProviderToken;
  }

  public register(restate: RestateInstanceRef) {
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

    const invokerRole = iam.Role.fromRoleArn(this, "InvokerRole", restate.invokerRoleArn);
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
                serviceToken: string
              },
  ) {
    super(scope, id);

    new cdk.CustomResource(this, props.service.handler.node.id + "Discovery", {
      serviceToken: props.serviceToken,
      resourceType: "Custom::RestateServiceRegistrar",
      properties: {
        servicePath: props.service.path,
        metaEndpoint: props.restate.metaEndpoint,
        serviceLambdaArn: props.service.handler.currentVersion.functionArn,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      } satisfies RegistrationProperties,
    });
  }
}