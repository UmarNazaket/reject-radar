import { setupZonelessTestEnv } from 'jest-preset-angular/setup-env/zoneless';

// Set by the build's `define`; specs call the API on the same origin.
(globalThis as { API_ORIGIN?: string }).API_ORIGIN = '';

setupZonelessTestEnv({
  errorOnUnknownElements: true,
  errorOnUnknownProperties: true,
});
