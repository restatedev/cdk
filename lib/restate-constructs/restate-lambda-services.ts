import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SingleNodeRestateInstance } from "./single-node-restate-instance";
import * as cdk from "aws-cdk-lib";
import { RegistrationProperties } from "./lambda/register-service-handler";

/**
 * A Restate RPC service path. Example: `greeter`.
 */
type RestatePath = string;

/**
 * A collection of Lambda Restate RPC Service handlers.
 */
export type LambdaServiceCollectionProps = {
  /**
   * Mappings from service path to Lambda handler.
   */
  serviceHandlers: Record<RestatePath, lambda.Function>;
}

/**
 * Creates a Restate service deployment backed by a single EC2 instance,
 * suitable for development and testing purposes.
 */
export class RestateLambdaServiceCollection extends Construct {
  private readonly serviceHandlers: Record<RestatePath, lambda.Function>;

  constructor(scope: Construct, id: string, props: LambdaServiceCollectionProps) {
    super(scope, id);
    this.serviceHandlers = props.serviceHandlers;
  }

  public register(restate: SingleNodeRestateInstance) {
    for (const [path, handler] of Object.entries(this.serviceHandlers)) {
      this.registerHandler(restate, { path, handler });
    }
  }

  private registerHandler(restate: SingleNodeRestateInstance, service: {
    path: RestatePath,
    handler: lambda.Function
  }) {
    cdk.Annotations.of(service.handler).acknowledgeWarning("@aws-cdk/aws-lambda:addPermissionsToVersionOrAlias",
      "We specifically want to grant invoke permissions on all handler versions, " +
      "not just the currently deployed one, as there may be suspended invocations against older versions");
    service.handler.currentVersion.grantInvoke(restate.instanceRole); // CDK ack doesn't work, silence above warning
    service.handler.grantInvoke(restate.instanceRole); // Grants access to all handler versions for ongoing invocations

    new RestateServiceRegistrar(this, service.handler.node.id + "Discovery", { restate, service });
  }
}

class RestateServiceRegistrar extends Construct {
  constructor(scope: Construct, id: string, props: {
    restate: SingleNodeRestateInstance, service: {
      path: RestatePath,
      handler: lambda.Function
    }
  }) {
    super(scope, id);

    new cdk.CustomResource(this, props.service.handler.node.id + "Discovery", {
      serviceToken: props.restate.serviceDiscoveryProvider.serviceToken,
      resourceType: "Custom::RestateServiceRegistrar",
      properties: {
        metaEndpoint: props.restate.metaEndpoint,
        serviceLambdaArn: props.service.handler.currentVersion.functionArn,
      } satisfies RegistrationProperties,
    });
  }
}