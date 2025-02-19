const path = require('path');

const baseConfig = require('./jest.config.base');

module.exports = {
  ...baseConfig,
  rootDir: path.resolve(__dirname),
  testRegex: 'test/e2e/.*\\.e2e\\.ts$',
  moduleDirectories: ['node_modules', '<rootDir>'],
  testTimeout: 600000, // 10 minutes for E2E tests
  // setupFiles: ['<rootDir>/test/e2e/setup.ts'],
};
