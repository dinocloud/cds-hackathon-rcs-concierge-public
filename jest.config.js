/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/lambdas', '<rootDir>/infra/test', '<rootDir>/scripts'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
  // El synth de CDK empaqueta las Lambdas con esbuild: puede tardar.
  testTimeout: 120000,
};
