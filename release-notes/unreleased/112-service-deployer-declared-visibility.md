# ServiceDeployer: keep each service's declared ingress visibility (#112)

## New Feature

### What Changed

- `ServiceDeployer.register()` and `deployService()` accept `visibility: "public" | "private" | "declared"`.
  `"public"` and `"private"` behave like `private: false` and `private: true`. `"declared"` leaves each service's
  ingress visibility as registration set it: each new service revision is private if the service definition declares
  it (for example `ingressPrivate: true` in the TypeScript SDK), and public otherwise.
- `RestateFargateService` accepts the same `visibility` in its `registration` props.
- A visibility update that fails with a network error or a 5xx response is now retried with backoff, without
  registering the deployment again, instead of failing the deployment on the first error.

### Why This Matters

Until now, the deployer made every service in a deployment public, or every one private, on each deploy. A service
that declared itself ingress-private was made public again unless the whole deployment was registered with
`private: true`. A deployment that serves a public API next to internal services had to be split to keep the internal
ones private.

### Impact on Users

- `"declared"` is the default from this release on; see #114 for the upgrade impact.
- The registration handler's code changes, so CloudFormation updates the deployer Lambda once on upgrade.
- `"declared"` follows the declaration on Restate server 1.5 and newer. Restate 1.4 honours it too, but a service
  that declares nothing keeps its previous visibility instead of becoming public. Earlier servers don't support the
  declaration, and the TypeScript SDK fails discovery against them.
- `"declared"` needs the registration handler from this release. A handler supplied through
  `ServiceDeployerProps.code` from an earlier release treats `"declared"` as private and marks every service private.
- Setting both `private` and `visibility`, or an unknown `visibility` value, fails at synth time.

### Example

```ts
// The service definition decides:
// restate.service({ name: "Internal", handlers, options: { ingressPrivate: true } })
deployer.register(handler.currentVersion, environment, {
  visibility: "declared",
});
```

### Related Issues

- #111
