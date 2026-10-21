import { firm } from '@rejectradar/db';
import { decideLink, isDistinctiveName, type LinkConfig, MATCH_CONFIG } from '@rejectradar/matching';
import { inArray } from 'drizzle-orm';
import { CandidateIndex } from './candidate-index';
import { type LoadedRecord, loadFirmRecords, loadFirms } from './load';
import { countryTokenFrequencies, type FirmView, latestRecord, rankCandidates } from './plan-links';
import type { DbOrTx, FirmRecord, KnownFirm } from './types';

/** The columns of `libs/matching/test/fixtures/labelled-pairs.csv`, which the precision gate reads (spec §8.5). */
export const LABELLED_PAIR_COLUMNS = [
  'pair_id',
  'source',
  'source_key',
  'country',
  'record_raw_name',
  'record_name_norm',
  'record_raw_address',
  'record_address_norm',
  'record_city',
  'record_region',
  'record_postal',
  'record_commodity_ids',
  'firm_id',
  'firm_display_name',
  'firm_name_norm',
  'firm_address_norm',
  'firm_city',
  'firm_region',
  'firm_postal',
  'firm_commodity_ids',
  'is_distinctive',
  'score',
  'decision',
  'label',
  'notes',
] as const;

/**
 * A record/firm pair to label, every column as text: both sides as the engine scored them, '' for a missing value and
 * commodity IDs joined by '|'. `label` and `notes` are left for the person labelling.
 */
export type LabelledPair = Record<(typeof LABELLED_PAIR_COLUMNS)[number], string>;

/** decideLink's link and review bands, and near: from 0.50 up to the review band. */
export type SampleBand = 'link' | 'review' | 'near';

/** The bands in the order they are filled and written. */
const BANDS: readonly SampleBand[] = ['link', 'review', 'near'];
/** The bottom of the near band; lower scores are not sampled. */
const NEAR_MIN_SCORE = 0.5;
/** The link and review bands' shares of a sample; the near band takes the rest. */
const SHARES = { link: 0.5, review: 0.3 };
/** How many of its best candidates a record is paired with. */
const CANDIDATES_PER_RECORD = 3;
/** Spec §8.5: the labelled pairs come from at least this many countries. */
const MIN_COUNTRIES = 5;

/** A record, one of its candidate firms, and how the pair scored. */
interface Pair {
  record: FirmRecord;
  rawAddress: string | null;
  candidate: KnownFirm;
  score: number;
  band: SampleBand;
  /** The country of both sides: a record's candidates are the firms of its country. */
  country: string;
  /** Whether the record's name is distinctive in its country (P3-D4), as the score took it. */
  isDistinctive: boolean;
}

/**
 * Spec §8.5: `count` record/firm pairs from the linked database, for a person to label `link` or `no`.
 * - The records are every Import Alert listing, every Australian record that names a producer and every FDA refusal
 *   without an FEI, and for each FEI its latest refusal, by which the engine matches a new FEI. Each is paired with its
 *   3 best candidates, scored as planLinks scores them, that score 0.50 or more. A firm the record alone makes up is no
 *   candidate, nor, for a refusal, the firm that holds its FEI; a firm the record shares with other records is.
 * - Half the sample comes from the link band, 30% from the review band and the rest from the near band. A band with
 *   too few pairs gives them all, and the bands with pairs left make up the difference, link first.
 * - Within a band the countries take turns, the one with the most pairs first, each giving its pairs in an order
 *   shuffled from `seed`, so the same data and seed give the same sample.
 * Throws when the sample covers fewer than 5 countries.
 */
export async function samplePairs(db: DbOrTx, opts: { count: number; seed: number }): Promise<LabelledPair[]> {
  const cfg = MATCH_CONFIG.link;
  const pairs = await candidatePairs(db, cfg);
  const byBand = groupBy(pairs, ({ band }) => band);
  const take = quotas(opts.count, (band) => byBand.get(band)?.length ?? 0);
  const random = mulberry32(opts.seed);
  const sample = BANDS.flatMap((band) => roundRobin(byBand.get(band) ?? [], take[band], random));

  const countries = [...new Set(sample.map(({ country }) => country))].sort();
  if (countries.length < MIN_COUNTRIES) {
    const covered = countries.length > 0 ? ` (${countries.join(', ')})` : '';
    const withPairs = new Set(pairs.map(({ country }) => country)).size;
    throw new Error(
      `A sample of ${sample.length} pairs covers ${countries.length} countries${covered}; ` +
        `spec §8.5 needs at least ${MIN_COUNTRIES} (${withPairs} countries have pairs to sample).`,
    );
  }

  const names = await displayNames(db, sample);
  return sample.map((pair, index) => toRow(index + 1, pair, names.get(pair.candidate.id) ?? '', cfg));
}

/** A sample's rows per band and per country, the most first: what `entities:sample-pairs` reports. */
export function sampleSummary(rows: readonly LabelledPair[]): {
  rows: number;
  bands: Record<SampleBand, number>;
  countries: Record<string, number>;
} {
  const bands: Record<SampleBand, number> = { link: 0, review: 0, near: 0 };
  for (const { decision } of rows) bands[decision === 'link' || decision === 'review' ? decision : 'near'] += 1;
  const countries = [...groupBy(rows, ({ country }) => country)]
    .map(([country, group]) => [country, group.length] as const)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  return { rows: rows.length, bands, countries: Object.fromEntries(countries) };
}

/**
 * Every record's pairs, in the order the records were loaded. A record gets the candidates and scores planLinks would
 * give it: the firms of its country, indexed by ascending id, and token frequencies counted over the firms and every
 * record (P3-D4). Each record is paired once with each of its candidates, so no pair repeats.
 */
async function candidatePairs(db: DbOrTx, cfg: LinkConfig): Promise<Pair[]> {
  const firms = await loadFirms(db);
  const loaded = await loadFirmRecords(db, { includeLinked: true });
  const frequencies = countryTokenFrequencies(
    [...firms, ...loaded.map(({ record }) => record)].map(({ nameNorm, address }) => ({
      countryCode: address?.countryCode ?? null,
      nameNorm,
    })),
  );
  const indexes = indexByCountry(firms);
  const feiHolders = new Map(firms.flatMap(({ id, feis }) => feis.map((fei) => [fei, id] as const)));
  const recordCounts = new Map<number, number>();
  for (const { firmId } of loaded) if (firmId !== null) recordCounts.set(firmId, (recordCounts.get(firmId) ?? 0) + 1);

  const pairs: Pair[] = [];
  for (const { record, firmId, rawAddress } of representatives(loaded)) {
    const country = record.address?.countryCode;
    if (!country) continue;
    const countryFrequencies = frequencies.get(country);
    // What rankCandidates scores the record with; the CSV carries it so that the gate can rescore the pair.
    const isDistinctive = isDistinctiveName(
      record.nameNorm,
      (token) => countryFrequencies?.get(token) ?? 0,
      cfg.distinctiveTokenMaxFreq,
    );
    // A firm the record alone makes up, or the firm holding a refusal's FEI, is the record itself: nothing to label.
    const isItself = (id: number) =>
      (id === firmId && recordCounts.get(id) === 1) || (record.fei !== null && feiHolders.get(record.fei) === id);
    const best = rankCandidates(record, indexes.get(country), countryFrequencies, cfg)
      .map(({ firm: view, score }) => ({ candidate: firms[view.order], score }))
      .filter(({ candidate }) => !isItself(candidate.id))
      .slice(0, CANDIDATES_PER_RECORD);
    for (const { candidate, score } of best) {
      const band = bandOf(score, cfg);
      if (band) pairs.push({ record, rawAddress, candidate, score, band, country, isDistinctive });
    }
  }
  return pairs;
}

/** The records a sample pairs: all but an FEI's refusals, for which its latest refusal stands (P3-D5). */
function representatives(loaded: readonly LoadedRecord[]): LoadedRecord[] {
  const refusals = loaded.flatMap(({ record }) => (record.fei === null ? [] : [record]));
  const latest = new Set([...groupBy(refusals, ({ fei }) => fei).values()].map((group) => latestRecord(group)));
  return loaded.filter(({ record }) => record.fei === null || latest.has(record));
}

/** A candidate index per country of the firms, added by ascending id as planLinks adds known firms. */
function indexByCountry(firms: readonly KnownFirm[]): Map<string, CandidateIndex<FirmView>> {
  const indexes = new Map<string, CandidateIndex<FirmView>>();
  // A view's `order` is its firm's place in `firms`, which leads back from a candidate to the firm.
  firms.forEach(({ id, nameNorm, address, commodityIds, feis }, order) => {
    const country = address?.countryCode;
    if (!country) return;
    let index = indexes.get(country);
    if (!index) {
      index = new CandidateIndex<FirmView>();
      indexes.set(country, index);
    }
    index.add(nameNorm, { ref: { kind: 'existing', id }, nameNorm, address, commodityIds, feis, order });
  });
  return indexes;
}

/** decideLink's band for a score, or near from 0.50 to the review band; null below that. */
function bandOf(score: number, cfg: LinkConfig): SampleBand | null {
  const decision = decideLink(score, cfg);
  if (decision !== 'new') return decision;
  return score >= NEAR_MIN_SCORE ? 'near' : null;
}

/**
 * How many pairs each band gives: 50% and 30% of `count`, rounded, and the rest. A band with fewer pairs than that
 * gives them all, and its shortfall goes to the bands with pairs left, in band order.
 */
function quotas(count: number, available: (band: SampleBand) => number): Record<SampleBand, number> {
  const link = Math.round(count * SHARES.link);
  const review = Math.round(count * SHARES.review);
  const targets: Record<SampleBand, number> = { link, review, near: count - link - review };
  const take: Record<SampleBand, number> = { link: 0, review: 0, near: 0 };
  let shortfall = 0;
  for (const band of BANDS) {
    take[band] = Math.min(targets[band], available(band));
    shortfall += targets[band] - take[band];
  }
  for (const band of BANDS) {
    const extra = Math.min(shortfall, available(band) - take[band]);
    take[band] += extra;
    shortfall -= extra;
  }
  return take;
}

/**
 * The first `take` of a band's pairs as the countries take turns, the one with the most pairs first, then by code.
 * Each country's pairs are shuffled with `random` first.
 */
function roundRobin(pairs: readonly Pair[], take: number, random: () => number): Pair[] {
  const queues = [...groupBy(pairs, ({ country }) => country)]
    .sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : 1))
    .map(([, queue]) => shuffle(queue, random));
  const turns: Pair[] = [];
  const rounds = Math.max(0, ...queues.map(({ length }) => length));
  for (let round = 0; round < rounds; round++) {
    for (const queue of queues) if (round < queue.length) turns.push(queue[round]);
  }
  return turns.slice(0, take);
}

/** The display name of each firm in the sample, by id. */
async function displayNames(db: DbOrTx, pairs: readonly Pair[]): Promise<Map<number, string>> {
  const ids = [...new Set(pairs.map(({ candidate }) => candidate.id))];
  const rows = await db.select({ id: firm.id, displayName: firm.displayName }).from(firm).where(inArray(firm.id, ids));
  return new Map(rows.map(({ id, displayName }) => [id, displayName]));
}

/** A pair as a CSV row, numbered `pairId`. */
function toRow(pairId: number, pair: Pair, displayName: string, cfg: LinkConfig): LabelledPair {
  const { record, rawAddress, candidate, score, country, isDistinctive } = pair;
  const text = (value: string | null | undefined) => value ?? '';
  return {
    pair_id: String(pairId),
    source: record.source,
    source_key: record.key,
    country,
    record_raw_name: record.firmName,
    record_name_norm: record.nameNorm,
    record_raw_address: text(rawAddress),
    record_address_norm: text(record.address?.addressNorm),
    record_city: text(record.address?.city),
    record_region: text(record.address?.region),
    record_postal: text(record.address?.postalCode),
    record_commodity_ids: record.commodityIds.join('|'),
    firm_id: String(candidate.id),
    firm_display_name: displayName,
    firm_name_norm: candidate.nameNorm,
    firm_address_norm: text(candidate.address?.addressNorm),
    firm_city: text(candidate.address?.city),
    firm_region: text(candidate.address?.region),
    firm_postal: text(candidate.address?.postalCode),
    firm_commodity_ids: candidate.commodityIds.join('|'),
    is_distinctive: String(isDistinctive),
    score: score.toFixed(4),
    decision: decideLink(score, cfg),
    label: '',
    notes: '',
  };
}

/** `items` by `key`: the groups in the order their first item comes, each in the order of `items`. */
function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** Fisher-Yates, in place. */
function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** mulberry32: a 32-bit generator of numbers in [0, 1), the same sequence for the same seed. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
