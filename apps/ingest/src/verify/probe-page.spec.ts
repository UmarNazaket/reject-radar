import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeFetcher, fetchResult } from '../core/test-fetcher';
import { formatProbeReport, probePage, probeText, toPlainText } from './probe-page';

const PAGE =
  '<h2>Red List</h2>' +
  '<div><b>ACME FOODS PVT LTD</b> Date Published: 01/02/2026<br>Karachi, PAKISTAN FEI# 3004249948</div>' +
  '<div><b>BETA RICE</b> Date Published: 03/04/2026<br>Lahore, PAKISTAN</div>' +
  '<h2>Green List</h2>';

describe('probeText', () => {
  it('counts each pattern case-insensitively and samples the first matches', () => {
    expect(probeText(PAGE, ['red list', 'Date Published', 'FEI'], 'FEI[^<]{0,20}')).toEqual({
      counts: { 'red list': 1, 'Date Published': 2, FEI: 1 },
      samples: ['FEI# 3004249948'],
    });
  });
  it('limits the number of samples and strips tags', () => {
    expect(probeText(PAGE, [], '<b>[^<]+</b>', 1).samples).toEqual(['ACME FOODS PVT LTD']);
  });
});

describe('toPlainText', () => {
  it('removes tags, decodes &amp; and &nbsp; and collapses whitespace', () => {
    expect(toPlainText('<b>A&amp;B</b>&nbsp; Foods')).toBe('A&B Foods');
  });
});

describe('formatProbeReport', () => {
  it('renders a markdown section for the findings document', () => {
    const text = formatProbeReport(
      { origin: 'https://example.gov/page.html', bytes: 846835, sha256: 'abc', counts: { 'Red List': 1 }, samples: ['FEI# 1'] },
      new Date('2026-10-20T10:00:00Z'),
    );
    expect(text).toContain('## probe — https://example.gov/page.html — 2026-10-20T10:00:00.000Z');
    expect(text).toContain('- Size: 846,835 bytes');
    expect(text).toContain('- Matches: `Red List` 1');
    expect(text).toContain('  - FEI# 1');
  });
});

describe('probePage', () => {
  it('downloads the page through the fetcher expecting HTML', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'probe-page-'));
    try {
      const { fetcher, calls } = fakeFetcher(() => fetchResult(PAGE, { contentType: 'text/html' }));
      const result = await probePage({ url: 'https://www.accessdata.fda.gov/cms_ia/ialist.html', count: ['Date Published'], workDir: dir }, fetcher);
      expect(result.counts).toEqual({ 'Date Published': 2 });
      expect(result.bytes).toBe(Buffer.byteLength(PAGE));
      expect(calls[0].options).toEqual({ expect: 'html' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('asks for a fetcher when given a URL', async () => {
    await expect(probePage({ url: 'https://www.accessdata.fda.gov/x' })).rejects.toThrow('fetcher');
  });
});
