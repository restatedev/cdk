const baseConfig = require("./jest.config.base");

module.exports = {
  ...baseConfig,
  roots: ["<rootDir>/test"],
  testMatch: ["<rootDir>/test/e2e/**/*.e2e.ts"],
  testTimeout: 600_000,
};
