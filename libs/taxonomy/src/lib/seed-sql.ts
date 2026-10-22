import { ancestorIds, COMMODITIES } from './commodities';
import { HAZARDS } from './hazards';
import {
  COVERAGE_COMMODITY_RULES,
  COVERAGE_HAZARD_RULES,
  SEED_COMMODITY_RULES,
  SEED_HAZARD_RULES,
  type RuleSeed,
} from './rules';

const BREAKPOINT = '--> statement-breakpoint';
const RULES_PER_STATEMENT = 250;

const COMMODITY_IDS: ReadonlyMap<string, number> = new Map(COMMODITIES.map((c) => [c.slug, c.id]));
const HAZARD_IDS: ReadonlyMap<string, number> = new Map(HAZARDS.map((h) => [h.slug, h.id]));

const text = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const textArray = (values: readonly string[]): string =>
  values.length === 0 ? `'{}'::text[]` : `ARRAY[${values.map(text).join(', ')}]::text[]`;
const intArray = (values: readonly number[]): string =>
  values.length === 0 ? `'{}'::int[]` : `ARRAY[${values.join(', ')}]::int[]`;

function ruleStatements(
  table: 'commodity_rule' | 'hazard_rule',
  targetColumn: 'commodity_id' | 'hazard_id',
  rules: readonly RuleSeed[],
  idsBySlug: ReadonlyMap<string, number>,
): string[] {
  const rows = rules.map((rule) => {
    const targetId = idsBySlug.get(rule.target);
    if (targetId === undefined) throw new Error(`${table}: unknown target "${rule.target}"`);
    return `  (${text(rule.source)}, ${text(rule.field)}, ${text(rule.matchType)}, ${text(rule.pattern)}, ${targetId}, ${rule.priority}, null)`;
  });
  const statements: string[] = [];
  for (let start = 0; start < rows.length; start += RULES_PER_STATEMENT) {
    statements.push(
      `insert into ${table} (source, field, match_type, pattern, ${targetColumn}, priority, created_by) values\n` +
        `${rows.slice(start, start + RULES_PER_STATEMENT).join(',\n')};`,
    );
  }
  return statements;
}

/**
 * The SQL that seeds the taxonomy: commodities and hazards (fixed ids, `on conflict do nothing`) and their rules
 * (identity ids, inserted in seed order so ties between rules keep resolving the same way).
 */
export function taxonomySeedSql(): string {
  const commodityRows = COMMODITIES.map(
    (c) =>
      `  (${c.id}, ${text(c.slug)}, ${text(c.name)}, ${c.parentId ?? 'null'}, ${intArray(ancestorIds(c.id))}, ${textArray(c.hsHeadings)}, ${textArray(c.euMrlCodes)})`,
  );
  const hazardRows = HAZARDS.map((h) => `  (${h.id}, ${text(h.slug)}, ${text(h.name)}, ${text(h.category)})`);

  const statements = [
    `insert into commodity (id, slug, name, parent_id, ancestor_ids, hs_headings, eu_mrl_codes) values\n${commodityRows.join(',\n')}\non conflict do nothing;`,
    `insert into hazard (id, slug, name, category) values\n${hazardRows.join(',\n')}\non conflict do nothing;`,
    ...ruleStatements('commodity_rule', 'commodity_id', SEED_COMMODITY_RULES, COMMODITY_IDS),
    ...ruleStatements('hazard_rule', 'hazard_id', SEED_HAZARD_RULES, HAZARD_IDS),
  ];
  return `${statements.join(`\n${BREAKPOINT}\n`)}\n`;
}

/** The SQL of migration 0009_taxonomy_coverage: the rules added after the seed, inserted after its rules. */
export function taxonomyCoverageSql(): string {
  const statements = [
    ...ruleStatements('commodity_rule', 'commodity_id', COVERAGE_COMMODITY_RULES, COMMODITY_IDS),
    ...ruleStatements('hazard_rule', 'hazard_id', COVERAGE_HAZARD_RULES, HAZARD_IDS),
  ];
  return `${statements.join(`\n${BREAKPOINT}\n`)}\n`;
}
