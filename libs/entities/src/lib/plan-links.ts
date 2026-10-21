import { FIRM_RECORD_SOURCES, type MatchReviewReason } from '@rejectradar/contracts';
import {
  buildLinkEvidence,
  decideLink,
  isDistinctiveName,
  type LinkConfig,
  type LinkEvidence,
  type LinkScoreParts,
  linkScoreParts,
  MATCH_CONFIG,
  type NormalizedAddress,
} from '@rejectradar/matching';
import { CandidateIndex } from './candidate-index';
import type { FirmRecord, FirmRef, KnownFirm, LinkPlan } from './types';

/** Per country, how many distinct name_norms contain each token (P3-D4). Entries without a country are ignored. */
export function countryTokenFrequencies(
  entries: Iterable<{ countryCode: string | null; nameNorm: string }>,
): Map<string, Map<string, number>> {
  const namesByCountry = new Map<string, Set<string>>();
  for (const { countryCode, nameNorm } of entries) {
    if (!countryCode) continue;
    const names = namesByCountry.get(countryCode);
    if (names) names.add(nameNorm);
    else namesByCountry.set(countryCode, new Set([nameNorm]));
  }
  const frequencies = new Map<string, Map<string, number>>();
  for (const [countryCode, names] of namesByCountry) {
    const counts = new Map<string, number>();
    for (const name of names) {
      // Tokens as isDistinctiveName splits them; a token twice in one name counts once.
      for (const token of new Set(name.split(' ').filter(Boolean))) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    frequencies.set(countryCode, counts);
  }
  return frequencies;
}

/**
 * A firm as the engine sees it. `order` is its insertion sequence: known firms by ascending id, then new firms as
 * created.
 */
export interface FirmView {
  ref: FirmRef;
  nameNorm: string;
  address: NormalizedAddress | null;
  /** Grows as records link to the firm. */
  commodityIds: number[];
  /** Grows when a new FEI attaches to the firm (P3-D5). */
  feis: number[];
  order: number;
}

export interface ScoredCandidate {
  firm: FirmView;
  score: number;
  evidence: LinkEvidence;
  parts: LinkScoreParts;
}

/**
 * The record's candidates from its country's index, scored with buildLinkEvidence/linkScore, sorted by score desc then
 * `order` asc. [] when the record has no country or no index.
 */
export function rankCandidates(
  record: FirmRecord,
  index: CandidateIndex<FirmView> | undefined,
  frequencies: Map<string, number> | undefined,
  cfg: LinkConfig = MATCH_CONFIG.link,
): ScoredCandidate[] {
  if (!record.address?.countryCode || !index) return [];
  const isDistinctive = isDistinctiveName(
    record.nameNorm,
    (token) => frequencies?.get(token) ?? 0,
    cfg.distinctiveTokenMaxFreq,
  );
  return index
    .search(record.nameNorm, { minSim: cfg.candidateMinTrigram, limit: cfg.maxCandidates })
    .map(({ item: firm }) => {
      const evidence = buildLinkEvidence(record, firm, { isDistinctive }, cfg);
      // linkScore(evidence) is parts.total; a review keeps the parts too.
      const parts = linkScoreParts(evidence, cfg);
      return { firm, score: parts.total, evidence, parts };
    })
    .sort((a, b) => b.score - a.score || a.firm.order - b.firm.order);
}

/**
 * Spec §8.2: links every record to a firm, by FEI first, then by name and location among the firms of its country, and
 * plans the firms, FEIs and reviews that takes. Records are matched one after another, so a firm created for one record
 * is a candidate for the next (Review Focus 2). Pure: the input is left as it is.
 */
export function planLinks(
  input: { firms: readonly KnownFirm[]; records: readonly FirmRecord[] },
  cfg: LinkConfig = MATCH_CONFIG.link,
): LinkPlan {
  const planner = new LinkPlanner(input, cfg);
  for (const unit of matchingOrder(input.records)) {
    if (unit.kind === 'fei') planner.planFei(unit.fei, unit.refusals);
    else planner.planRecord(unit.record);
  }
  return planner.plan;
}

/** What the engine matches in one step: a record without an FEI, or all the refusals of one FEI. */
type Unit = { kind: 'record'; record: FirmRecord } | { kind: 'fei'; fei: number; refusals: FirmRecord[] };

/**
 * The sources in the order of FIRM_RECORD_SOURCES, each by date, then key. The refusals of one FEI are a single unit,
 * placed where the earliest of them falls.
 */
function matchingOrder(records: readonly FirmRecord[]): Unit[] {
  const units: Unit[] = [];
  const refusalsByFei = new Map<number, FirmRecord[]>();
  for (const record of [...records].sort(compareForMatching)) {
    if (record.fei === null) {
      units.push({ kind: 'record', record });
      continue;
    }
    let refusals = refusalsByFei.get(record.fei);
    if (!refusals) {
      refusals = [];
      refusalsByFei.set(record.fei, refusals);
      units.push({ kind: 'fei', fei: record.fei, refusals });
    }
    refusals.push(record);
  }
  return units;
}

function compareForMatching(a: FirmRecord, b: FirmRecord): number {
  return FIRM_RECORD_SOURCES.indexOf(a.source) - FIRM_RECORD_SOURCES.indexOf(b.source) || compareByDate(a, b);
}

/** By date, then key. */
function compareByDate(a: FirmRecord, b: FirmRecord): number {
  return compareText(a.seenOn, b.seenOn) || compareText(a.key, b.key);
}

/** Code-unit order, which no locale changes. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The latest record by date, then key: an FEI's firm takes its name and address from it (P3-D6). */
function latest(records: readonly FirmRecord[]): FirmRecord {
  return records.reduce((found, record) => (compareByDate(record, found) > 0 ? record : found));
}

function earliestSeenOn(records: readonly FirmRecord[]): string {
  return records.reduce((found, { seenOn }) => (seenOn < found ? seenOn : found), records[0].seenOn);
}

/** The best candidate and the band its score falls in; below the review band no candidate matters. */
type Match = { decision: 'new' } | { decision: 'link' | 'review'; best: ScoredCandidate };

/** A new FEI joins `candidate` ('attach'), or gets a firm of its own, reviewed against `candidate` unless 'new'. */
type FeiMatch =
  | { decision: 'new' }
  | { decision: 'attach'; candidate: ScoredCandidate }
  | { decision: MatchReviewReason; candidate: ScoredCandidate };

/** The engine's state while it plans: the firms so far, a candidate index per country, and the plan. */
class LinkPlanner {
  readonly plan: LinkPlan = { newFirms: [], links: [], feis: [], reviews: [] };
  private readonly cfg: LinkConfig;
  private readonly frequencies: Map<string, Map<string, number>>;
  private readonly indexes = new Map<string, CandidateIndex<FirmView>>();
  /** The firm that held each FEI before the run. */
  private readonly knownFeis = new Map<number, FirmView>();
  private nextOrder = 0;

  constructor(input: { firms: readonly KnownFirm[]; records: readonly FirmRecord[] }, cfg: LinkConfig) {
    this.cfg = cfg;
    // P3-D4: counted once over the firms and every record of the run, so a first run doesn't depend on record order.
    this.frequencies = countryTokenFrequencies(
      [...input.firms, ...input.records].map(({ nameNorm, address }) => ({
        countryCode: address?.countryCode ?? null,
        nameNorm,
      })),
    );
    for (const firm of [...input.firms].sort((a, b) => a.id - b.id)) {
      const view = this.addFirm({ kind: 'existing', id: firm.id }, firm);
      for (const fei of firm.feis) this.knownFeis.set(fei, view);
    }
  }

  /** Spec §8.2 steps 2 to 4, for a record without an FEI. */
  planRecord(record: FirmRecord): void {
    const match = this.match(record);
    if (match.decision === 'link') {
      this.link([record], match.best.firm, match.best.score);
      return;
    }
    const firm = this.createFirm([record], record);
    this.link([record], firm, 1);
    if (match.decision === 'review') this.review(record, firm, match.best, 'score_band');
  }

  /** Spec §8.2 step 1 and P3-D5, for the refusals of one FEI: a new FEI is matched by its latest refusal. */
  planFei(fei: number, refusals: readonly FirmRecord[]): void {
    const holder = this.knownFeis.get(fei);
    if (holder) {
      this.link(refusals, holder, 1);
      return;
    }
    const representative = latest(refusals);
    const match = this.matchNewFei(representative);
    if (match.decision === 'attach') {
      // The firm matches strongly and has no FEI yet: this one is its FEI, and the refusals keep the match score.
      this.assignFei(fei, match.candidate.firm, refusals);
      this.link(refusals, match.candidate.firm, match.candidate.score);
      return;
    }
    const firm = this.createFirm(refusals, representative);
    this.assignFei(fei, firm, refusals);
    this.link(refusals, firm, 1);
    if (match.decision !== 'new') this.review(representative, firm, match.candidate, match.decision);
  }

  /** The record's candidates in its country, ranked by rankCandidates. A record without a country has none. */
  private rank(record: FirmRecord): ScoredCandidate[] {
    const country = record.address?.countryCode;
    return country ? rankCandidates(record, this.indexes.get(country), this.frequencies.get(country), this.cfg) : [];
  }

  /** The record's best candidate in its country and what its score decides. A record without a country has none. */
  private match(record: FirmRecord): Match {
    const best: ScoredCandidate | undefined = this.rank(record)[0];
    if (!best) return { decision: 'new' };
    const decision = decideLink(best.score, this.cfg);
    return decision === 'new' ? { decision } : { decision, best };
  }

  /**
   * P3-D5 as ruling R13 narrows it, for a new FEI's latest refusal. The best firm without an FEI keeps the bands. A
   * firm holding another FEI is another establishment unless the address agrees (spec §8.2 step 1), so it only ever
   * gets a second_fei review, and only for a link-band score with the same address or postal code.
   */
  private matchNewFei(record: FirmRecord): FeiMatch {
    const ranked = this.rank(record);
    const withoutFei = ranked.find(({ firm }) => firm.feis.length === 0);
    if (withoutFei && withoutFei.score >= this.cfg.autoLink) return { decision: 'attach', candidate: withoutFei };
    const sameAddress = ranked.find(
      ({ firm, score, evidence }) =>
        firm.feis.length > 0 && score >= this.cfg.autoLink && (evidence.addressMatch || evidence.postalMatch),
    );
    if (sameAddress) return { decision: 'second_fei', candidate: sameAddress };
    if (withoutFei && withoutFei.score >= this.cfg.review) return { decision: 'score_band', candidate: withoutFei };
    return { decision: 'new' };
  }

  /** A new firm named and placed as `representative` (P3-D6), first seen on the earliest date of `records`. */
  private createFirm(records: readonly FirmRecord[], representative: FirmRecord): FirmView {
    const index = this.plan.newFirms.length;
    const { firmName, nameNorm, address, source, key } = representative;
    this.plan.newFirms.push({
      index,
      displayName: firmName,
      nameNorm,
      address,
      firstSeen: earliestSeenOn(records),
      source,
      key,
    });
    return this.addFirm({ kind: 'new', index }, { nameNorm, address, commodityIds: [], feis: [] });
  }

  /** Adds a firm, with its own copies of the lists that grow; with a country, it is a candidate from now on. */
  private addFirm(ref: FirmRef, firm: Pick<KnownFirm, 'nameNorm' | 'address' | 'commodityIds' | 'feis'>): FirmView {
    const view: FirmView = {
      ref,
      nameNorm: firm.nameNorm,
      address: firm.address,
      commodityIds: [...firm.commodityIds],
      feis: [...firm.feis],
      order: this.nextOrder++,
    };
    const country = view.address?.countryCode;
    if (country) {
      let index = this.indexes.get(country);
      if (!index) {
        index = new CandidateIndex<FirmView>();
        this.indexes.set(country, index);
      }
      index.add(view.nameNorm, view);
    }
    return view;
  }

  /** Gives `firm` the FEI, from the date of its earliest refusal. */
  private assignFei(fei: number, firm: FirmView, refusals: readonly FirmRecord[]): void {
    firm.feis.push(fei);
    this.plan.feis.push({ fei, firm: firm.ref, firstSeen: earliestSeenOn(refusals) });
  }

  /** Links the records to `firm`, whose commodities grow by theirs. */
  private link(records: readonly FirmRecord[], firm: FirmView, score: number): void {
    for (const { source, key, commodityIds } of records) {
      this.plan.links.push({ source, key, firm: firm.ref, score });
      for (const id of commodityIds) if (!firm.commodityIds.includes(id)) firm.commodityIds.push(id);
    }
  }

  /** Asks a reviewer whether the record's new firm is the candidate, showing how the pair scored. */
  private review(record: FirmRecord, firm: FirmView, candidate: ScoredCandidate, reason: MatchReviewReason): void {
    this.plan.reviews.push({
      source: record.source,
      key: record.key,
      firm: firm.ref,
      candidate: candidate.firm.ref,
      score: candidate.score,
      reason,
      evidence: { ...candidate.evidence, parts: candidate.parts },
    });
  }
}
