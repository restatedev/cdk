# RestateFargateService: versioned Restate services on ECS Fargate (#108)

## New Feature

### What Changed

A new construct, `RestateFargateService`, runs a Restate service on ECS Fargate with one immutable version per
release, the way `ServiceDeployer` already handles Lambda versions:

- Each change to the task definition creates a new version: its own ECS service, HTTP/2 target group and listener rule
  on a shared ALB, served at `${baseUrl}/${pathPrefix}/${versionId}`.
- The `ServiceDeployer` registers each version with Restate once the rest of the stack is in place.
- Superseded versions keep running for the invocations pinned to them. They are scaled down to between 1 and
  `desiredCount` tasks, and removed once Restate reports nothing pinned to them for `drainDelay` (5 minutes by
  default). Removal is checked after every release and on `pruneSchedule` (hourly by default).
- CloudFormation never deletes a version, including on rollback. A rollback after registration promotes the previous
  version back with its original deployment id.

### Why This Matters

Restate pins every invocation to the deployment that started it. ECS rolling and blue/green deployments replace the
code behind one URL, so long-running or suspended invocations could resume on different code. Lambda versions avoid
this, but Lambda only supports request/response. Fargate allows Restate's bidirectional HTTP/2 protocol.

### Impact on Users

- New API only. Existing `ServiceDeployer.register()` calls and Lambda registrations are unchanged.
- When you use the construct, the `ServiceDeployer` Lambda's role gets new permissions for ECS, Elastic Load
  Balancing, Application Auto Scaling, CloudWatch alarms and CloudFormation. Application Auto Scaling actions are not
  limited to specific resources. The README lists all of them.
- A `ServiceDeployer` in a VPC without internet access needs VPC endpoints for ECS, Elastic Load Balancing,
  Application Auto Scaling, CloudFormation, CloudWatch and S3.

### Migration Guidance

Requirements:

- An ALB with an HTTPS listener that Restate can reach.
- An ALB idle timeout above Restate's inactivity plus abort timeouts, for example 900 seconds.
- Container images from CDK assets or pinned by digest.

```ts
const orders = new RestateFargateService(this, "Orders", {
  cluster,
  taskDefinition,
  listener,
  baseUrl: "https://handlers.internal.example.com",
  environment,
  deployer,
  desiredCount: 3,
});
orders.currentVersion.service.autoScaleTaskCount({ minCapacity: 3, maxCapacity: 10 });
```

To move a service that runs behind one URL today, deploy it with this construct. The first release registers the new
URI, which takes over the service's latest deployment. Invocations pinned to the old deployment finish there; remove
the old service once Restate shows none left.

See "Versioned services on ECS Fargate" in the README for settings, operations and troubleshooting.
