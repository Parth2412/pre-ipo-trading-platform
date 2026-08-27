import type { Config } from 'jest';

const shared = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': ['@swc/jest'] },
  moduleNameMapper: { '^@app/(.*)$': '<rootDir>/src/$1' },
} satisfies Partial<Config>;

const config: Config = {
  ...shared,
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
      testTimeout: 60_000,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
};

export default config;
