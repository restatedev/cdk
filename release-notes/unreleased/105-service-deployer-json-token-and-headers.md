# ServiceDeployer: JSON-field auth tokens and custom admin headers (#105)

## New Feature

### What Changed

- `RestateEnvironment.authTokenJsonField` reads the bearer token from a top-level field when the `authToken` secret
  stores a JSON object.
- `ServiceDeployer.register()` accepts `additionalHeaders`, static headers added to every Restate admin API request the
  deployer makes.

### Why This Matters

Secrets created by other tooling often hold JSON with several fields. A gateway or proxy in front of the Restate admin
API may require extra headers.

### Impact on Users

- Nothing changes unless you set the new properties; existing stacks synthesize the same custom resource properties.
- `additionalHeaders` values are stored in plain text in the CloudFormation template. Do not put credentials in them.
- `authTokenJsonField` requires an `authToken` on the environment, and applies only to the environment's token, not to
  a registration-level `authToken`.

### Example

```ts
const environment = RestateEnvironment.fromAttributes({
  adminUrl: "https://restate.example.com:9070",
  authToken: secretsmanager.Secret.fromSecretNameV2(this, "Token", "restate-admin"),
  authTokenJsonField: "token",
});

deployer.register(handler.currentVersion, environment, {
  additionalHeaders: { "x-team": "orders" },
});
```
