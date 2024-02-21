import * as iam from "aws-cdk-lib/aws-iam";
import { IRole } from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-secretsmanager";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { FunctionOptions } from "aws-cdk-lib/aws-lambda";
import { RegistrationProvider } from "./registration-provider";

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
  readonly authToken?: ssm.ISecret;

  /**
   * A reference to the Restate Custom Resource performing handler deployment.
   *
   * @see RegistrationProvider
   */
  readonly registrationProvider: RegistrationProvider;
}

export class RestateEnvironment implements IRestateEnvironment {
  readonly adminUrl: string;
  readonly authToken?: ISecret;
  readonly invokerRole?: IRole;
  readonly registrationProvider: RegistrationProvider;

  private constructor(scope: Construct, id: string, props: IRestateEnvironment) {
    this.adminUrl = props.adminUrl;
    this.invokerRole = props.invokerRole;
    this.authToken = props.authToken;
    this.registrationProvider = props.registrationProvider;
  }

  static fromAttributes(scope: Construct, id: string, attrs: IRestateEnvironment): IRestateEnvironment {
    return new RestateEnvironment(scope, id, attrs);
  }
}
