import type { FirmAuFailure, FirmListing, FirmProfileResponse, FirmRefusal } from '@rejectradar/contracts';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { PDF_COPY } from './pdf-copy';
import {
  clip,
  dataDatesLine,
  empty,
  grid,
  MUTED,
  notesBox,
  PAGE,
  quote,
  reportHeader,
  RULE,
  rule,
  section,
  th,
  withMore,
} from './pdf-layout';

/** What the firm report is built from. `generatedAt` is a UTC date, `YYYY-MM-DD`. */
export interface FirmReportData {
  orgName: string;
  profile: FirmProfileResponse;
  generatedAt: string;
}

/** How many records of each kind the one page shows (P6-D12). */
const SHOWN = 5;
/** FDA charges shown for one refusal; the rest are counted. */
const CHARGES_SHOWN = 1;
/** FEIs and alternate names shown in the firm header; the rest are counted. */
const FEIS_SHOWN = 5;
const ALT_NAMES_SHOWN = 2;

const RED = '#C2410C';
const AMBER_FILL = '#FEF3C7';
const AMBER_INK = '#854D0E';
const AMBER_RULE = '#E3B341';
const GREY_FILL = '#EDF0F4';
const GREY_INK = '#334155';

// ---------- dates ----------

/** `date` (`YYYY-MM-DD`) moved back by `months`, a day past the end of a short month landing on its last day as PostgreSQL does. */
function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** The date a failed test counts under: its own day, else the first of its report month. */
const auDate = (failure: FirmAuFailure): string => failure.failedOn ?? `${failure.reportMonth}-01`;

/** Records by age at `generatedAt`: the last 12 months, 12 to 24, 24 to 36. Older records and records without a date are not counted. */
function byAge(dates: readonly (string | null)[], generatedAt: string): [number, number, number] {
  const edges = [12, 24, 36].map((months) => monthsBefore(generatedAt, months));
  const counts: [number, number, number] = [0, 0, 0];
  for (const date of dates) {
    if (date === null) continue;
    if (date > edges[0]) counts[0] += 1;
    else if (date > edges[1]) counts[1] += 1;
    else if (date > edges[2]) counts[2] += 1;
  }
  return counts;
}

/** The three-year summary table: each kind of record counted by age, over all the records the profile holds. */
export function summaryCounts(profile: FirmProfileResponse, generatedAt: string) {
  return {
    refusals: byAge(
      profile.refusals.map((r) => r.refusalDate),
      generatedAt,
    ),
    listings: byAge(
      profile.listings.map((l) => l.listedOn),
      generatedAt,
    ),
    auFailures: byAge(profile.auFailures.map(auDate), generatedAt),
  };
}

// ---------- building blocks ----------

type Tone = 'alert' | 'warn' | 'plain';

/** A plain box with one line of text: the facts row. */
function box(text: string, tone: Tone): Content {
  const style = {
    alert: { fillColor: RED, color: '#FFFFFF', border: RED },
    warn: { fillColor: AMBER_FILL, color: AMBER_INK, border: AMBER_RULE },
    plain: { fillColor: GREY_FILL, color: GREY_INK, border: RULE },
  }[tone];
  return {
    table: {
      body: [[{ text, bold: true, color: style.color, fillColor: style.fillColor }]],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => style.border,
      vLineColor: () => style.border,
      paddingTop: () => 2.5,
      paddingBottom: () => 2.5,
      paddingLeft: () => 6,
      paddingRight: () => 6,
    },
  };
}

// ---------- sections ----------

function firmBlock(profile: FirmProfileResponse): Content[] {
  const altNames = withMore(profile.altNames, ALT_NAMES_SHOWN);
  const alsoPublished = altNames.shown.map((name) => clip(name, 55));
  const feis = withMore(profile.feis, FEIS_SHOWN);
  const address = [
    profile.address.line,
    profile.address.city,
    profile.address.region,
    profile.address.postalCode,
    profile.address.countryCode,
  ]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');
  const rows: TableCell[][] = [];
  if (profile.feis.length > 0) {
    // The marker stays outside the clipped list, so a long list of FEIs cannot cut it off.
    rows.push([
      { text: PDF_COPY.fei, color: MUTED },
      {
        text: [clip(feis.shown.join(', '), 100), ...(feis.more === null ? [] : [{ text: ` ${feis.more}`, color: MUTED }])],
      },
    ]);
  }
  rows.push([{ text: PDF_COPY.address, color: MUTED }, { text: address === '' ? PDF_COPY.noAddress : clip(address, 160) }]);
  return [
    {
      text: clip(profile.displayName, 80),
      fontSize: 14,
      bold: true,
      margin: [0, 2, 0, 1],
    },
    ...(alsoPublished.length > 0
      ? [
          {
            text: `${PDF_COPY.alsoPublishedAs} ${alsoPublished.join('; ')}${altNames.more === null ? '' : ` ${altNames.more}`}`,
            color: MUTED,
          } as Content,
        ]
      : []),
    {
      table: { widths: [112, '*'], body: rows },
      layout: 'noBorders',
      margin: [0, 2, 0, 0],
    },
  ];
}

function factsBlock(profile: FirmProfileResponse): Content[] {
  const { facts } = profile;
  const [firstRed, ...moreRed] = facts.import_alert_red;
  const red =
    firstRed === undefined
      ? box(PDF_COPY.noRedList, 'plain')
      : box(
          [
            PDF_COPY.onRedList,
            firstRed.listed_on === null ? firstRed.alert : `${firstRed.alert} ${PDF_COPY.since} ${firstRed.listed_on}`,
            ...(moreRed.length > 0 ? [`(${PDF_COPY.more(moreRed.length)})`] : []),
          ].join(' '),
          'alert',
        );
  // Two rows of boxes, each of which fits on one line.
  const row = (boxes: Content[], first: boolean): Content => ({
    columns: boxes.map((b) => ({ width: 'auto', stack: [b] })),
    columnGap: 6,
    margin: [0, first ? 0 : 4, 0, 0],
  });
  return [
    section(PDF_COPY.facts),
    row([red, ...(facts.au_holding_order ? [box(PDF_COPY.holdingOrder, 'warn')] : [])], true),
    row(
      [
        box(`${PDF_COPY.refusals12m}: ${facts.fda_refusals_12m}`, facts.fda_refusals_12m > 0 ? 'warn' : 'plain'),
        box(`${PDF_COPY.refusals3y}: ${facts.fda_refusals_3y}`, 'plain'),
        box(`${PDF_COPY.auFailed3y}: ${facts.au_failed_3y}`, facts.au_failed_3y > 0 ? 'warn' : 'plain'),
      ],
      false,
    ),
  ];
}

const hazardLabel = (id: string): string => PDF_COPY.hazardLabels[id] ?? id.replace(/_/g, ' ');

function summaryBlock(profile: FirmProfileResponse, generatedAt: string): Content[] {
  const counts = summaryCounts(profile, generatedAt);
  const numbers = (values: readonly number[]): TableCell[] => values.map((v) => ({ text: String(v), alignment: 'right' as const }));
  const hazards = profile.facts.top_hazards_3y.slice(0, 3).map(hazardLabel);
  return [
    section(PDF_COPY.summary),
    {
      columns: [
        {
          width: '*',
          stack: [
            grid(
              ['*', 52, 52, 52],
              [
                th(PDF_COPY.recordColumn),
                th(PDF_COPY.last12, 'right'),
                th(PDF_COPY.months12to24, 'right'),
                th(PDF_COPY.months24to36, 'right'),
              ],
              [
                [{ text: PDF_COPY.rowRefusals }, ...numbers(counts.refusals)],
                [{ text: PDF_COPY.rowListings }, ...numbers(counts.listings)],
                [{ text: PDF_COPY.rowAuFailures }, ...numbers(counts.auFailures)],
              ],
            ),
          ],
        },
        {
          width: 150,
          stack: [
            { text: PDF_COPY.hazards, bold: true },
            {
              text: hazards.length > 0 ? hazards.join(', ') : PDF_COPY.noHazards,
              margin: [0, 2, 0, 0],
            },
          ],
        },
      ],
      columnGap: 16,
    },
  ];
}

const labText = (r: FirmRefusal): string =>
  r.fdaSampleAnalysis === true && r.privateLabAnalysis === true
    ? PDF_COPY.bothLabs
    : r.fdaSampleAnalysis === true
      ? PDF_COPY.fdaLab
      : r.privateLabAnalysis === true
        ? PDF_COPY.privateLab
        : PDF_COPY.noSample;

/** The charges of a refusal in FDA's own words, quoted; a charge FDA's list does not describe shows its code, unquoted. */
function chargeCell(r: FirmRefusal): Content {
  if (r.charges.length === 0) return { text: '' };
  const parts: Content[] = r.charges.slice(0, CHARGES_SHOWN).flatMap((charge): Content[] => {
    const wording = charge.description ?? charge.name;
    if (wording === null) return [{ text: PDF_COPY.chargeCode(charge.code) }];
    return [{ text: quote(clip(wording, 120)) }, { text: ` (${charge.code})`, color: MUTED }];
  });
  const more = r.charges.length - CHARGES_SHOWN;
  if (more > 0) parts.push({ text: ` ${PDF_COPY.more(more)}`, color: MUTED });
  return { text: parts };
}

function refusalsBlock(profile: FirmProfileResponse): Content[] {
  const latest = [...profile.refusals].sort((a, b) => b.refusalDate.localeCompare(a.refusalDate)).slice(0, SHOWN);
  const table =
    latest.length === 0
      ? empty()
      : grid(
          [48, 130, '*', 66],
          [th(PDF_COPY.date), th(PDF_COPY.productColumn), th(PDF_COPY.charges), th(PDF_COPY.sampleBy)],
          latest.map((r) => [
            { text: r.refusalDate },
            {
              text: clip(r.productDesc ?? r.productCode ?? PDF_COPY.noSample, 38),
            },
            chargeCell(r),
            { text: labText(r) },
          ]),
        );
  return [section(PDF_COPY.refusals), table];
}

function listingsBlock(profile: FirmProfileResponse): Content[] {
  const latest = [...profile.listings].sort((a, b) => (b.listedOn ?? '').localeCompare(a.listedOn ?? '') || b.id - a.id).slice(0, SHOWN);
  const row = (l: FirmListing): TableCell[] => [
    { text: l.alertNumber, bold: true },
    { text: quote(clip(l.alertTitle, 56)) },
    { text: l.list === 'red' ? PDF_COPY.redList : PDF_COPY.greenList },
    { text: l.listedOn ?? PDF_COPY.notDated },
    { text: l.removedOn ?? '' },
  ];
  const table =
    latest.length === 0
      ? empty()
      : grid(
          [38, '*', 30, 52, 52],
          [th(PDF_COPY.alert), th(PDF_COPY.title), th(PDF_COPY.list), th(PDF_COPY.listed), th(PDF_COPY.removed)],
          latest.map(row),
        );
  return [section(PDF_COPY.listings), table];
}

function auBlock(profile: FirmProfileResponse): Content[] {
  const latest = [...profile.auFailures].sort((a, b) => auDate(b).localeCompare(auDate(a)) || b.id - a.id).slice(0, SHOWN);
  const row = (f: FirmAuFailure): TableCell[] => [
    { text: f.failedOn ?? f.reportMonth },
    { text: clip(f.productDesc, 60) },
    { text: clip(f.testApplied ?? '', 28) },
    { text: clip(f.resultText ?? f.reason ?? '', 30) },
    {
      text: f.holdingOrderMatch === null ? '' : f.holdingOrderMatch ? PDF_COPY.yes : PDF_COPY.no,
    },
  ];
  const table =
    latest.length === 0
      ? empty()
      : grid(
          [48, '*', 96, 104, 64],
          [th(PDF_COPY.date), th(PDF_COPY.productColumn), th(PDF_COPY.test), th(PDF_COPY.result), th(PDF_COPY.holdingOrderColumn)],
          latest.map(row),
        );
  return [section(PDF_COPY.auFailures), table];
}

/** When each source was last read successfully; a monthly file shows the month its data runs to. */
const dataDates = (profile: FirmProfileResponse): string =>
  dataDatesLine(profile.freshness, Object.keys(PDF_COPY.sourceNames), PDF_COPY.sourceNames);

function sourcesBox(profile: FirmProfileResponse): Content {
  return notesBox([
    {
      text: [{ text: `${PDF_COPY.dataDates}: `, bold: true }, dataDates(profile)],
    },
    { text: PDF_COPY.sources, margin: [0, 2, 0, 0] },
    {
      text: PDF_COPY.agencyWording,
      color: MUTED,
      margin: [0, 2, 0, 0],
    },
    {
      text: PDF_COPY.noBorderFirms,
      color: MUTED,
      margin: [0, 2, 0, 0],
    },
  ]);
}

/**
 * The one-page firm report (spec §9.9, P6-D12) as a pdfmake document definition: text, tables and plain boxes on A4, after
 * the design board `Report.dc.html`. It is a pure function of its input, so specs assert the content on the definition;
 * the rendered file's text is glyph-encoded. Records are cut to the latest {@link SHOWN} of each kind and long text is clipped,
 * so a firm with any number of records still fits one page. Agency charge text is quoted as the agency's own wording.
 */
export function firmReportDoc(data: FirmReportData): TDocumentDefinitions {
  const { profile } = data;
  return {
    ...PAGE,
    info: {
      title: `${PDF_COPY.product} ${PDF_COPY.firmReport}`,
      creator: PDF_COPY.product,
      producer: PDF_COPY.product,
    },
    content: [
      reportHeader(PDF_COPY.firmReport, data.orgName, data.generatedAt),
      rule(),
      ...firmBlock(profile),
      ...factsBlock(profile),
      ...summaryBlock(profile, data.generatedAt),
      ...refusalsBlock(profile),
      ...listingsBlock(profile),
      ...auBlock(profile),
      sourcesBox(profile),
      { text: PDF_COPY.disclaimer, color: MUTED, margin: [0, 8, 0, 0] },
    ],
  };
}
