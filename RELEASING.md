# Releasing the package

- Update `RESTATE_DOCKER_DEFAULT_TAG` / `RESTATE_NPM_DEFAULT_TAG`
- Update version in `package.json`
- Create and publish a new release in [GitHub](https://github.com/restatedev/cdk/releases)

## Testing major Restate version updates

Before releasing a CDK update for a new Restate major/minor version:

1. **Review release notes** for breaking changes, deprecated config options, or new defaults:

   - Check `restate/release-notes/unreleased/*.md` for upcoming changes
   - Look for removed/renamed configuration options that the CDK might be setting
   - Verify CDK defaults (e.g., `rocksdb-total-memory-size`, `query-engine.memory-size`) make sense for small dev/test deployments

2. **Update version tags** in:

   - `lib/restate-constructs/single-node-restate-deployment.ts`: `RESTATE_DOCKER_DEFAULT_TAG`, `RESTATE_NPM_DEFAULT_TAG`
   - `lib/restate-constructs/fargate-restate-deployment.ts`: `RESTATE_DOCKER_DEFAULT_TAG`

3. **Run e2e tests** against an RC build before release:

   ```bash
   # Note the hardcoded main image reference in test/e2e/stacks/ec2-simple-stack.ts
   # You might need to temporarily use a pre-release tag (e.g., 1.6.0-rc.5)

   # Build and run single-node e2e test
   npm run build && npx tsx test/handlers/build.mts
   RETAIN_STACK=true npx jest --config jest.config.e2e.js --testNamePattern "Single Node"

   # Inspect the deployment if needed, then clean up
   aws cloudformation delete-stack --stack-name e2e-RestateSingleNode
   ```

4. **Update snapshots** after finalizing version tags:
   ```bash
   npm test -- --updateSnapshot
   ```
