import { PADDLE_SIGNATURE_TOLERANCE_SEC, signPaddlePayload, verifyPaddleSignature } from './signature';

const SECRET = 'pdl_ntfset_test_secret';
const body = Buffer.from('{"event_id":"evt_1","event_type":"subscription.created"}');
const TS = 1_800_000_000;

const h1Of = (header: string): string => header.split(';')[1].slice('h1='.length);

describe('verifyPaddleSignature', () => {
  it('accepts a valid signature', () => {
    const header = signPaddlePayload(body, SECRET, TS);
    expect(header).toMatch(/^ts=1800000000;h1=[0-9a-f]{64}$/);
    expect(verifyPaddleSignature(body, header, SECRET, TS)).toBe(true);
  });

  it('rejects a changed body byte', () => {
    const header = signPaddlePayload(body, SECRET, TS);
    const changed = Buffer.from(body);
    changed[3] ^= 1;
    expect(verifyPaddleSignature(changed, header, SECRET, TS)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const header = signPaddlePayload(body, SECRET, TS);
    expect(verifyPaddleSignature(body, header, 'another_secret', TS)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyPaddleSignature(body, undefined, SECRET, TS)).toBe(false);
    expect(verifyPaddleSignature(body, '', SECRET, TS)).toBe(false);
  });

  it('rejects a header without h1', () => {
    expect(verifyPaddleSignature(body, `ts=${TS}`, SECRET, TS)).toBe(false);
  });

  it('rejects a header without ts', () => {
    const h1 = h1Of(signPaddlePayload(body, SECRET, TS));
    expect(verifyPaddleSignature(body, `h1=${h1}`, SECRET, TS)).toBe(false);
  });

  it('rejects a timestamp outside 30 s and accepts one on the edge', () => {
    expect(PADDLE_SIGNATURE_TOLERANCE_SEC).toBe(30);
    const header = signPaddlePayload(body, SECRET, TS);
    expect(verifyPaddleSignature(body, header, SECRET, TS + 31)).toBe(false);
    expect(verifyPaddleSignature(body, header, SECRET, TS - 31)).toBe(false);
    expect(verifyPaddleSignature(body, header, SECRET, TS + 30)).toBe(true);
    expect(verifyPaddleSignature(body, header, SECRET, TS - 30)).toBe(true);
  });

  it('accepts any one of several h1 values', () => {
    const right = h1Of(signPaddlePayload(body, SECRET, TS));
    const wrong = 'a'.repeat(64);
    expect(verifyPaddleSignature(body, `ts=${TS};h1=${wrong};h1=${right}`, SECRET, TS)).toBe(true);
    expect(verifyPaddleSignature(body, `ts=${TS};h1=${right};h1=${wrong}`, SECRET, TS)).toBe(true);
    expect(verifyPaddleSignature(body, `ts=${TS};h1=${wrong};h1=${wrong}`, SECRET, TS)).toBe(false);
  });

  it('rejects malformed hex without throwing', () => {
    const right = h1Of(signPaddlePayload(body, SECRET, TS));
    for (const bad of [right.slice(0, 63), right.toUpperCase(), 'z'.repeat(64), '', right + right]) {
      expect(() => verifyPaddleSignature(body, `ts=${TS};h1=${bad}`, SECRET, TS)).not.toThrow();
      expect(verifyPaddleSignature(body, `ts=${TS};h1=${bad}`, SECRET, TS)).toBe(false);
    }
  });

  it('rejects a non-numeric timestamp without throwing', () => {
    const right = h1Of(signPaddlePayload(body, SECRET, TS));
    expect(verifyPaddleSignature(body, `ts=abc;h1=${right}`, SECRET, TS)).toBe(false);
  });
});
