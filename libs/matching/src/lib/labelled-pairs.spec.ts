import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MATCH_CONFIG } from './config';
import { buildLinkEvidence, decideLink, linkScore, type MatchRecord } from './link-score';

/**
 * The columns the gate reads. `entities:sample-pairs` writes them, with the raw names and addresses a person labels
 * from: one record/firm pair per row, both sides as the linker scored them, '' for a missing value.
 */
const COLUMNS = [
  'country',
  'record_name_norm',
  'record_address_norm',
  'record_city',
  'record_region',
  'record_postal',
  'record_commodity_ids',
  'firm_name_norm',
  'firm_address_norm',
  'firm_city',
  'firm_region',
  'firm_postal',
  'firm_commodity_ids',
  'is_distinctive',
  'label',
] as const;
type LabelledPair = Record<(typeof COLUMNS)[number], string>;

/** Spec §8.5: the gate needs 300 labelled pairs and holds auto-link precision at 0.98 or more. */
const MIN_LABELLED = 300;
const MIN_PRECISION = 0.98;

/** A CSV's pairs, by its header. */
function readPairs(csv: string): LabelledPair[] {
  return parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as LabelledPair[];
}

// A spreadsheet saves TRUE and FALSE, and a person may type `Link` or ` no`: the gate reads both columns trimmed and in
// any case.

/** A pair's label: `link` for the same firm, `no` for another, `skip` for a pair left out, '' for not yet. */
const labelOf = ({ label }: LabelledPair): string => label.trim().toLowerCase();

/** A pair's `is_distinctive`: true or false, null for anything else. */
function distinctiveOf({ is_distinctive }: LabelledPair): boolean | null {
  const value = is_distinctive.trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
}

/** The pairs a person labelled `link` or `no`: those the gate measures. */
const labelledOf = (pairs: readonly LabelledPair[]): LabelledPair[] =>
  pairs.filter((pair) => ['link', 'no'].includes(labelOf(pair)));

/** One side of a pair, rebuilt from its row. Both sides are in the row's country, as the linker only compares those. */
function side(row: LabelledPair, which: 'record' | 'firm'): MatchRecord {
  const orNull = (value: string) => value || null;
  return {
    nameNorm: row[`${which}_name_norm`],
    address: {
      countryCode: row.country,
      region: orNull(row[`${which}_region`]),
      city: orNull(row[`${which}_city`]),
      postalCode: orNull(row[`${which}_postal`]),
      addressNorm: orNull(row[`${which}_address_norm`]),
    },
    commodityIds: row[`${which}_commodity_ids`].split('|').filter(Boolean).map(Number),
  };
}

/**
 * Rescores the labelled pairs as the linker scores them and counts its auto-links against the labels: precision is the
 * share of auto-linked pairs labelled `link`, recall the share of pairs labelled `link` that auto-link.
 */
function measure(pairs: readonly LabelledPair[]) {
  const cfg = MATCH_CONFIG.link;
  const decided = labelledOf(pairs).map((pair) => {
    const evidence = buildLinkEvidence(
      side(pair, 'record'),
      side(pair, 'firm'),
      { isDistinctive: distinctiveOf(pair) === true },
      cfg,
    );
    return { label: labelOf(pair), decision: decideLink(linkScore(evidence, cfg), cfg) };
  });
  const autoLinked = decided.filter(({ decision }) => decision === 'link').length;
  const correct = decided.filter(({ label, decision }) => decision === 'link' && label === 'link').length;
  const sameFirm = decided.filter(({ label }) => label === 'link').length;
  return {
    labelled: decided.length,
    autoLinked,
    correct,
    sameFirm,
    precision: correct / autoLinked,
    recall: correct / sameFirm,
  };
}

const csv = readFileSync(path.join(__dirname, '../../test/fixtures/labelled-pairs.csv'), 'utf8');
const rows = readPairs(csv);
const labelled = labelledOf(rows);

describe('labelled pairs (spec §8.5)', () => {
  it('has the columns the gate reads, and every pair is distinctive or not', () => {
    const [header] = parse(csv, { to_line: 1, bom: true }) as string[][];
    expect(header).toEqual(expect.arrayContaining([...COLUMNS]));
    expect(rows.filter((row) => distinctiveOf(row) === null)).toEqual([]);
  });

  it('labels a pair link, no, skip or not yet', () => {
    expect(rows.filter((row) => !['link', 'no', 'skip', ''].includes(labelOf(row)))).toEqual([]);
  });

  describe('reading a labelled file', () => {
    // An exact distinctive name scores 1, a link; an exact generic name in the same country only scores 0.78.
    const header = COLUMNS.join(',');
    const lowerCase = [
      header,
      'CN,fujian dongwei food,,,,,,fujian dongwei food,,,,,,true,link',
      'PK,al rahman rice mills,,,,,,al rahman rice mills,,,,,,false,no',
      'VN,viet seafood,,,,,,viet seafood,,,,,,true,no',
    ].join('\n');

    it('reads labels and is_distinctive as a spreadsheet saves them', () => {
      // Upper case, capitalised and padded.
      const spreadsheet = [
        header,
        'CN,fujian dongwei food,,,,,,fujian dongwei food,,,,,,TRUE,Link',
        'PK,al rahman rice mills,,,,,,al rahman rice mills,,,,,,FALSE, NO ',
        'VN,viet seafood,,,,,,viet seafood,,,,,, True ,No',
      ].join('\r\n');

      expect(measure(readPairs(lowerCase))).toEqual({
        labelled: 3,
        autoLinked: 2,
        correct: 1,
        sameFirm: 1,
        precision: 0.5,
        recall: 1,
      });
      expect(measure(readPairs(spreadsheet))).toEqual(measure(readPairs(lowerCase)));
      expect(readPairs(spreadsheet).filter((row) => distinctiveOf(row) === null)).toEqual([]);
    });

    it('leaves out the pairs labelled skip', () => {
      const withSkips = readPairs(
        [
          lowerCase,
          'TH,golden harvest foods,,,,,,golden harvest foods,,,,,,true,skip',
          'IN,gurudev spices,,,,,,gurudev spices,,,,,,TRUE, Skip ',
        ].join('\n'),
      );

      expect(withSkips.filter((row) => !['link', 'no', 'skip', ''].includes(labelOf(row)))).toEqual([]);
      expect(labelledOf(withSkips)).toHaveLength(3);
      expect(measure(withSkips)).toEqual(measure(readPairs(lowerCase)));
    });
  });

  // Ruling R3: the owner labels the sample, and until 300 pairs are labelled there is nothing to hold the rules to.
  (labelled.length >= MIN_LABELLED ? it : it.skip)(
    `auto-link precision ≥ 0.98 (needs 300 labelled pairs; ${labelled.length} labelled)`,
    () => {
      const { autoLinked, correct, sameFirm, precision, recall } = measure(rows);

      console.info(
        `Auto-link precision ${precision.toFixed(4)}: ` +
          `${correct} of ${autoLinked} auto-linked pairs are labelled link. ` +
          `Recall ${recall.toFixed(4)}: ${correct} of ${sameFirm} pairs labelled link auto-link.`,
      );
      // With no auto-link at all the precision is NaN, which fails: the rules must link something to be measured.
      expect(precision).toBeGreaterThanOrEqual(MIN_PRECISION);
    },
  );
});
