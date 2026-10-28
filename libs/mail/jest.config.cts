module.exports = {
  displayName: 'mail',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Specs rebuild a test database in beforeAll; under CI's parallel projects that can exceed Jest's 5 s default.
  testTimeout: 60_000,
  transform: {
    // @rejectradar/i18n pulls in intl-messageformat, which ships ES modules only, so ts-jest compiles it as well.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(intl-messageformat|@formatjs)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/mail',
};
