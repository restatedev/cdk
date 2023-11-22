# Restate CDK support

CDK construct library for deploying standalone [Restate](https://restate.dev) and Restate service handlers to AWS.

## Deploying the demo project

To deploy the self-hosted Restate instance, run:

```shell
npx cdk deploy
```

By default, this will create a stack prefixed with the value of `$USER` - you can override this using the CDK context
parameter `prefix` like this:

```shell
npx cdk deploy --context prefix="dev"
```

You will be prompted to confirm the creation of new security-sensitive resources.

Use the value of the `RestateIngressEndpoint` output of the CloudFormation stack to communicate with the Restate
broker (if you customized the deployment prefix above, you will need to update the stack name):

```shell
export RESTATE_INGRESS_ENDPOINT=$(aws cloudformation describe-stacks --stack-name ${USER}-RestateStack \
    --query "Stacks[0].Outputs[?OutputKey=='RestateIngressEndpoint'].OutputValue" --output text)
```

```shell
curl -X POST -w \\n ${RESTATE_INGRESS_ENDPOINT}/Greeter/greet -H 'content-type: application/json' -d '{"key": "Restate"}'
```

You will get output similar to the following:

```json
{
  "response": "Hello, Restate! :-)"
}
```