# ServiceDeployer: services keep their declared visibility by default (#114)

## Behavioral Change

### What Changed

Registrations that set neither `private` nor `visibility` now default to `visibility: "declared"`. The deployer no
longer makes every service public on each deploy: each new service revision is private if the service definition
declares it (for example `ingressPrivate: true` in the TypeScript SDK), and public otherwise. An explicit
`private: false` or `visibility: "public"` still makes every service public.

### Why This Matters

The old default silently overrode services that declared themselves ingress-private, so a deployment serving both
public and private services could not keep the private ones private.

### Impact on Users

- Services that declare `ingressPrivate` become private on the first deploy after the upgrade that ships new service
  code, not on the upgrade itself. On Restate 1.6 and newer, the upgrade registers each unchanged deployment again,
  which creates no new service revision, so services stay public until their next new revision. From then on, calls
  to them through Restate ingress fail. Registrations with `force: true` are the exception: the upgrade registers them
  again with `force`, which creates new revisions, so their services become private on the upgrade itself.
- A visibility you changed by hand (CLI or UI) now stays until the service's next new revision, instead of being reset
  to public on every deploy.
- The custom resource property `private` changes from `"false"` to `"declared"` for every registration without
  `private` or `visibility`, so CloudFormation registers each such deployment again once. Restate 1.6 and newer accept
  this. Older servers reject it unless the registration sets `force: true`, and also reject the rollback's
  registration, so the stack ends in `UPDATE_ROLLBACK_FAILED` and needs `aws cloudformation continue-update-rollback`
  with the deployment resources skipped.
- A registration handler supplied through `ServiceDeployerProps.code` from 1.7.x or earlier reads `"declared"` as
  private, so with the new default it marks every service private. Upgrade that handler too, or set
  `visibility: "public"`.
- Registrations that set `private: true` or `private: false` see no change. Passing `private: undefined` counts as
  unset and now means `"declared"`.

### Migration Guidance

To keep the old behaviour, set `visibility: "public"` (or `private: false`). Do this before upgrading if your Restate
server is older than 1.6, or if you supply your own registration handler through `ServiceDeployerProps.code`.

```ts
deployer.register(handler.currentVersion, environment, { visibility: "public" });
```

### Related Issues

- #111
- #112
