import * as iam from "aws-cdk-lib/aws-iam";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { IRestateEnvironment, RestateEnvironment } from "./restate-environment";
import { ServiceDeployer } from "./service-deployer";

/**
 * Configuration for a Restate Cloud environment.
 */
export interface RestateCloudEnvironmentProps {
  /**
   * Unique id of the environment (including the `env_` prefix).
   */
  readonly environmentId: EnvironmentId;

  /**
   * API key with administrative permissions. Used to manage services to the environment, see {@link ServiceDeployer}.
   */
  readonly apiKey: secrets.ISecret;
}

/**
 * A distinct Restate Cloud environment reference. This is a convenience utility for deploying to the
 * [Restate Cloud](https://cloud.restate.dev/) hosted service.
 */
export class RestateCloudEnvironment extends Construct implements IRestateEnvironment {
  readonly adminUrl: string;
  readonly ingressUrl: string;
  readonly authToken: secrets.ISecret;
  readonly invokerRole: iam.IRole;

  /**
   * Constructs a Restate Cloud environment reference along with invoker. Note that this construct is only a pointer to
   * an existing Restate Cloud environment and does not create it. However, it does create an invoker role that is used
   * invoking Lambda service handlers. If you would prefer to directly manage the invoker role permissions, you can
   * override the {@link createInvokerRole} method or construct one yourself and define the environment properties with
   * {@link RestateEnvironment.fromAttributes} directly.
   *
   * @param scope parent construct
   * @param id construct id
   * @param props environment properties
   * @returns Restate Cloud environment
   */
  constructor(scope: Construct, id: string, props: RestateCloudEnvironmentProps) {
    super(scope, id);
    this.invokerRole = this.createInvokerRole(this, props);
    this.authToken = props.apiKey;
    this.adminUrl = adminEndpoint(RESTATE_CLOUD_REGION_US, props.environmentId);
    this.ingressUrl = ingressEndpoint(RESTATE_CLOUD_REGION_US, props.environmentId);
  }

  /**
   * This role is used by Restate to invoke Lambda service handlers; see https://docs.restate.dev/deploy/cloud for
   * information on deploying services to Restate Cloud environments. For standalone environments, the EC2 instance
   * profile can be used directly instead of creating a separate role.
   */
  protected createInvokerRole(scope: Construct, props: RestateCloudEnvironmentProps): iam.IRole {
    const invokerRole = new iam.Role(scope, "InvokerRole", {
      assumedBy: new iam.AccountPrincipal(CONFIG[RESTATE_CLOUD_REGION_US].accountId).withConditions({
        StringEquals: {
          "sts:ExternalId": props.environmentId,
          "aws:PrincipalArn": CONFIG[RESTATE_CLOUD_REGION_US].principalArn,
        },
      }),
    });
    invokerRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        principals: [new iam.AccountPrincipal("654654156625")],
        actions: ["sts:TagSession"],
      }),
    );
    return invokerRole;
  }
}

function adminEndpoint(region: RestateCloudRegion, environmentId: EnvironmentId): string {
  const bareEnvId = environmentId.replace(/^env_/, "");
  return `https://${bareEnvId}.env.${region}.restate.cloud:9070`;
}

function ingressEndpoint(region: RestateCloudRegion, environmentId: EnvironmentId): string {
  const bareEnvId = environmentId.replace(/^env_/, "");
  return `https://${bareEnvId}.env.${region}.restate.cloud`;
}

export type EnvironmentId = `env_${string}`;
type RestateCloudRegion = "us";

interface RegionConfig {
  accountId: string;
  principalArn: string;
}

const RESTATE_CLOUD_REGION_US = "us";

const CONFIG = {
  us: {
    accountId: "654654156625",
    principalArn: "arn:aws:iam::654654156625:role/RestateCloud",
  },
} as Record<RestateCloudRegion, RegionConfig>;
