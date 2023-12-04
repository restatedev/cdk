import * as iam from "aws-cdk-lib/aws-iam";
import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-secretsmanager";

/**
 * Represents an instance of the Restate service. This could represent a self-hosted broker, or Restate's managed
 * service.
 */
export interface RestateInstance {
  readonly invokerRole: iam.Role;
  readonly metaEndpoint: string;
  readonly authToken?: ssm.ISecret;
  readonly registrationProviderToken: cdk.CfnOutput;
}