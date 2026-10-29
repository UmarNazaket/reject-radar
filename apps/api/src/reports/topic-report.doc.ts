import { type DashboardQuery, type DashboardResponse, DESTINATIONS, type Destination, type NoticeItem } from '@rejectradar/contracts';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { PDF_COPY } from './pdf-copy';
import {
  breakable,
  clip,
  dataCell,
  dataDatesLine,
  empty,
  grid,
  GRID_LAYOUT,
  MUTED,
  notesBox,
  PAGE,
  reportHeader,
  rule,
  section,
  th,
} from './pdf-layout';

/**
 * What the topic report is built from: the query, the dashboard's answer for it, and the English names the dashboard
 * leaves as ids. `generatedAt` is a UTC date, `YYYY-MM-DD`.
 */
export interface TopicReportData {
  orgName: string;
  generatedAt: string;
  query: DashboardQuery;
  /** The origin country's English name. */
  originName: string;
  /** The English label of the query's commodity; null when the query has none. */
  commodityName: string | null;
  /** English hazard labels by hazard id. */
  hazardNames: Readonly<Record<number, string>>;
  dashboard: DashboardResponse;
}

/** Notices listed in the report (the dashboard returns 20; 8 leave real room on the page in the worst case). */
/** The commodity name is cut here, so the topic line stays within two lines. */
const COMMODITY_CLIP = 45;

const NOTICES_SHOWN = 8;

/** The dashboard's source for each destination, and which freshness entry says how current it is. */
const SOURCE_OF: Record<Destination, string> = {
  US: 'fda_refusals',
  EU: 'rasff',
  UK: 'uk_bn',
  AU: 'au_ifis',
};

const hazardName = (data: TopicReportData, id: number): string => data.hazardNames[id] ?? PDF_COPY.hazardNumber(id);

/** The destinations the report is about, in the dashboard's order. */
const shownDestinations = (query: DashboardQuery): Destination[] =>
  DESTINATIONS.filter((d) => query.destination === undefined || query.destination.includes(d));

/**
 * A right-aligned count. The month cells are about 22 pt wide, which holds five digits; a longer count is set smaller, so it
 * stays in its cell and never wraps (a number has no space to wrap at).
 */
const num = (value: number): TableCell => {
  const digits = String(value).length;
  return { text: String(value), alignment: 'right', ...(digits <= 5 ? {} : { fontSize: digits === 6 ? 6 : 5 }) };
};

/** `[US, EU, ..., total]`: one cell for each destination shown, and a total when there is more than one. */
function countCells(counts: Record<Destination, number>, destinations: readonly Destination[], total: number): TableCell[] {
  return [...destinations.map((d) => num(counts[d])), ...(destinations.length > 1 ? [num(total)] : [])];
}

/** The right-hand column headers: one for each destination, and a total when there is more than one. */
const countHeaders = (destinations: readonly Destination[]): TableCell[] => [
  ...destinations.map((d) => th(d, 'right')),
  ...(destinations.length > 1 ? [th(PDF_COPY.total, 'right')] : []),
];

const sum = (counts: Record<Destination, number>, destinations: readonly Destination[]): number =>
  destinations.reduce((acc, d) => acc + counts[d], 0);

// ---------- sections ----------

function topicBlock(data: TopicReportData): Content[] {
  const { query } = data;
  const destinations = query.destination === undefined ? PDF_COPY.allDestinations : shownDestinations(query).join(', ');
  const commodityName =
    data.commodityName !== null
      ? clip(data.commodityName, COMMODITY_CLIP)
      : query.commodity === undefined
        ? null
        : // The dashboard does not check that the id exists, so a commodity without a label is still a filter and is named by its id.
          PDF_COPY.commodityNumber(query.commodity);
  const commodity = commodityName ?? PDF_COPY.allCommodities;
  return [
    {
      text: `${clip(data.originName, 36)} (${query.origin})`,
      ...breakable(data.originName),
      fontSize: 14,
      bold: true,
      margin: [0, 2, 0, 1],
    },
    {
      text: [
        { text: `${PDF_COPY.commodityLabel}: `, color: MUTED },
        { text: commodity, ...breakable(commodity) },
        { text: `   ${PDF_COPY.destinationsLabel}: `, color: MUTED },
        destinations,
      ],
    },
  ];
}

function totalsBlock(data: TopicReportData, destinations: readonly Destination[]): Content[] {
  const { totals12m } = data.dashboard;
  return [
    grid(
      destinations.length > 1 ? ['*', ...destinations.map(() => 52), 52] : ['*', 52],
      [th(PDF_COPY.totals12m), ...countHeaders(destinations)],
      [[{ text: PDF_COPY.noticesLabel }, ...countCells(totals12m, destinations, sum(totals12m, destinations))]],
    ),
  ];
}

/** How many tables the months are split across: 36 months make three blocks of 12, so the block stays short. */
const monthBlocks = (months: number): number => (months > 24 ? 3 : months > 12 ? 2 : 1);

/** The months as rows and the destinations as columns, in blocks side by side so 36 months stay a short block. */
function monthsBlock(data: TopicReportData, destinations: readonly Destination[]): Content[] {
  const { months } = data.dashboard;
  const blocks = monthBlocks(months.length);
  const size = Math.ceil(months.length / blocks);
  const table = (rows: DashboardResponse['months']): Content => {
    const widths: (number | string)[] = [36, ...destinations.map(() => '*'), ...(destinations.length > 1 ? ['*'] : [])];
    return {
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths,
        body: [
          [th(PDF_COPY.month), ...countHeaders(destinations)],
          ...rows.map((row): TableCell[] => [{ text: row.month }, ...countCells(row, destinations, sum(row, destinations))]),
        ],
      },
      layout: {
        ...GRID_LAYOUT,
        paddingTop: () => 1,
        paddingBottom: () => 1,
        paddingLeft: () => 2,
        paddingRight: () => 2,
      },
    };
  };
  const chunks = Array.from({ length: blocks }, (_, i) => months.slice(i * size, (i + 1) * size)).filter((rows) => rows.length > 0);
  return [
    section(PDF_COPY.monthlyCounts),
    ...(data.dashboard.historyFrom === null
      ? []
      : [
          {
            text: PDF_COPY.historyFrom(data.dashboard.historyFrom),
            color: MUTED,
            margin: [0, 0, 0, 2],
          } as Content,
        ]),
    {
      columns: chunks.map((rows) => ({ width: '*', stack: [table(rows)] })),
      columnGap: 10,
    },
  ];
}

function hazardsBlock(data: TopicReportData, destinations: readonly Destination[]): Content[] {
  const { findings } = data.dashboard;
  const table =
    findings.length === 0
      ? empty()
      : grid(
          ['*', ...destinations.map(() => 40), ...(destinations.length > 1 ? [40] : [])],
          [th(PDF_COPY.hazard), ...countHeaders(destinations)],
          findings.map((f): TableCell[] => [
            dataCell(hazardName(data, f.hazardId), 36),
            ...countCells(f.byDestination, destinations, f.count),
          ]),
          1,
        );
  return [section(PDF_COPY.topHazards), table];
}

function noticesBlock(data: TopicReportData): Content[] {
  const latest = data.dashboard.latest.slice(0, NOTICES_SHOWN);
  const hazardList = (notice: NoticeItem): string => notice.hazardIds.map((id) => hazardName(data, id)).join(', ');
  const table =
    latest.length === 0
      ? empty()
      : grid(
          [48, 20, '*', 118, 130],
          [th(PDF_COPY.date), th(PDF_COPY.noticeTo), th(PDF_COPY.noticeProduct), th(PDF_COPY.noticeFirm), th(PDF_COPY.noticeHazards)],
          latest.map((n): TableCell[] => [
            { text: n.noticeOn },
            { text: n.destination },
            dataCell(n.productText ?? n.title ?? '', 40),
            dataCell(n.firmName ?? '', 22),
            dataCell(hazardList(n), 28),
          ]),
          1,
        );
  return [section(PDF_COPY.latestNotices), table];
}

function sourcesBox(data: TopicReportData, destinations: readonly Destination[]): Content {
  const sources = destinations.map((d) => SOURCE_OF[d]);
  const lines: Content[] = [
    {
      text: [{ text: `${PDF_COPY.dataDates}: `, bold: true }, dataDatesLine(data.dashboard.freshness, sources, PDF_COPY.topicSourceNames)],
    },
    {
      text: [{ text: `${PDF_COPY.sourcesTitle}: `, bold: true }, destinations.map((d) => PDF_COPY.topicSources[d]).join(' ')],
      margin: [0, 2, 0, 0],
    },
    { text: PDF_COPY.topicNote, color: MUTED, margin: [0, 2, 0, 0] },
  ];
  // The notes are set a little smaller than the tables, which leaves room for the disclaimer below them on the one page.
  return notesBox([{ stack: lines, fontSize: 7 }]);
}

/**
 * The one-page topic report (spec §9.9, P6-D12) as a pdfmake document definition, built from the same figures as
 * `GET /v1/dashboards/topic`: the monthly counts as a table (months as rows, destinations as columns, in two blocks side
 * by side), the 12-month totals, the top hazards and the 10 newest notices. It is a pure function of its input; the text,
 * tables and plain boxes are all pdfmake draws, so a chart is not attempted. Names and notices are clipped, so the worst
 * case of 36 months and every destination still fits one page.
 */
export function topicReportDoc(data: TopicReportData): TDocumentDefinitions {
  const destinations = shownDestinations(data.query);
  return {
    ...PAGE,
    info: {
      title: `${PDF_COPY.product} ${PDF_COPY.topicReport}`,
      creator: PDF_COPY.product,
      producer: PDF_COPY.product,
    },
    content: [
      reportHeader(PDF_COPY.topicReport, data.orgName, data.generatedAt),
      rule(),
      ...topicBlock(data),
      ...totalsBlock(data, destinations),
      ...monthsBlock(data, destinations),
      ...hazardsBlock(data, destinations),
      ...noticesBlock(data),
      sourcesBox(data, destinations),
      { text: PDF_COPY.disclaimer, color: MUTED, margin: [0, 5, 0, 0] },
    ],
  };
}
