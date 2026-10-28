import { uuidv7 } from './ids';

describe('uuidv7', () => {
  afterEach(() => jest.restoreAllMocks());

  it('has the v7 layout with the RFC 9562 variant', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    jest.spyOn(Date, 'now').mockReturnValue(0x0123456789ab);
    expect(uuidv7().replace(/-/g, '').slice(0, 12)).toBe('0123456789ab');
  });

  it('sorts an id made 2 ms later after the earlier one', () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_800_000_000_000);
    const earlier = uuidv7();
    now.mockReturnValue(1_800_000_000_002);
    const later = uuidv7();
    expect(later > earlier).toBe(true);
  });

  it('makes 1,000 distinct ids', () => {
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });
});
