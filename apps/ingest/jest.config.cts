module.exports = {
  displayName: 'ingest',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Jest applies this to hooks as well as tests. About half the suites (11 of 21) rebuild a database in
  // beforeAll (create, wipe, apply every migration); started together on a cold ts-jest cache that took
  // 4-10 s against Jest's 5 s default. 60 s still fails a genuine hang.
  testTimeout: 60_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/ingest',
};
