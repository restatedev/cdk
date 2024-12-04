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
import { FunctionOptions } from "aws-cdk-lib/aws-lambda";
import { ServiceDeployer } from "./service-deployer";
import { SingleNodeRestateDeployment } from "./single-node-restate-deployment";
import { RestateCloudEnvironment } from "./restate-cloud-environment";

/**
 * A Restate environment is a unique deployment of the Restate service. Implementations of this interface may refer to
 * cloud or self-managed environments.
 */
export interface IRestateEnvironment extends Pick<FunctionOptions, "vpc" | "vpcSubnets" | "securityGroups"> {
  /**
   * The external invoker role that Restate can assume to execute service handlers. If left unset, it's assumed that
   * the Restate deployment has sufficient permissions to invoke the service handlers directly. Setting this role allows
   * the constructs to ensure appropriate permissions are granted to any deployed service handlers.
   */
  readonly invokerRole?: iam.IRole;

  /**
   * The admin endpoint of the Restate environment where services will be deployed.
   */
  readonly adminUrl: string;

  /**
   * Authentication token to include as a bearer token in requests to the admin endpoint.
   */
  readonly authToken?: secrets.ISecret;
}

/**
 * A reference to a Restate Environment that can be used as a target for deploying services. Use {@link fromAttributes}
 * to instantiate an arbitrary pointer to an existing environment, or one of the {@link SingleNodeRestateDeployment} or
 * {@link RestateCloudEnvironment} convenience classes.
 */
export class RestateEnvironment implements IRestateEnvironment {
  readonly adminUrl: string;
  readonly authToken?: secrets.ISecret;
  readonly invokerRole?: iam.IRole;

  private constructor(props: IRestateEnvironment) {
    this.adminUrl = props.adminUrl;
    this.invokerRole = props.invokerRole;
    this.authToken = props.authToken;
  }

  static fromAttributes(props: IRestateEnvironment): IRestateEnvironment {
    return new RestateEnvironment(props);
  }
}
