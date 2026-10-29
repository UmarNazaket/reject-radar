import type { ApiEnv, DashboardResponse, Destination, NoticeItem } from '@rejectradar/contracts';
import { DESTINATIONS } from '@rejectradar/contracts';
import { PDF_COPY } from './pdf-copy';
import { PdfRenderer } from './pdf-renderer';
import { cellText, pageCount, tableBodies, textOf } from './pdf-test-utils';
import { type TopicReportData, topicReportDoc } from './topic-report.doc';

const GENERATED_AT = '2026-10-29';
const render = (doc: ReturnType<typeof topicReportDoc>) => new PdfRenderer({ NODE_ENV: 'test' } as ApiEnv).render('topic', doc);

/** The `YYYY-MM` of the month `back` months before October 2026. */
const monthBack = (back: number): string => {
  const total = 2026 * 12 + 9 - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const counts = (seed: number) => ({
  US: seed,
  EU: seed + 1,
  UK: seed + 2,
  AU: seed + 3,
});

const noticeItem = (i: number, over: Partial<NoticeItem> = {}): NoticeItem => ({
  id: i,
  source: 'fda_refusal',
  noticeType: 'refusal',
  destination: DESTINATIONS[i % 4],
  noticeOn: `2026-10-${String(28 - i).padStart(2, '0')}`,
  originCountry: 'PK',
  commodityId: 101,
  hazardIds: [1, 2],
  productText: `Basmati rice shipment ${i}`,
  firmName: `Exporter number ${i} Ltd`,
  firmId: null,
  title: null,
  url: null,
  ...over,
});

function dashboard(over: Partial<DashboardResponse> = {}, months = 36): DashboardResponse {
  return {
    months: Array.from({ length: months }, (_, i) => ({
      month: monthBack(months - 1 - i),
      ...counts(100 + i * 5),
    })),
    totals12m: { US: 411, EU: 52, UK: 7, AU: 18 },
    hazardCategories: [{ category: 'pesticide_residues', count: 40 }],
    findings: Array.from({ length: 10 }, (_, i) => ({
      hazardId: i + 1,
      count: 90 - i * 7,
      byDestination: counts(20 + i),
    })),
    commodities: [{ commodityId: 101, count: 30 }],
    latest: Array.from({ length: 20 }, (_, i) => noticeItem(i + 1)),
    historyFrom: null,
    freshness: [
      {
        source: 'fda_refusals',
        lastSuccessAt: '2026-10-28T06:00:00.000Z',
        stale: false,
        latestMonth: null,
      },
      {
        source: 'rasff',
        lastSuccessAt: '2026-10-27T06:00:00.000Z',
        stale: false,
        latestMonth: null,
      },
      {
        source: 'uk_bn',
        lastSuccessAt: '2026-10-20T06:00:00.000Z',
        stale: false,
        latestMonth: '2026-07',
      },
      {
        source: 'au_ifis',
        lastSuccessAt: '2026-10-20T06:00:00.000Z',
        stale: false,
        latestMonth: '2026-08',
      },
    ],
    ...over,
  };
}

const HAZARD_NAMES: Record<number, string> = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, `Hazard name ${i + 1}`]));

function data(over: Partial<TopicReportData> = {}): TopicReportData {
  return {
    orgName: 'Indus Valley Agro Exports',
    generatedAt: GENERATED_AT,
    query: { origin: 'PK' },
    originName: 'Pakistan',
    commodityName: null,
    hazardNames: HAZARD_NAMES,
    dashboard: dashboard(),
    ...over,
  };
}

const words = (d: ReturnType<typeof topicReportDoc>) => textOf(d).join('\n');

/** The month rows of the document, in order: `[month, ...counts]` as printed. */
function monthRows(d: ReturnType<typeof topicReportDoc>): string[][] {
  return tableBodies(d.content)
    .filter((body) => body[0] && cellText(body[0][0]) === PDF_COPY.month)
    .flatMap((body) => body.slice(1).map((row) => row.map(cellText)));
}

describe('topicReportDoc', () => {
  it('names the account, the topic, the date, the sources and the disclaimer', () => {
    const text = words(
      topicReportDoc(
        data({
          query: { origin: 'PK', commodity: 101, destination: ['US', 'EU'] },
          commodityName: 'Rice',
        }),
      ),
    );
    expect(text).toContain('Indus Valley Agro Exports');
    expect(text).toContain('Pakistan');
    expect(text).toContain('Rice');
    expect(text).toContain(GENERATED_AT);
    expect(text).toContain(PDF_COPY.disclaimer);
    expect(text).toContain(PDF_COPY.topicSources.US);
    expect(text).toContain(PDF_COPY.topicSources.EU);
    expect(text).not.toContain(PDF_COPY.topicSources.AU);
    expect(text).not.toMatch(/\b(clean|safe)\b/i);
  });

  it('is A4', () => {
    expect(topicReportDoc(data()).pageSize).toBe('A4');
  });

  it('prints the 36 monthly counts of every destination as the dashboard has them, oldest first', () => {
    const d = data();
    const rows = monthRows(topicReportDoc(d));
    expect(rows).toEqual(
      d.dashboard.months.map((m) => [m.month, ...DESTINATIONS.map((x) => String(m[x])), String(m.US + m.EU + m.UK + m.AU)]),
    );
  });

  it('prints only the chosen destinations, in the dashboard order, with the total of those', () => {
    const d = data({ query: { origin: 'PK', destination: ['AU', 'US'] } });
    const rows = monthRows(topicReportDoc(d));
    const first = d.dashboard.months[0];
    expect(rows[0]).toEqual([first.month, String(first.US), String(first.AU), String(first.US + first.AU)]);
    expect(rows).toHaveLength(36);
  });

  it('prints one destination without a total column', () => {
    const d = data({ query: { origin: 'PK', destination: ['EU'] } });
    expect(monthRows(topicReportDoc(d))[0]).toEqual([d.dashboard.months[0].month, String(d.dashboard.months[0].EU)]);
  });

  it('prints fewer months when the plan reaches back less, and says where the history starts', () => {
    const d = data({ dashboard: dashboard({ historyFrom: '2026-01-01' }, 10) });
    const rows = monthRows(topicReportDoc(d));
    expect(rows.map((r) => r[0])).toEqual(d.dashboard.months.map((m) => m.month));
    expect(words(topicReportDoc(d))).toContain(PDF_COPY.historyFrom('2026-01-01'));
  });

  it('prints the 12-month totals', () => {
    const text = words(topicReportDoc(data()));
    expect(text).toContain('411');
    expect(text).toContain(PDF_COPY.totals12m);
  });

  it('prints the top hazards with their names and counts, as the dashboard lists them', () => {
    const d = data();
    const doc = topicReportDoc(d);
    const hazardTable = tableBodies(doc.content).find((body) => body[0] && cellText(body[0][0]) === PDF_COPY.hazard);
    expect(hazardTable).toBeDefined();
    const rows = hazardTable?.slice(1).map((r) => r.map(cellText));
    expect(rows).toEqual(
      d.dashboard.findings.map((f) => [
        `Hazard name ${f.hazardId}`,
        ...DESTINATIONS.map((x) => String(f.byDestination[x])),
        String(f.count),
      ]),
    );
  });

  it('names a commodity whose label is unknown by its id, never as all commodities', () => {
    const text = words(topicReportDoc(data({ query: { origin: 'PK', commodity: 99999 }, commodityName: null })));
    expect(text).toContain(PDF_COPY.commodityNumber(99999));
    expect(text).not.toContain(PDF_COPY.allCommodities);
    // With no commodity in the query, the report says all commodities.
    expect(words(topicReportDoc(data()))).toContain(PDF_COPY.allCommodities);
  });

  it('falls back to a plain label for a hazard the names do not know', () => {
    const d = data({ hazardNames: {} });
    expect(words(topicReportDoc(d))).toContain(PDF_COPY.hazardNumber(1));
  });

  it('prints the 8 newest notices of the 20 the dashboard returns, with their dates and firms', () => {
    const d = data();
    const text = words(topicReportDoc(d));
    for (const n of d.dashboard.latest.slice(0, 8)) {
      expect(text).toContain(n.noticeOn);
      expect(text).toContain(n.productText ?? '');
      expect(text).toContain(n.firmName ?? '');
    }
    for (const n of d.dashboard.latest.slice(8)) expect(text).not.toContain(n.productText ?? '');
  });

  it('says so when there are no notices or hazards', () => {
    const none = dashboard({
      findings: [],
      latest: [],
      totals12m: { US: 0, EU: 0, UK: 0, AU: 0 },
    });
    const text = words(topicReportDoc(data({ dashboard: none })));
    expect(text).toContain(PDF_COPY.emptyRecords);
  });

  it('shows each source as of its last sync, a monthly file by the month its data runs to', () => {
    const text = words(topicReportDoc(data()));
    expect(text).toContain(`${PDF_COPY.topicSourceNames.fda_refusals}, 2026-10-28`);
    expect(text).toContain(`${PDF_COPY.topicSourceNames.rasff}, 2026-10-27`);
    expect(text).toContain(`${PDF_COPY.topicSourceNames.uk_bn}, ${PDF_COPY.dataToMonth('2026-07')}`);
    expect(text).toContain(`${PDF_COPY.topicSourceNames.au_ifis}, ${PDF_COPY.dataToMonth('2026-08')}`);
  });

  it('is one page for the usual topic', async () => {
    const pdf = await render(topicReportDoc(data()));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });

  describe('the worst case', () => {
    // The widest letters in a mix of cases, in one unbroken run (no space to wrap at) and in words.
    const run = (n: number) => 'WMwmWMmwWM'.repeat(Math.ceil(n / 10)).slice(0, n);
    const words60 = (n: number) =>
      `${'WmWMwM'.repeat(2)} `
        .repeat(Math.ceil(n / 13))
        .slice(0, n)
        .trim();
    const SIX_DIGITS = 999_999;
    const allUnsynced: DashboardResponse['freshness'] = [];

    function worstData(text: (n: number) => string, query: TopicReportData['query']): TopicReportData {
      const wide = { US: SIX_DIGITS, EU: SIX_DIGITS, UK: SIX_DIGITS, AU: SIX_DIGITS };
      return data({
        orgName: text(60),
        originName: text(36),
        commodityName: text(60),
        query,
        hazardNames: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, text(120)])),
        dashboard: dashboard({
          months: Array.from({ length: 36 }, (_, i) => ({ month: monthBack(35 - i), ...wide })),
          totals12m: wide,
          findings: Array.from({ length: 10 }, (_, i) => ({ hazardId: i + 1, count: SIX_DIGITS * 4, byDestination: wide })),
          latest: Array.from({ length: 20 }, (_, i) =>
            noticeItem(i + 1, { productText: text(200), firmName: text(100), title: text(100), hazardIds: [1, 2, 3, 4, 5, 6] }),
          ),
          historyFrom: '2023-11-01',
          // Every source unsynced: the longest data-dates wording.
          freshness: allUnsynced,
        }),
      });
    }

    const everyDestination = { origin: 'PK', commodity: 101, destination: [...DESTINATIONS] as Destination[] };

    it.each([
      ['unbroken wide letters', run],
      ['words of wide letters', words60],
    ])('stays on one page with %s in every name, 6-digit counts and no source synced', async (_name, text) => {
      const doc = topicReportDoc(worstData(text, everyDestination));
      expect(words(doc)).toContain(PDF_COPY.notSynced);
      expect(pageCount(await render(doc))).toBe(1);
    });

    it('stays on one page with a single destination too', async () => {
      const doc = topicReportDoc(worstData(run, { origin: 'PK', commodity: 101, destination: ['US'] }));
      expect(pageCount(await render(doc))).toBe(1);
    });

    it('breaks an unbroken name inside its cell rather than letting it run on', () => {
      const doc = topicReportDoc(worstData(run, everyDestination));
      const broken = JSON.stringify(doc.content).match(/"wordBreak":"break-all"/g) ?? [];
      // The account, the commodity, the hazards (10) and the notices (8 products, 8 firms, 8 hazard lists) are all set to break.
      expect(broken.length).toBeGreaterThanOrEqual(2 + 10 + 24);
    });
  });

  it('renders Vietnamese letters in an account or origin name', async () => {
    const doc = topicReportDoc(data({ orgName: 'Nhà xuất khẩu Việt Nam', originName: 'Việt Nam' }));
    expect(words(doc)).toContain('Nhà xuất khẩu Việt Nam');
    expect(pageCount(await render(doc))).toBe(1);
  });
});
