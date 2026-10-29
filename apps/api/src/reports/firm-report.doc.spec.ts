import type { ApiEnv, FirmAuFailure, FirmListing, FirmProfileResponse, FirmRefusal } from '@rejectradar/contracts';
import { firmReportDoc, summaryCounts } from './firm-report.doc';
import { PDF_COPY } from './pdf-copy';
import { PdfRenderer } from './pdf-renderer';
import { pageCount, textOf } from './pdf-test-utils';

const GENERATED_AT = '2026-10-29';
const render = (doc: ReturnType<typeof firmReportDoc>) => new PdfRenderer({ NODE_ENV: 'test' } as ApiEnv).render('firm', doc);

/** The day `days` before the report date, `YYYY-MM-DD`. */
const ago = (days: number) => new Date(Date.parse(GENERATED_AT) - days * 86_400_000).toISOString().slice(0, 10);

const UNSAFE = 'The article appears to contain a pesticide chemical residue that is unsafe within the meaning of section 408(a).';

const refusal = (i: number, over: Partial<FirmRefusal> = {}): FirmRefusal => ({
  id: i,
  refusalDate: ago(10 + i * 30),
  productCode: '25AEC99',
  productDesc: `Basmati rice lot ${i}`,
  charges: [{ code: '2561', name: 'PESTICIDE', description: UNSAFE }],
  fdaSampleAnalysis: true,
  privateLabAnalysis: null,
  url: null,
  ...over,
});
const listing = (i: number, over: Partial<FirmListing> = {}): FirmListing => ({
  id: i,
  alertNumber: `99-${10 + i}`,
  alertTitle: `Detention Without Physical Examination, alert number ${i}`,
  list: 'red',
  listedOn: ago(20 + i * 40),
  removedOn: null,
  url: 'https://www.accessdata.fda.gov/cms_ia/importalert_99-08.html',
  products: [],
  ...over,
});
const auFailure = (i: number, over: Partial<FirmAuFailure> = {}): FirmAuFailure => ({
  id: i,
  failedOn: ago(15 + i * 45),
  reportMonth: ago(15 + i * 45).slice(0, 7),
  productDesc: `White rice sample ${i}`,
  testApplied: 'Pesticide residues',
  reason: null,
  resultText: `tricyclazole 0.0${i} mg/kg`,
  holdingOrderMatch: false,
  url: null,
  ...over,
});

const NO_FACTS: FirmProfileResponse['facts'] = {
  import_alert_red: [],
  import_alert_green: [],
  fda_refusals_12m: 0,
  fda_refusals_3y: 0,
  au_failed_3y: 0,
  au_holding_order: false,
  top_hazards_3y: [],
};

function profile(over: Partial<FirmProfileResponse> = {}): FirmProfileResponse {
  return {
    id: 7,
    displayName: 'ZARFEEN RICE MILLS (PVT) LTD',
    altNames: ['ZARFEEN RICE MILLS PRIVATE LIMITED'],
    feis: ['3001234567'],
    address: {
      line: '12 Industrial Estate, Kot Lakhpat',
      city: 'Lahore',
      region: 'Punjab',
      postalCode: '54000',
      countryCode: 'PK',
    },
    commodityIds: [101],
    firstSeen: '2022-01-10',
    lastNoticeOn: ago(10),
    facts: {
      import_alert_red: [{ alert: '99-08', listed_on: ago(60) }],
      import_alert_green: [],
      fda_refusals_12m: 3,
      fda_refusals_3y: 8,
      au_failed_3y: 8,
      au_holding_order: false,
      top_hazards_3y: ['pesticide_residues', 'filth'],
    },
    metrics: {
      fda_refusals_total: 8,
      au_failed_total: 8,
      import_alert_red_current: 1,
      import_alert_green_current: 0,
    },
    refusals: Array.from({ length: 8 }, (_, i) => refusal(i + 1)),
    listings: Array.from({ length: 8 }, (_, i) => listing(i + 1)),
    auFailures: Array.from({ length: 8 }, (_, i) => auFailure(i + 1)),
    freshness: [
      {
        source: 'fda_refusals',
        lastSuccessAt: '2026-10-28T06:00:00.000Z',
        stale: false,
        latestMonth: null,
      },
      {
        source: 'import_alerts',
        lastSuccessAt: '2026-10-29T06:00:00.000Z',
        stale: false,
        latestMonth: null,
      },
      {
        source: 'au_ifis',
        lastSuccessAt: '2026-10-20T06:00:00.000Z',
        stale: false,
        latestMonth: '2026-08',
      },
    ],
    lookup: { charged: true, used: 1, limit: 100 },
    ...over,
  };
}

const doc = (p: FirmProfileResponse = profile(), orgName = 'Indus Valley Agro Exports') =>
  firmReportDoc({ orgName, profile: p, generatedAt: GENERATED_AT });
const words = (d: ReturnType<typeof firmReportDoc>) => textOf(d).join('\n');

describe('firmReportDoc', () => {
  it('names the account, the firm, the report date, the sources and the disclaimer', () => {
    const text = words(doc());
    expect(text).toContain('Indus Valley Agro Exports');
    expect(text).toContain('ZARFEEN RICE MILLS (PVT) LTD');
    expect(text).toContain('ZARFEEN RICE MILLS PRIVATE LIMITED');
    expect(text).toContain('3001234567');
    expect(text).toContain(GENERATED_AT);
    expect(text).toContain(PDF_COPY.disclaimer);
    expect(text).toContain(PDF_COPY.sources);
    expect(text).toContain('99-08');
  });

  it('is A4', () => {
    expect(doc().pageSize).toBe('A4');
  });

  it('shows the 5 newest refusals, listings and Australian failures of 8', () => {
    const text = words(doc());
    for (const i of [1, 2, 3, 4, 5]) {
      expect(text).toContain(`Basmati rice lot ${i}`);
      expect(text).toContain(`99-${10 + i}`);
      expect(text).toContain(`White rice sample ${i}`);
    }
    for (const i of [6, 7, 8]) {
      expect(text).not.toContain(`Basmati rice lot ${i}`);
      expect(text).not.toContain(`99-${10 + i}`);
      expect(text).not.toContain(`White rice sample ${i}`);
    }
  });

  it('shows 5 of 7 FEIs and says how many more there are', () => {
    const feis = Array.from({ length: 7 }, (_, i) => `30000000${10 + i}`);
    const text = words(doc(profile({ feis })));
    for (const fei of feis.slice(0, 5)) expect(text).toContain(fei);
    for (const fei of feis.slice(5)) expect(text).not.toContain(fei);
    expect(text).toContain(PDF_COPY.more(2));
    // Up to the limit nothing is cut, so there is no marker for the FEIs.
    expect(words(doc(profile({ feis: feis.slice(0, 5), altNames: [] })))).not.toMatch(/\+\d+ more/);
  });

  it('shows 2 of 4 alternate names and says how many more there are', () => {
    const altNames = ['ALPHA FOODS ONE', 'BETA FOODS TWO', 'GAMMA FOODS THREE', 'DELTA FOODS FOUR'];
    const text = words(doc(profile({ altNames, feis: [] })));
    expect(text).toContain('ALPHA FOODS ONE');
    expect(text).toContain('BETA FOODS TWO');
    expect(text).not.toContain('GAMMA FOODS THREE');
    expect(text).not.toContain('DELTA FOODS FOUR');
    expect(text).toContain(PDF_COPY.more(2));
    expect(words(doc(profile({ altNames: altNames.slice(0, 2), feis: [] })))).not.toMatch(/\+\d+ more/);
  });

  it('puts the newest first even when the records arrive in another order', () => {
    const p = profile();
    p.refusals = [...p.refusals].reverse();
    const text = words(doc(p));
    expect(text).toContain('Basmati rice lot 1');
    expect(text).not.toContain('Basmati rice lot 8');
  });

  it("never says clean or safe (FDA's own 'unsafe' is quoted, not ours)", () => {
    const withRecords = words(doc());
    const without = words(
      doc(
        profile({
          refusals: [],
          listings: [],
          auFailures: [],
          facts: NO_FACTS,
        }),
      ),
    );
    expect(withRecords).toContain('unsafe');
    for (const text of [withRecords, without]) expect(text).not.toMatch(/\b(clean|safe)\b/i);
  });

  it("quotes the agency's charge text and says whose words they are", () => {
    const text = words(doc());
    expect(text).toContain(`“${UNSAFE}”`);
    expect(text).toContain(PDF_COPY.agencyWording);
  });

  it('falls back to the charge name, then the code, when FDA gives no description', () => {
    const p = profile({
      refusals: [
        refusal(1, {
          charges: [{ code: '1111', name: 'FILTH', description: null }],
        }),
        refusal(2, {
          charges: [{ code: '9999', name: null, description: null }],
        }),
      ],
    });
    const text = words(doc(p));
    expect(text).toContain('“FILTH”');
    expect(text).toContain('9999');
    expect(text).not.toContain('“”');
  });

  it('says so when a firm has no records, and shows the absence of a red listing as a fact', () => {
    const text = words(
      doc(
        profile({
          refusals: [],
          listings: [],
          auFailures: [],
          facts: NO_FACTS,
        }),
      ),
    );
    expect(text).toContain(PDF_COPY.emptyRecords);
    expect(text).toContain(PDF_COPY.noRedList);
  });

  it('counts the three-year summary by age of record', () => {
    const p = profile({
      refusals: [
        refusal(1, { refusalDate: ago(30) }),
        refusal(2, { refusalDate: ago(400) }),
        refusal(3, { refusalDate: ago(800) }),
        refusal(4, { refusalDate: ago(900) }),
        refusal(5, { refusalDate: ago(1200) }),
      ],
      listings: [listing(1, { listedOn: ago(100) }), listing(2, { listedOn: null })],
      auFailures: [
        auFailure(1, { failedOn: ago(500), reportMonth: ago(500).slice(0, 7) }),
        auFailure(2, { failedOn: null, reportMonth: '2026-09' }),
      ],
    });
    expect(summaryCounts(p, GENERATED_AT)).toEqual({
      refusals: [1, 1, 2],
      listings: [1, 0, 0],
      auFailures: [1, 1, 0],
    });
  });

  it('is one page with 8 of each record', async () => {
    const pdf = await render(doc());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });

  it('stays on one page when every field is as long as it can be, in wide capital letters', async () => {
    // FDA publishes names and products in capitals. Long runs of words wrap; clipping keeps each cell to a line or two.
    const long = (n: number, w = 'WIDEWORDS') => `${w} `.repeat(n).trim();
    const p = profile({
      displayName: long(30, 'EXPORTERS'),
      altNames: [long(30), long(30), long(30)],
      feis: ['1', '2', '3', '4', '5'].map((x) => x.repeat(10)),
      address: { line: long(60), city: long(20), region: long(20), postalCode: long(5), countryCode: 'PK' },
      facts: {
        ...profile().facts,
        import_alert_red: [1, 2, 3, 4].map((i) => ({ alert: `99-0${i}`, listed_on: ago(60) })),
        au_holding_order: true,
      },
      refusals: Array.from({ length: 8 }, (_, i) =>
        refusal(i + 1, {
          productDesc: long(80),
          charges: Array.from({ length: 6 }, (_, c) => ({ code: String(1000 + c), name: long(20), description: long(120) })),
        }),
      ),
      listings: Array.from({ length: 8 }, (_, i) => listing(i + 1, { alertTitle: long(120) })),
      auFailures: Array.from({ length: 8 }, (_, i) =>
        auFailure(i + 1, { productDesc: long(80), testApplied: long(60), resultText: long(120), reason: long(60) }),
      ),
    });
    const pdf = await render(doc(p, long(80, 'Account')));
    expect(pageCount(pdf)).toBe(1);
  });

  it('renders a Vietnamese name and its diacritics', async () => {
    const name = 'Công ty Thực phẩm Đông Á';
    const d = doc(profile({ displayName: name, altNames: ['Cty TNHH Thực Phẩm Đông Á'] }), 'Nhà xuất khẩu Việt Nam');
    expect(words(d)).toContain(name);
    const pdf = await render(d);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });
});
