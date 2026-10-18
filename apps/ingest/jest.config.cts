module.exports = {
  displayName: 'ingest',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Jest applies this to hooks as well as tests. Most spec files rebuild a database in beforeAll
  // (create, wipe, apply every migration), and with all of them starting at once on a cold ts-jest
  // cache that took 3-8 s against Jest's 5 s default. 60 s still fails a genuine hang.
  testTimeout: 60_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/ingest',
};
