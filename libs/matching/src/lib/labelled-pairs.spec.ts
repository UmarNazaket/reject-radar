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

const csv = readFileSync(path.join(__dirname, '../../test/fixtures/labelled-pairs.csv'), 'utf8');
const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as LabelledPair[];
/** The pairs a person labelled: `link` for the same firm, `no` for another. */
const labelled = rows.filter(({ label }) => label === 'link' || label === 'no');

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

describe('labelled pairs (spec §8.5)', () => {
  it('has the columns the gate reads', () => {
    const [header] = parse(csv, { to_line: 1, bom: true }) as string[][];
    expect(header).toEqual(expect.arrayContaining([...COLUMNS]));
  });

  it('labels a pair link, no or not yet', () => {
    expect(rows.filter(({ label }) => !['link', 'no', ''].includes(label))).toEqual([]);
  });

  // Ruling R3: the owner labels the sample, and until 300 pairs are labelled there is nothing to hold the rules to.
  (labelled.length >= MIN_LABELLED ? it : it.skip)(
    `auto-link precision ≥ 0.98 (needs 300 labelled pairs; ${labelled.length} labelled)`,
    () => {
      const cfg = MATCH_CONFIG.link;
      const decided = labelled.map((row) => {
        const evidence = buildLinkEvidence(
          side(row, 'record'),
          side(row, 'firm'),
          { isDistinctive: row.is_distinctive === 'true' },
          cfg,
        );
        return { label: row.label, decision: decideLink(linkScore(evidence, cfg), cfg) };
      });
      const autoLinked = decided.filter(({ decision }) => decision === 'link');
      const correct = autoLinked.filter(({ label }) => label === 'link').length;
      const sameFirm = decided.filter(({ label }) => label === 'link').length;
      const precision = correct / autoLinked.length;
      const recall = correct / sameFirm;

      console.info(
        `Auto-link precision ${precision.toFixed(4)}: ` +
          `${correct} of ${autoLinked.length} auto-linked pairs are labelled link. ` +
          `Recall ${recall.toFixed(4)}: ${correct} of ${sameFirm} pairs labelled link auto-link.`,
      );
      // With no auto-link at all the precision is NaN, which fails: the rules must link something to be measured.
      expect(precision).toBeGreaterThanOrEqual(MIN_PRECISION);
    },
  );
});
