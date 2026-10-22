import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildLinkEvidence, decideLink, linkScore, type MatchRecord } from './link-score';
import { normalizeAddress } from './normalize-address';
import { normalizeName } from './normalize-name';

interface HardNegative {
  name_a: string;
  address_a: string;
  city_a: string;
  country_a: string;
  name_b: string;
  address_b: string;
  city_b: string;
  country_b: string;
  distinctive: string;
  note: string;
}

const rows = parse(readFileSync(path.join(__dirname, '../../test/fixtures/hard-negatives.csv'), 'utf8'), {
  columns: true,
  skip_empty_lines: true,
}) as HardNegative[];

/**
 * One side of a row, normalised as the linker normalises a record. Both sides carry the same commodity, which is the
 * worst case: a shared commodity only ever adds to a score.
 */
function side(row: HardNegative, which: 'a' | 'b'): MatchRecord {
  return {
    nameNorm: normalizeName(row[`name_${which}`]).primary,
    address: normalizeAddress({
      line1: row[`address_${which}`],
      city: row[`city_${which}`],
      country: row[`country_${which}`],
    }),
    commodityIds: [1],
  };
}

describe('hard negatives (pairs that must never auto-link)', () => {
  it('reads at least the five pairs the plan lists, each with a note and a distinctive flag', () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((row) => row.note.length > 0 && ['true', 'false'].includes(row.distinctive))).toBe(true);
  });

  it.each(rows)('$name_a vs $name_b: $note', (row) => {
    const score = linkScore(buildLinkEvidence(side(row, 'a'), side(row, 'b'), { isDistinctive: row.distinctive === 'true' }));
    // Printing the score with the decision shows how far a failing pair is from the line.
    expect({ score, decision: decideLink(score) }).not.toMatchObject({ decision: 'link' });
  });
});
