import type { SourceFreshness } from '@rejectradar/contracts';
import type { Content, TableCell } from 'pdfmake/interfaces';
import { PDF_COPY } from './pdf-copy';

/** The colours and building blocks the one-page reports share (firm and topic), so the two look like one product. */
export const INK = '#121A2B';
export const MUTED = '#3F4A5C';
export const RULE = '#C5CCD6';
export const HEADER_FILL = '#F4F5F7';

/** A string cut to `max` characters, with an ellipsis when it was longer. Long agency text must not push a report to a second page. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
/** Agency wording, in quotation marks. */
export const quote = (text: string): string => `“${text}”`;

/** `items` cut to the first `shown`, plus the visible "+n more" marker when some were left out. */
export function withMore<T>(items: readonly T[], shown: number): { shown: T[]; more: string | null } {
  const rest = items.length - shown;
  return {
    shown: items.slice(0, shown),
    more: rest > 0 ? PDF_COPY.more(rest) : null,
  };
}

export const section = (title: string): Content => ({
  text: title.toUpperCase(),
  style: 'section',
});

export const th = (text: string, alignment: 'left' | 'right' = 'left'): TableCell => ({
  text,
  bold: true,
  fillColor: HEADER_FILL,
  alignment,
});

export const empty = (): Content => ({
  text: PDF_COPY.emptyRecords,
  color: MUTED,
  margin: [0, 0, 0, 2],
});

/** The table layout of a record table: hairlines between rows, tight padding. */
export const GRID_LAYOUT = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => RULE,
  paddingTop: () => 1.5,
  paddingBottom: () => 1.5,
  paddingLeft: () => 4,
  paddingRight: () => 4,
};

/** A bordered table whose rows never split across pages; `pad` is the space above and below a row's text. */
export function grid(widths: (number | string)[], header: TableCell[], rows: TableCell[][], pad = 1.5): Content {
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths,
      body: [header, ...rows],
    },
    layout: { ...GRID_LAYOUT, paddingTop: () => pad, paddingBottom: () => pad },
  };
}

/** The heavy line under the header: an empty one-cell table with a top border, so the page holds no drawing. */
export function rule(): Content {
  return {
    table: { widths: ['*'], body: [[{ text: '', fontSize: 1 }]] },
    layout: {
      hLineWidth: (i: number) => (i === 0 ? 1.5 : 0),
      vLineWidth: () => 0,
      hLineColor: () => '#0F1A2C',
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 3],
  };
}

/** The page header: the product and the report's name on the left, the account and the date on the right. */
export function reportHeader(title: string, orgName: string, generatedAt: string): Content {
  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: PDF_COPY.product, fontSize: 14, bold: true },
          { text: title, color: MUTED },
        ],
      },
      {
        width: 300,
        alignment: 'right',
        color: MUTED,
        stack: [
          {
            text: [`${PDF_COPY.preparedFor} `, { text: clip(orgName, 60), bold: true, color: INK }],
          },
          {
            text: `${PDF_COPY.generatedOn} ${generatedAt} ${PDF_COPY.utc}`,
          },
        ],
      },
    ],
    columnGap: 16,
    margin: [0, 0, 0, 5],
  };
}

/** The grey box at the foot of a report: data dates, sources and notes, given as its lines. */
export function notesBox(stack: Content[]): Content {
  return {
    table: {
      widths: ['*'],
      body: [[{ fillColor: HEADER_FILL, stack }]],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => RULE,
      vLineColor: () => RULE,
      paddingTop: () => 5,
      paddingBottom: () => 5,
      paddingLeft: () => 7,
      paddingRight: () => 7,
    },
    margin: [0, 6, 0, 0],
  };
}

/** The document settings every report shares: A4, tight margins, Roboto at body size. */
export const PAGE = {
  pageSize: 'A4' as const,
  pageMargins: [36, 24, 36, 20] as [number, number, number, number],
  defaultStyle: { font: 'Roboto', fontSize: 7.5, lineHeight: 1.1, color: INK },
  styles: {
    section: {
      fontSize: 7.5,
      bold: true,
      color: MUTED,
      margin: [0, 4, 0, 2] as [number, number, number, number],
    },
  },
};

/**
 * When each of `sources` was last read successfully, named by `names`; a monthly file shows the month its data runs to.
 * `Source, 2026-10-28 · Other source, data to 2026-08`.
 */
export function dataDatesLine(
  freshness: readonly SourceFreshness[],
  sources: readonly string[],
  names: Readonly<Record<string, string>>,
): string {
  return sources
    .map((source) => {
      const entry = freshness.find((f) => f.source === source);
      const when =
        entry === undefined
          ? PDF_COPY.notSynced
          : entry.latestMonth !== null
            ? PDF_COPY.dataToMonth(entry.latestMonth)
            : entry.lastSuccessAt === null
              ? PDF_COPY.notSynced
              : entry.lastSuccessAt.slice(0, 10);
      return `${names[source] ?? source}, ${when}`;
    })
    .join(' · ');
}
