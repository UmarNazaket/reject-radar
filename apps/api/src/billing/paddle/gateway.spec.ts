import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type { ApiEnv } from '@rejectradar/contracts';
import { SdkPaddleGateway } from './gateway';

// The only mock of the SDK in the suite: constructing the client is checked, calling Paddle never happens.
jest.mock('@paddle/paddle-node-sdk', () => ({
  Environment: { sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' },
  Paddle: jest.fn(),
}));

const PaddleMock = Paddle as unknown as jest.Mock;
const env = (paddleEnv: 'sandbox' | 'production') => ({ PADDLE_ENV: paddleEnv, PADDLE_API_KEY: 'key' }) as ApiEnv;

describe('SdkPaddleGateway', () => {
  beforeEach(() => PaddleMock.mockClear());

  it('picks the sandbox environment', () => {
    new SdkPaddleGateway(env('sandbox'));
    expect(PaddleMock).toHaveBeenCalledWith('key', { environment: Environment.sandbox });
  });

  it('picks the production environment', () => {
    new SdkPaddleGateway(env('production'));
    expect(PaddleMock).toHaveBeenCalledWith('key', { environment: Environment.production });
  });

  it('returns the overview URL of the portal session', async () => {
    const create = jest.fn().mockResolvedValue({ urls: { general: { overview: 'https://portal.example/overview' } } });
    PaddleMock.mockImplementation(() => ({ customerPortalSessions: { create } }));
    const url = await new SdkPaddleGateway(env('sandbox')).createPortalSession('ctm_1', ['sub_1']);
    expect(create).toHaveBeenCalledWith('ctm_1', ['sub_1']);
    expect(url).toBe('https://portal.example/overview');
  });
});
