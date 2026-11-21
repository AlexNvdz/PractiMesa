import type { Config } from 'jest';

const config: Config = {
  rootDir: 'src',
  testEnvironment: 'node',
  // Integration specs read DATABASE_URL from apps/api/.env locally; CI sets it directly.
  setupFiles: ['dotenv/config'],
  testRegex: '.*\\.(spec|test)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/*.test.ts',
    '!main.ts',
    '!**/*.module.ts',
    '!generated/**',
    '!testing/**',
  ],
  coverageDirectory: '../coverage',
  coverageReporters: ['lcov', 'text-summary'],
  // Critical code (tenant isolation, plan limits; payments in Phase 2) must stay >= 80%.
  coverageThreshold: {
    '**/src/common/**/*.ts': { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
};

export default config;
