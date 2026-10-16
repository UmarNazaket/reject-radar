import { createPool } from './client';

const UNREACHABLE = 'postgres://nobody:nothing@127.0.0.1:1/none';

describe('createPool', () => {
  it('passes an idle client error to the supplied handler instead of throwing', async () => {
    const onError = jest.fn();
    const pool = createPool(UNREACHABLE, {}, onError);
    const error = new Error('connection lost');
    try {
      expect(() => pool.emit('error', error)).not.toThrow();
      expect(onError).toHaveBeenCalledWith(error);
    } finally {
      await pool.end();
    }
  });

  it('logs an idle client error by default instead of crashing the process', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = createPool(UNREACHABLE);
    try {
      expect(() => pool.emit('error', new Error('connection lost'))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    } finally {
      consoleError.mockRestore();
      await pool.end();
    }
  });
});
