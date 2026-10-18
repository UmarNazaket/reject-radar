import type { NoticeSource, RuleMatchType, RuleSource } from '@rejectradar/contracts';
import { foldToAscii } from '@rejectradar/matching';
import { OTHER_FOOD_ID } from './commodities';
import { UNCLASSIFIED_ID } from './hazards';

/** A rule row as the classifier sees it (the database row with its target id). */
export interface TaxonomyRule {
  id: number;
  source: RuleSource;
  field: string;
  matchType: RuleMatchType;
  pattern: string;
  targetId: number;
  priority: number;
}

/** Rules ordered for first-match evaluation: by priority, then id. */
export interface RuleSet {
  commodity: readonly TaxonomyRule[];
  hazard: readonly TaxonomyRule[];
}

export type ClassifySource = NoticeSource | 'fda_charge_code';

const byPriorityThenId = (a: TaxonomyRule, b: TaxonomyRule): number => a.priority - b.priority || a.id - b.id;

export function buildRuleSet(commodity: TaxonomyRule[], hazard: TaxonomyRule[]): RuleSet {
  return { commodity: [...commodity].sort(byPriorityThenId), hazard: [...hazard].sort(byPriorityThenId) };
}

/** Folds accents, lowercases, turns `&` into `and` and collapses every run of other characters into one space. */
export function normalizeRuleText(value: string): string {
  return foldToAscii(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const stripCodeSeparators = (value: string): string => value.toLowerCase().replace(/[\s.-]+/g, '');

/** A value prepared once per classification call, so a rule list does not re-normalise it for every rule. */
interface Prepared {
  text: string;
  padded: string;
  code: string;
}

function prepare(value: string): Prepared {
  const text = normalizeRuleText(value);
  return { text, padded: ` ${text} `, code: stripCodeSeparators(value) };
}

/** Rule patterns are few and reused for every notice; normalise each one once. */
const patternCache = new Map<string, Prepared>();

function preparedPattern(pattern: string): Prepared {
  let prepared = patternCache.get(pattern);
  if (prepared === undefined) {
    prepared = prepare(pattern);
    patternCache.set(pattern, prepared);
  }
  return prepared;
}

function matches(rule: TaxonomyRule, value: Prepared): boolean {
  const pattern = preparedPattern(rule.pattern);
  switch (rule.matchType) {
    case 'keyword':
      return pattern.text.length > 0 && value.padded.includes(pattern.padded);
    case 'exact':
      return pattern.text.length > 0 && value.text === pattern.text;
    case 'code_prefix':
      return pattern.code.length > 0 && value.code.startsWith(pattern.code);
  }
}

const appliesTo = (rule: TaxonomyRule, source: ClassifySource): boolean =>
  rule.source === source || rule.source === '*';

/** The first rule (lowest priority number, then id) that matches wins; nothing matching gives "Other food". */
export function classifyCommodity(
  rules: RuleSet,
  source: ClassifySource,
  fields: Record<string, string | null | undefined>,
): number {
  const prepared = new Map<string, Prepared | null>();
  for (const rule of rules.commodity) {
    if (!appliesTo(rule, source)) continue;
    let value = prepared.get(rule.field);
    if (value === undefined) {
      const raw = fields[rule.field];
      value = raw === null || raw === undefined ? null : prepare(raw);
      prepared.set(rule.field, value);
    }
    if (value !== null && matches(rule, value)) return rule.targetId;
  }
  return OTHER_FOOD_ID;
}

/**
 * Each value is matched on its own (first rule wins per value); the result is the sorted union of the hazards found,
 * or `[unclassified]` when nothing matched.
 */
export function classifyHazards(
  rules: RuleSet,
  source: ClassifySource,
  values: Record<string, readonly (string | null | undefined)[]>,
): number[] {
  const found = new Set<number>();
  for (const [field, list] of Object.entries(values)) {
    const candidates = rules.hazard.filter((rule) => rule.field === field && appliesTo(rule, source));
    if (candidates.length === 0) continue;
    for (const raw of list) {
      if (raw === null || raw === undefined) continue;
      const value = prepare(raw);
      const hit = candidates.find((rule) => matches(rule, value));
      if (hit !== undefined) found.add(hit.targetId);
    }
  }
  return found.size === 0 ? [UNCLASSIFIED_ID] : [...found].sort((a, b) => a - b);
}
