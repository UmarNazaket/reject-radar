import { FIRM_RECORD_SOURCES, type MatchReviewReason } from '@rejectradar/contracts';
import {
  buildLinkEvidence,
  decideLink,
  isDistinctiveName,
  type LinkConfig,
  type LinkDecision,
  type LinkEvidence,
  type LinkScoreParts,
  linkScoreParts,
  MATCH_CONFIG,
  type NormalizedAddress,
} from '@rejectradar/matching';
import { CandidateIndex } from './candidate-index';
import type { FirmRecord, FirmRef, FrequencyName, KnownFirm, LinkPlan } from './types';

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
  const isDistinctive = isDistinctiveIn(record.nameNorm, frequencies, cfg);
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

/** Whether a name is distinctive among its country's names, given how many of them contain each token (P3-D4). */
function isDistinctiveIn(nameNorm: string, frequencies: Map<string, number> | undefined, cfg: LinkConfig): boolean {
  return isDistinctiveName(nameNorm, (token) => frequencies?.get(token) ?? 0, cfg.distinctiveTokenMaxFreq);
}

/**
 * The firms a record can be matched with, built alike by planLinks and the sampler: a candidate index per country,
 * which grows as firms are added, and per country the token frequencies of `frequencyNames`, which tell whether a
 * record's name is distinctive there (P3-D4). The known firms are added first, by ascending id, so a known firm's
 * `order` is its place among them by id.
 */
export class FirmCandidates {
  /** The known firms' views, by ascending id. */
  readonly known: FirmView[];
  private readonly cfg: LinkConfig;
  private readonly frequencies: Map<string, Map<string, number>>;
  private readonly indexes = new Map<string, CandidateIndex<FirmView>>();
  private nextOrder = 0;

  constructor(
    firms: readonly KnownFirm[],
    frequencyNames: Iterable<FrequencyName>,
    cfg: LinkConfig = MATCH_CONFIG.link,
  ) {
    this.cfg = cfg;
    this.frequencies = countryTokenFrequencies(frequencyNames);
    this.known = [...firms]
      .sort((a, b) => a.id - b.id)
      .map((firm) => this.add({ kind: 'existing', id: firm.id }, firm));
  }

  /** Adds a firm, with its own copies of the lists that grow; with a country, it is a candidate from now on. */
  add(ref: FirmRef, firm: Pick<KnownFirm, 'nameNorm' | 'address' | 'commodityIds' | 'feis'>): FirmView {
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

  /** Whether the record's name is distinctive in its country (P3-D4), as rank scores it. */
  isDistinctive(record: FirmRecord): boolean {
    const country = record.address?.countryCode;
    return isDistinctiveIn(record.nameNorm, country ? this.frequencies.get(country) : undefined, this.cfg);
  }

  /** The record's candidates in its country, ranked by rankCandidates. A record without a country has none. */
  rank(record: FirmRecord): ScoredCandidate[] {
    const country = record.address?.countryCode;
    return country ? rankCandidates(record, this.indexes.get(country), this.frequencies.get(country), this.cfg) : [];
  }
}

/**
 * Spec §8.2: links every record to a firm, by FEI first, then by name and location among the firms of its country, and
 * plans the firms, FEIs and reviews that takes. Records are matched one after another, so a firm created for one record
 * is a candidate for the next (Review Focus 2). A name is distinctive by the token frequencies of `frequencyNames`
 * (P3-D4), which loadLinkInput gives as the names of every firm and every record, linked or not; without them, by those
 * of the input's firms and records. Pure: the input is left as it is.
 */
export function planLinks(
  input: { firms: readonly KnownFirm[]; records: readonly FirmRecord[]; frequencyNames?: readonly FrequencyName[] },
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

/**
 * The order planLinks matches records in: by source in the order of FIRM_RECORD_SOURCES, then by date, then key. Within
 * a run, a firm is created when the first of its records in this order is matched.
 */
export function compareForMatching(a: FirmRecord, b: FirmRecord): number {
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
export function latestRecord(records: readonly FirmRecord[]): FirmRecord {
  return records.reduce((found, record) => (compareByDate(record, found) > 0 ? record : found));
}

/** The earliest date of `records`: a new firm is first seen on it. */
export function earliestSeenOn(records: readonly FirmRecord[]): string {
  return records.reduce((found, { seenOn }) => (seenOn < found ? seenOn : found), records[0].seenOn);
}

/** The best candidate and the band its score falls in; below the review band no candidate matters. */
type Match = { decision: 'new' } | { decision: 'link' | 'review'; best: ScoredCandidate };

/**
 * Whether a firm holding another FEI is at the new FEI's place, which depends on the band its score falls in:
 * - link band (rulings R13 and R22): the address or the postal code agrees. The name is close already, and FDA's city
 *   field often holds a region ("Kerala"), a district or a misspelling, so asking for the city too lost likely
 *   duplicates;
 * - review band (ruling R17): the postal code agrees, or the address and the city do. With a weaker name an address
 *   match alone is not enough: it ignores the city, and a street such as "5ta Calle Zona 1" is in many towns.
 */
function samePlace(
  { postalMatch, addressMatch, cityMatch }: LinkEvidence,
  band: Exclude<LinkDecision, 'new'>,
): boolean {
  return band === 'link' ? addressMatch || postalMatch : postalMatch || (addressMatch && cityMatch);
}

/** A new FEI joins `candidate` ('attach'), or gets a firm of its own, reviewed against `candidate` unless 'new'. */
type FeiMatch =
  | { decision: 'new' }
  | { decision: 'attach'; candidate: ScoredCandidate }
  | { decision: MatchReviewReason; candidate: ScoredCandidate };

/** The engine's state while it plans: the firms so far, as candidates, and the plan. */
class LinkPlanner {
  readonly plan: LinkPlan = { newFirms: [], links: [], feis: [], reviews: [] };
  private readonly cfg: LinkConfig;
  private readonly candidates: FirmCandidates;
  /** The firm that held each FEI before the run. */
  private readonly knownFeis = new Map<number, FirmView>();

  constructor(
    input: { firms: readonly KnownFirm[]; records: readonly FirmRecord[]; frequencyNames?: readonly FrequencyName[] },
    cfg: LinkConfig,
  ) {
    this.cfg = cfg;
    // P3-D4: counted once, before any record is matched, so a run doesn't depend on record order.
    const frequencyNames =
      input.frequencyNames ??
      [...input.firms, ...input.records].map(({ nameNorm, address }) => ({
        countryCode: address?.countryCode ?? null,
        nameNorm,
      }));
    this.candidates = new FirmCandidates(input.firms, frequencyNames, cfg);
    for (const view of this.candidates.known) for (const fei of view.feis) this.knownFeis.set(fei, view);
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
    const representative = latestRecord(refusals);
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

  /** The record's best candidate in its country and what its score decides. A record without a country has none. */
  private match(record: FirmRecord): Match {
    const best: ScoredCandidate | undefined = this.candidates.rank(record)[0];
    if (!best) return { decision: 'new' };
    const decision = decideLink(best.score, this.cfg);
    return decision === 'new' ? { decision } : { decision, best };
  }

  /**
   * P3-D5 as rulings R13, R17 and R22 narrow it, for a new FEI's latest refusal (spec §8.2 step 1). The best firm
   * without an FEI takes the FEI when it scores in the link band. Otherwise the FEI gets a firm of its own and at most
   * one review:
   * - second_fei against the first firm holding another FEI that scores in the review band or above and is at the same
   *   place, which depends on its band (samePlace): FDA gives each establishment its own FEI, so another FEI elsewhere
   *   is another establishment;
   * - score_band against the best firm without an FEI, when it scores in the review band.
   * When both qualify, the higher score opens its review, second_fei on a tie. A firm holding another FEI never gets a
   * score_band review.
   */
  private matchNewFei(record: FirmRecord): FeiMatch {
    const ranked = this.candidates.rank(record);
    const band = ({ score }: ScoredCandidate) => decideLink(score, this.cfg);
    const withoutFei = ranked.find(({ firm }) => firm.feis.length === 0);
    if (withoutFei && band(withoutFei) === 'link') return { decision: 'attach', candidate: withoutFei };
    const duplicate = ranked.find((candidate) => {
      const decision = band(candidate);
      return candidate.firm.feis.length > 0 && decision !== 'new' && samePlace(candidate.evidence, decision);
    });
    const near = withoutFei && band(withoutFei) === 'review' ? withoutFei : undefined;
    if (duplicate && (!near || duplicate.score >= near.score)) return { decision: 'second_fei', candidate: duplicate };
    if (near) return { decision: 'score_band', candidate: near };
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
    return this.candidates.add({ kind: 'new', index }, { nameNorm, address, commodityIds: [], feis: [] });
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
