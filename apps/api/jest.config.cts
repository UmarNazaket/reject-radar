module.exports = {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Two workers, never one: with one, Jest runs in band inside the Nx task process, and on Windows with Node 24 that
  // process can die of a native fast-fail (0xC0000409) with no output at all. In a worker the same crash is reported as
  // a named failing suite. Parallel specs are safe: each e2e spec has its own prepareTestDatabase suffix, and the
  // nestjs-pino root logger and the in-memory rate limiter are per process.
  maxWorkers: 2,
  // The e2e spec rebuilds a test database in beforeAll; under CI's parallel projects that can exceed Jest's 5 s default.
  testTimeout: 60_000,
  transform: {
    // intl-messageformat (through @rejectradar/i18n), its parser and @nestjs/jwt 12 ship ES modules only, so ts-jest compiles them to CommonJS as well.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(intl-messageformat|@formatjs|@nestjs/jwt)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api',
};
