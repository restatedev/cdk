[![Documentation](https://img.shields.io/badge/doc-reference-blue)](https://docs.restate.dev)
[![Examples](https://img.shields.io/badge/view-examples-blue)](https://github.com/restatedev/examples)
[![Discord](https://img.shields.io/discord/1128210118216007792?logo=discord)](https://discord.gg/skW3AZ6uGd)
[![Twitter](https://img.shields.io/twitter/follow/restatedev.svg?style=social&label=Follow)](https://twitter.com/intent/follow?screen_name=restatedev)

# Restate CDK Construct Library

AWS Cloud Development Kit (CDK) construct library for deploying [Restate](https://restate.dev) and
Restate services on AWS.

[Restate](https://github.com/restatedev/restate) is the platform for building resilient applications
that tolerate all infrastructure faults w/o the need for a PhD. For more information on CDK, please
see [Getting started with the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html).

This library helps you manage registering AWS Lambda-based Restate services in Restate environments.
It also offers basic support for creating self-hosted Restate deployments on your own AWS infrastructure.

## Installation

Inside an existing CDK project, add the library from [npm](https://www.npmjs.com/package/@restatedev/restate-cdk):

```shell
npm i @restatedev/restate-cdk
```

## Available constructs

- [`RestateCloudEnvironment`](./lib/restate-constructs/restate-cloud-environment.ts) - Supports deploying Restate
  services to an existing [Restate Cloud](https://cloud.restate.dev) environment.
- [`SingleNodeRestateDeployment`](./lib/restate-constructs/single-node-restate-deployment.ts) - Deploys a self-hosted
  Restate server running on Amazon EC2; this provides a basic single-node deployment targeted at
  development and testing
- [`ServiceDeployer`](./lib/restate-constructs/service-deployer.ts) - facilitates registration of Lambda-based service
  handlers with a Restate environment, such as a self-hosted EC2 environment
- [`RestateFargateService`](./lib/restate-constructs/restate-fargate-service.ts) - runs a Restate service on ECS
  Fargate with one immutable, separately addressable version per release, like Lambda versions; see below

For a more detailed look, please refer to the [Restate CDK documentation](https://docs.restate.dev/deploy/services/faas/lambda/cdk).

## Versioned services on ECS Fargate

Restate pins every invocation to the deployment that started it, so an old version of a service must keep serving
until its invocations finish, which for workflows can take days. Lambda gives every version its own ARN. On ECS
Fargate, `RestateFargateService` gives you the same:

- Every change to the task definition (code, image, environment) creates a new version: its own ECS service, HTTP/2
  target group and load balancer rule, reachable at its own path, and registered with Restate as a new deployment.
- New invocations go to the newest version. In-flight and suspended invocations finish on the version that started
  them.
- Superseded versions scale down to one task, and are deleted once Restate shows nothing left on them.
- A CloudFormation rollback moves new invocations back to the previous version.

### Usage

```ts
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import { RestateEnvironment, RestateFargateService, ServiceDeployer } from "@restatedev/restate-cdk";

// The Restate environment the service registers with.
const environment = RestateEnvironment.fromAttributes({
  adminUrl: "https://restate-admin.internal.example.com:9070",
  authToken: secrets.Secret.fromSecretNameV2(this, "AdminToken", "restate/admin-token"),
});

// Registers versions, and scales down and removes superseded ones. It must reach the Restate admin API.
const deployer = new ServiceDeployer(this, "ServiceDeployer", { vpc });

// An internal ALB that Restate can reach. Each version adds one rule to the listener.
const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
  vpc,
  internetFacing: false,
  idleTimeout: cdk.Duration.seconds(900), // above Restate's inactivity + abort timeouts, see below
});
const listener = alb.addListener("Https", {
  port: 443,
  certificates: [acm.Certificate.fromCertificateArn(this, "Cert", certificateArn)],
  open: false,
  defaultAction: elbv2.ListenerAction.fixedResponse(404),
});
alb.connections.allowFrom(restateNodes, ec2.Port.tcp(443));

const taskDefinition = new ecs.FargateTaskDefinition(this, "Task", { cpu: 512, memoryLimitMiB: 1024 });
taskDefinition.addContainer("app", {
  image: ecs.ContainerImage.fromAsset("./service"), // or an image pinned by digest
  portMappings: [{ containerPort: 9080 }],
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: "orders" }),
});

const orders = new RestateFargateService(this, "Orders", {
  cluster: new ecs.Cluster(this, "Cluster", { vpc }),
  taskDefinition,
  listener,
  baseUrl: "https://handlers.internal.example.com", // how Restate reaches the ALB; matches the certificate
  environment,
  deployer,
  desiredCount: 3,
});

// The current version is an ordinary ecs.FargateService, so the usual CDK APIs apply to it.
orders.currentVersion.service
  .autoScaleTaskCount({ minCapacity: 3, maxCapacity: 10 })
  .scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 60 });
```

The service itself is an ordinary Restate SDK endpoint listening on port 9080 (`restate.serve(...)` in TypeScript,
`server.NewRestate()...Start(ctx, ":9080")` in Go). It needs no changes for this construct: the load balancer strips
the version path before the request reaches it.

A complete, deployable stack with a self-hosted Restate node is in
[test/e2e/stacks/fargate-service-stack.ts](test/e2e/stacks/fargate-service-stack.ts).

### Requirements

| What                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An ALB with an HTTPS listener that Restate can reach, with a certificate Restate trusts                                                                                                                              | Restate speaks HTTP/2 to the ALB, which needs TLS. Each version gets one listener rule and one HTTP/2 target group                                                                                                                     |
| ALB idle timeout above Restate's inactivity plus abort timeouts: 60 s + 600 s by default, so for example `idleTimeout: Duration.seconds(900)`                                                                        | A step that sends nothing for longer than the idle timeout is reset by the ALB and retried forever. If your services raise these timeouts, raise the idle timeout too. The construct warns at synth time when it can see a lower value |
| Container images from CDK assets or pinned by digest; no CloudFormation parameters, imports or `{{resolve:...}}` references in the task definition                                                                   | Each of these can change what runs without a new version. Synthesis fails otherwise                                                                                                                                                    |
| The `ServiceDeployer` Lambda can reach the Restate admin API and these AWS APIs: S3, ECS, Elastic Load Balancing, Application Auto Scaling, CloudFormation, CloudWatch, and Secrets Manager if you use an auth token | In a VPC without internet access, each needs a VPC endpoint. Without them, releases fail with `ETIMEDOUT`                                                                                                                              |

### What a deployment does

1. CloudFormation creates the new version's ECS service, target group and listener rule, and waits for its tasks to
   pass health checks (`GET /health`).
2. After every other resource in the stack is in place, the `ServiceDeployer` registers the new version with Restate.
   From now on, new invocations go to it.
3. CloudFormation drops the previous version from the stack without deleting it (`DeletionPolicy: Retain`).
4. After the release, and then on a schedule, the `ServiceDeployer` Lambda checks every superseded version. It scales
   it down to `supersededVersionScaling`, and once Restate reports no unfinished invocations on it for `drainDelay`,
   deregisters it and deletes its resources.

If the deployment fails before step 2, the new version never receives traffic, and the next prune deletes it. If it
fails after step 2, CloudFormation's rollback registers the previous version as the latest again. Invocations that
already started on the new version finish there, and it is then pruned like any superseded version.

### Settings

| Property                             | Default                            | Meaning                                                                                                                                                    |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desiredCount`                       | 1                                  | Tasks of the current version                                                                                                                               |
| `supersededVersionScaling`           | 1 to `desiredCount` tasks, CPU 70% | Scaling of a version once it is superseded. The minimum is at least 1, so suspended invocations can resume                                                 |
| `drainDelay`                         | 5 minutes                          | How long a superseded version must stay drained before it is removed                                                                                       |
| `pruneSchedule`                      | hourly                             | Superseded versions are checked after every release and on this schedule                                                                                   |
| `removalPolicy`                      | `RETAIN`                           | What happens to all versions when the construct is removed. `DESTROY` deregisters and deletes them without waiting for invocations; use it for test stacks |
| `pathPrefix`                         | derived from the construct path    | Versions are served at `${baseUrl}/${pathPrefix}/${versionId}`                                                                                             |
| `containerName`, `containerPort`     | default container, 9080            | Where the ALB sends traffic                                                                                                                                |
| `healthCheck`, `deregistrationDelay` | `GET /health`, 60 s                | Target group settings                                                                                                                                      |
| `listenerRulePriorityRange`          | 40000 to 49999                     | Listener rule priorities this construct may use                                                                                                            |
| `registration`                       |                                    | Restate registration options: `private`, `breaking`, `additionalHeaders`, `authToken`, `adminUrl`, `insecure` and the health check retry settings          |
| `registerAfterAllResources`          | `true`                             | Registers a new version only after every other resource in the stack; turn off if your own resources must depend on the construct                          |

Use `invalidateVersionBasedOn("...")` to force a new version when the task definition is unchanged.

### Operating it

- **Finding versions.** Every version's resources carry the tags `restate:service` and `restate:version`. Superseded
  versions also carry `restate:deployment-id`, `restate:original-capacity` and, once drained, `restate:drained-at`.
- **Changing a superseded version's capacity by hand.** The construct sets a superseded version's scaling once, when it
  first sees it. Capacity changes you make afterwards, for example with `aws application-autoscaling
register-scalable-target`, are left alone.
- **Removing a version by hand.** Delete its deployment in Restate first, then its listener rule, ECS service and
  target group.
- **Troubleshooting.**
  - `ETIMEDOUT` from a `Custom::Restate...` resource: the `ServiceDeployer` Lambda cannot reach an AWS API; add the
    VPC endpoint.
  - `PriorityInUse` on a listener rule: two deployments sharing the listener allocated a priority at the same moment;
    deploy again.
  - Invocations retried at a regular interval with "stream error received: unspecific protocol error": the ALB idle
    timeout is too low.

### Examples

You can use the following templates to bootstrap your own CDK projects:

- [e2e tests in this repository](test/e2e)
- the official [Restate examples](https://github.com/restatedev/examples) repository
