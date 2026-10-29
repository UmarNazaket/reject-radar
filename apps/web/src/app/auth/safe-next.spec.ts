import { safeNext } from './safe-next';

describe('safeNext', () => {
  it('keeps a path on this site', () => {
    expect(safeNext('/firms/12?tab=history')).toBe('/firms/12?tab=history');
  });

  it('refuses anything that could leave the site', () => {
    for (const next of [undefined, '', 'https://evil.example', '//evil.example', 'javascript:alert(1)']) expect(safeNext(next)).toBe('/');
  });
});
