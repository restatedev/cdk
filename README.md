[![Documentation](https://img.shields.io/badge/doc-reference-blue)](https://docs.restate.dev)
[![Examples](https://img.shields.io/badge/view-examples-blue)](https://github.com/restatedev/examples)
[![Discord](https://img.shields.io/discord/1128210118216007792?logo=discord)](https://discord.gg/skW3AZ6uGd)
[![Twitter](https://img.shields.io/twitter/follow/restatedev.svg?style=social&label=Follow)](https://twitter.com/intent/follow?screen_name=restatedev)

# Restate CDK support

AWS Cloud Development Kit (CDK) construct library for deploying [Restate](https://restate.dev) and Restate services on
AWS. This library helps you when deploying Restate services to AWS Lambda as well as for managing self-hosted Restate
deployments on your own infrastructure. For more information on CDK, please
see [Getting started with the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html).

## Installation

Inside an existing CDK project, add the library from [npm](https://www.npmjs.com/package/@restatedev/restate-cdk):

```shell
npm i @restatedev/restate-cdk
```

## Available constructs

- [`RestateCloudEnvironment`](./lib/restate-constructs/restate-cloud-environment.ts) - Supports deploying Restate
  services to an existing [Restate Cloud](https://cloud.restate.dev) environment.
- [`SingleNodeRestateDeployment`](./lib/restate-constructs/single-node-restate-deployment.ts) - Deploys a self-hosted
  Restate server running on Amazon EC2; this provides a basic single-node deployment targeted at development and testing
- [`ServiceDeployer`](./lib/restate-constructs/service-deployer.ts) - facilitates registration of Lambda-based service
  handlers with a Restate environment, such as a self-hosted EC2 environment

For a more detailed overview, please see
the [Restate CDK documentation](https://docs.restate.dev/deploy/lambda/cdk).

### Examples

You can use the following templates to bootstrap your own CDK projects:

- [typescript-lambda-cdk](https://github.com/restatedev/examples/tree/main/templates/typescript-lambda-cdk)
- [kotlin-gradle-lambda-cdk](https://github.com/restatedev/examples/tree/main/templates/kotlin-gradle-lambda-cdk)
