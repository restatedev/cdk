## Restate CDK e2e tests

The CDK stacks in this directory serve a dual purpose of providing usage examples, and validation targets during development.

Some of these are wrapped in e2e tests you can run with:

```shell
npm run test:e2e
```

To run the automated e2e tests, you'll generally need valid AWS or Restate Cloud credentials. To speed things up you can set `RETAIN_STACK=true`.
