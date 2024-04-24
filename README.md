[![Documentation](https://img.shields.io/badge/doc-reference-blue)](https://docs.restate.dev)
[![Examples](https://img.shields.io/badge/view-examples-blue)](https://github.com/restatedev/examples)
[![Discord](https://img.shields.io/discord/1128210118216007792?logo=discord)](https://discord.gg/skW3AZ6uGd)
[![Twitter](https://img.shields.io/twitter/follow/restatedev.svg?style=social&label=Follow)](https://twitter.com/intent/follow?screen_name=restatedev)

# Restate CDK support

AWS Cloud Development Kit (CDK) construct library for deploying [Restate](https://restate.dev) and Restate services on
AWS. This library helps you when deploying Restate services to AWS Lambda as well as for managing self-hosted Restate
deployments on your own infrastructure. For more information on CDK, please
see [Getting started with the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html).

## Available constructs

- [`LambdaServiceRegistry`](./lib/restate-constructs/lambda-service-registry.ts) - A collection of Lambda-deployed
  Restate services, this construct automatically registers the latest function version as a new deployment revision in a
  Restate instance
- [`SingleNodeRestateDeployment`](./lib/restate-constructs/single-node-restate-deployment.ts) - Deploys a self-hosted
  Restate instance on EC2; note this is a single-node deployment targeted at development and testing
- [`RestateCloudEnvironment`](./lib/restate-constructs/restate-cloud-environment.ts) - A Restate Cloud instance

For a more detailed overview, please see
the [Restate CDK documentation](https://docs.restate.dev/deploy/lambda/cdk).

### Examples

You can use the following examples as references for your own CDK projects:

- [hello-world-lambda-cdk](https://github.com/restatedev/examples/tree/main/kotlin/hello-world-lambda-cdk) - Kotlin
  service deployed to AWS Lambda
- [Restate Holiday](https://github.com/restatedev/restate-holiday) - a more complex example of a fictional reservation
  service demonstrating the Saga orchestration pattern
