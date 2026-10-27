module.exports = {
  displayName: 'i18n',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    // intl-messageformat and its parser ship ES modules only, so ts-jest compiles them to CommonJS as well.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(intl-messageformat|@formatjs)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/i18n',
};
