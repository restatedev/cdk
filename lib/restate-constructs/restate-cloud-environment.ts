/*
 * Copyright (c) 2024 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

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

  /**
   * Region of the environment. Defaults to `us`. Valid values: [`us`, `eu`].
   */
  readonly region?: RestateCloudRegion;
}

/**
 * A distinct Restate Cloud environment reference. This is a convenience utility for deploying to the
 * [Restate Cloud](https://cloud.restate.dev/) hosted service.
 */
export class RestateCloudEnvironment extends Construct implements IRestateEnvironment {
  readonly environmentId: EnvironmentId;
  readonly adminUrl: string;
  readonly ingressUrl: string;
  readonly authToken: secrets.ISecret;
  readonly invokerRole: iam.IRole;
  readonly region: RestateCloudRegion;

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
    this.environmentId = props.environmentId;
    this.region = props.region ?? RESTATE_CLOUD_REGION_US;
    this.invokerRole = this.createInvokerRole(this, props);
    this.authToken = props.apiKey;
    this.adminUrl = adminEndpoint(this.region, props.environmentId);
    this.ingressUrl = ingressEndpoint(this.region, props.environmentId);
  }

  /**
   * Creates a reference to an existing Restate Cloud environment. Unlike instantiating the construct, this variant does
   * not attempt to create an invoker role, but still returns an Environment object which can be used to deploy
   * services.
   *
   * @param props environment properties - only `environmentId` and `authToken` are required
   */
  static fromAttributes(props: {
    environmentId: EnvironmentId;
    apiKey: secrets.ISecret;
    invokerRole: iam.IRole;
    region?: RestateCloudRegion;
    adminUrl?: string;
  }) {
    const region = props?.region ?? RESTATE_CLOUD_REGION_US;
    return RestateEnvironment.fromAttributes({
      invokerRole: props?.invokerRole,
      adminUrl: props?.adminUrl ?? adminEndpoint(region, props.environmentId),
      authToken: props?.apiKey,
    });
  }

  /**
   * This role is used by Restate to invoke Lambda service handlers; see https://docs.restate.dev/deploy/cloud for
   * information on deploying services to Restate Cloud environments. For standalone environments, the EC2 instance
   * profile can be used directly instead of creating a separate role.
   */
  protected createInvokerRole(scope: Construct, props: RestateCloudEnvironmentProps): iam.IRole {
    const invokerRole = new iam.Role(scope, "InvokerRole", {
      assumedBy: new iam.AccountPrincipal(CONFIG[this.region].accountId).withConditions({
        StringEquals: {
          "sts:ExternalId": props.environmentId,
          "aws:PrincipalArn": CONFIG[this.region].principalArn,
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
export type RestateCloudRegion = "us" | "eu";

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
  eu: {
    accountId: "654654156625",
    principalArn: "arn:aws:iam::654654156625:role/RestateCloud",
  },
} as Record<RestateCloudRegion, RegionConfig>;
