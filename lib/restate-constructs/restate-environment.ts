import * as iam from "aws-cdk-lib/aws-iam";
import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-secretsmanager";

/**
 * A Restate environment is a distinct deployment target. These could be an isolated environment in Restate Cloud, or
 * a self-hosted deployment.
 */
export interface RestateEnvironment {
  readonly invokerRole: iam.IRole;
  readonly adminUrl: string;
  readonly authToken?: ssm.ISecret;
  readonly registrationProviderToken: cdk.CfnOutput;
}