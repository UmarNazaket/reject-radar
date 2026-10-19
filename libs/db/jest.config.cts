module.exports = {
  displayName: 'db',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  maxWorkers: 1,
  // Specs rebuild a test database in beforeAll; under CI's parallel projects that can exceed Jest's 5 s default.
  testTimeout: 60_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/db',
};
