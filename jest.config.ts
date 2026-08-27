import type { Config } from 'jest';

/**
 * Two projects, because the suites have very different needs:
 *   `unit` — pure domain logic, no I/O, runs in parallel.
 *   `e2e`  — boots the Nest application against a real Postgres database and
 *            must run serially so concurrency tests own the market.
 *
 * `@swc/jest` is used instead of `ts-jest` because Nest depends on
 * `emitDecoratorMetadata`, which esbuild cannot produce and ts-jest produces
 * slowly. SWC does both, and reads `.swcrc` for the decorator settings.
 */
const shared = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': ['@swc/jest', {}] as [string, Record<string, unknown>] },
  moduleNameMapper: { '^@app/(.*)$': '<rootDir>/src/$1' },
};

const config: Config = {
  testTimeout: 60_000,
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
      globalSetup: '<rootDir>/test/global-setup.ts',
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/database/*.cli.ts',
  ],
  coverageDirectory: 'coverage',
};

export default config;
