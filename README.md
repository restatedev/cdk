# Restate CDK support

CDK construct library for deploying standalone [Restate](https://restate.dev) and Restate service handlers to AWS.

## Deploying the demo project

In order to access the Restate Docker image, you need to make a GitHub access token with permission to retrieve the
Restate beta distribution available in your AWS account.

```sh
aws secretsmanager create-secret --name /restate/docker/github-token --secret-string $GITHUB_TOKEN
```