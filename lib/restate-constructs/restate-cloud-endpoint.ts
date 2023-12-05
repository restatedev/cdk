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
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-secretsmanager";
import { RestateInstance } from "./restate-instance";
import { RegistrationProvider } from "./registration-provider";

const RESTATE_INGRESS_PORT = 8080;
const RESTATE_META_PORT = 9070;

export interface ManagedRestateProps {
  /** Prefix for resources created by this construct that require unique names. */
  prefix?: string;

  /** ID of the Restate service cluster to which this service will be registered. */
  clusterId: string;

  /** Auth token to use with Restate cluster. Used to authenticate access to the meta endpoint for registration. */
  authTokenSecretArn: string;
}

/**
 * Models a Restate managed service cluster provided to the application. In the case of a managed service, this
 * construct only creates an appropriately configured registration provider custom component for use by the service
 * registry elsewhere, and creates the role assumed by the cluster. An appropriate trust policy will be added to this
 * role that allows Restate to assume it from outside the deployment AWS account.
 */
export class RestateCloudEndpoint extends Construct implements RestateInstance {
  readonly invokerRole: iam.Role;
  readonly ingressEndpoint: string;
  readonly metaEndpoint: string;
  readonly authToken: ssm.ISecret;
  readonly registrationProviderToken: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ManagedRestateProps) {
    super(scope, id);

    this.invokerRole = new iam.Role(this, "ManagedServiceRole", {
      description: "Role assumed by the Restate managed service to invoke our services",
      assumedBy: new iam.ArnPrincipal("arn:aws:iam::663487780041:role/restate-dev"),
      externalIds: [props.clusterId],
    });

    this.ingressEndpoint = `https://${props.clusterId}.dev.restate.cloud:${RESTATE_INGRESS_PORT}`;
    this.metaEndpoint = `https://${props.clusterId}.dev.restate.cloud:${RESTATE_META_PORT}`;
    this.authToken = ssm.Secret.fromSecretCompleteArn(this, "ClusterAuthToken", props.authTokenSecretArn);

    const registrationProvider = new RegistrationProvider(this, "RegistrationProvider", { authToken: this.authToken });
    this.registrationProviderToken = new cdk.CfnOutput(this, "RegistrationProviderToken", {
      description: "Restate service registration provider custom component token used by registry to perform discovery",
      exportName: [props.prefix, "RegistrationProviderToken"].filter(Boolean).join("-"),
      value: registrationProvider.serviceToken,
    });
  }
}