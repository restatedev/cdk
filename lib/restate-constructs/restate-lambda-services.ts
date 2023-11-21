import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as api_gw from "aws-cdk-lib/aws-apigateway";
import { SingleNodeRestateInstance } from "./single-node-restate-instance";
import * as cdk from "aws-cdk-lib";

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
    service.handler.grantInvoke(restate.instanceRole); // Grants invoke permissions on all versions & aliases
    service.handler.currentVersion.grantInvoke(restate.instanceRole); // CDK ack doesn't work; this is silences warning

    const serviceHttpResource = restate.serviceApi.root.addResource(service.path);
    serviceHttpResource.addProxy({
      defaultIntegration: new api_gw.LambdaIntegration(service.handler),
      anyMethod: true,
    });

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
        ingressEndpoint: props.restate.privateIngressEndpoint,
        metaEndpoint: props.restate.metaEndpoint,
        serviceEndpoint: props.restate.serviceApi.urlForPath(`/${props.service.path}`),
        functionVersion: props.service.handler.currentVersion.version,
        // TODO: force a refresh on EC2 instance configuration changes, too (https://github.com/restatedev/restate-cdk-support/issues/4)
      },
    });
  }
}