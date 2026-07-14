/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.spec.ts'],
  // macOS writes AppleDouble metadata files (._foo.test.ts) on exFAT drives — never real tests.
  testPathIgnorePatterns: ['/node_modules/', '/\\._'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@domain/(.*)$': '<rootDir>/src/domain/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: './tsconfig.jest.json' }],
  },
  collectCoverageFrom: ['src/domain/**/*.ts', '!src/domain/**/__tests__/**'],
};
