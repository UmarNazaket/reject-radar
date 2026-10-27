module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  maxWorkers: 1,
  // The e2e spec rebuilds a test database in beforeAll; under CI's parallel projects that can exceed Jest's 5 s default.
  testTimeout: 60_000,
  transform: {
    // intl-messageformat (through @rejectradar/i18n) and its parser ship ES modules only, so ts-jest compiles them to CommonJS as well.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(intl-messageformat|@formatjs)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api',
};
