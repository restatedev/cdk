const baseConfig = require('./jest.config.base');

module.exports = {
  ...baseConfig,
  roots: ["<rootDir>/test"],
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  // Exclude E2E tests
  testPathIgnorePatterns: ["/node_modules/", "/test/e2e/"],
};
