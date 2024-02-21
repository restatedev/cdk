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

import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-secretsmanager";
import { IRestateEnvironment, RestateEnvironment } from "./restate-environment";
import { RegistrationProvider } from "./registration-provider";

const RESTATE_INGRESS_PORT = 8080;
const RESTATE_ADMIN_PORT = 9070;

export interface RestateCloudEnvironmentProps {
  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** ID of the Restate service cluster to which this service will be registered. */
  clusterId: string;

  /** Auth token for Restate environment. Used with the admin service for service deployment registration. */
  authTokenSecretArn: string;
}

/**
 * Restate Managed cluster deployment. This construct manages the role in the deployment environment that
 * Restate Cloud assumes to call registered services, and provides the service registration helper for Lambda-based
 * handlers. An appropriate trust policy will be added to this role that allows Restate to assume it from outside the
 * deployment AWS account.
 *
 * @deprecated Use {@link RestateEnvironment.fromAttributes} instead.
 */
export class RestateCloudEnvironment extends Construct implements IRestateEnvironment {
  readonly invokerRole: iam.Role;
  readonly ingressUrl: string;
  readonly adminUrl: string;
  readonly authToken: ssm.ISecret;
  readonly registrationProvider: RegistrationProvider;

  constructor(scope: Construct, id: string, props: RestateCloudEnvironmentProps) {
    super(scope, id);

    // This role should be easier to customize or override completely: https://github.com/restatedev/cdk/issues/21
    this.invokerRole = new iam.Role(this, "RestateServiceInvokerRole", {
      description: "Role assumed by Restate Cloud when invoking Lambda service handlers",
      assumedBy: new iam.ArnPrincipal("arn:aws:iam::663487780041:role/restate-dev"),
      externalIds: [props.clusterId],
    });

    this.ingressUrl = `https://${props.clusterId}.dev.restate.cloud:${RESTATE_INGRESS_PORT}`;
    this.adminUrl = `https://${props.clusterId}.dev.restate.cloud:${RESTATE_ADMIN_PORT}`;
    this.authToken = ssm.Secret.fromSecretCompleteArn(this, "ClusterAuthToken", props.authTokenSecretArn);

    this.registrationProvider = new RegistrationProvider(this, "RegistrationProvider", { authToken: this.authToken });
  }
}
