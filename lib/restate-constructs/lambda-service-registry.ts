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

  registrationProviderToken?: string;
}

/**
 * Represents a collection of Lambda-based Restate RPC services. This component is used to register
 * them with a single Restate instance. This creates a custom resource which will trigger service
 * discovery on any handler changes deployed through CDK/CloudFormation.
 */
export class LambdaServiceRegistry extends Construct {
  private readonly serviceHandlers: Record<RestatePath, lambda.Function>;
  private readonly registrationProviderToken?: string;

  constructor(scope: Construct, id: string, props: LambdaServiceRegistryProps) {
    super(scope, id);

    this.serviceHandlers = props.serviceHandlers;
    this.registrationProviderToken = props.registrationProviderToken;
  }

  public register(restate: RestateInstanceRef) {
    for (const [path, handler] of Object.entries(this.serviceHandlers)) {
      this.registerHandler(restate, { path, handler });
    }
  }

  private registerHandler(restate: RestateInstanceRef, service: {
    path: RestatePath,
    handler: lambda.Function
  }) {
    const invokerRole = iam.Role.fromRoleArn(this, service.handler.node.id + "InvokerRole", restate.invokerRoleArn);
    cdk.Annotations.of(service.handler).acknowledgeWarning("@aws-cdk/aws-register-service-handler:addPermissionsToVersionOrAlias",
      "We specifically want to grant invoke permissions on all handler versions, " +
      "not just the currently deployed one, as there may be suspended invocations against older versions");
    service.handler.currentVersion.grantInvoke(invokerRole); // CDK ack doesn't work, this silences the warning above
    service.handler.grantInvoke(invokerRole); // Grants access to all handler versions for ongoing invocations

    new RestateServiceRegistrar(this, service.handler.node.id + "Discovery", {
      restate,
      service,
      serviceToken: this.registrationProviderToken!,
    });
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
        metaEndpoint: props.restate.metaEndpoint,
        serviceLambdaArn: props.service.handler.currentVersion.functionArn,
      } satisfies RegistrationProperties,
    });
    // TODO: add a dependency on attaching Lambda invocation permissions to the Restate instance role
  }
}