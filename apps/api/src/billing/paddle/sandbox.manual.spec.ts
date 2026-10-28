import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type { ApiEnv } from '@rejectradar/contracts';
import { SdkPaddleGateway } from './gateway';

/**
 * The one spec that calls the Paddle sandbox (P7). Skipped unless PADDLE_SANDBOX_E2E=1, so `nx test api` and CI never reach Paddle.
 *   PADDLE_SANDBOX_E2E=1 npx nx test api --testFile=sandbox.manual
 * It reads the sandbox key from the local .env, creates a throwaway customer, checks the portal session URL and archives the customer.
 */
const enabled = process.env['PADDLE_SANDBOX_E2E'] === '1';
const SANDBOX_KEY_PREFIX = 'pdl_sdbx_apikey_';

(enabled ? describe : describe.skip)('Paddle sandbox (manual)', () => {
  let apiKey = '';
  let paddle: Paddle;
  let customerId: string | undefined;

  beforeAll(() => {
    const envFile = resolve(__dirname, '../../../../../.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    apiKey = process.env['PADDLE_API_KEY'] ?? '';
    // Never run against a live account, and never echo the key in a failure message.
    if (!apiKey.startsWith(SANDBOX_KEY_PREFIX))
      throw new Error(
        'PADDLE_API_KEY must be a sandbox key (pdl_sdbx_apikey_...)',
      );
    paddle = new Paddle(apiKey, { environment: Environment.sandbox });
  });

  afterAll(async () => {
    if (customerId) await paddle.customers.archive(customerId);
  });

  it('opens a customer-portal session with an https URL', async () => {
    const customer = await paddle.customers.create({
      email: `p7-sandbox-check+${Date.now()}@example.com`,
      name: 'P7 sandbox check',
    });
    customerId = customer.id;

    const gateway = new SdkPaddleGateway({
      PADDLE_API_KEY: apiKey,
      PADDLE_ENV: 'sandbox',
    } as Pick<ApiEnv, 'PADDLE_API_KEY' | 'PADDLE_ENV'>);
    const url = await gateway.createPortalSession(customer.id, []);

    // Only the host is shown: the URL carries a session token. The booleans keep a failure from printing the URL.
    const parsed = new URL(url);
    console.info(`Portal session host: ${parsed.host}`);
    expect(parsed.protocol === 'https:').toBe(true);
  });
});
