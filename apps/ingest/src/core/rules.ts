import { commodityRule, hazardRule, type Database } from '@rejectradar/db';
import { buildRuleSet, type RuleSet, type TaxonomyRule } from '@rejectradar/taxonomy';
import type { RuleMatchType, RuleSource } from '@rejectradar/contracts';
import { asc } from 'drizzle-orm';

/** Reads the classification rules (seeded plus anything added since) once; a sync classifies with the result. */
export async function loadRuleSet(db: Database): Promise<RuleSet> {
  const [commodity, hazard] = await Promise.all([
    db.select().from(commodityRule).orderBy(asc(commodityRule.priority), asc(commodityRule.id)),
    db.select().from(hazardRule).orderBy(asc(hazardRule.priority), asc(hazardRule.id)),
  ]);

  const rule = (
    row: { id: number; source: string; field: string; matchType: string; pattern: string; priority: number },
    targetId: number,
  ): TaxonomyRule => ({
    id: row.id,
    // The database CHECK constraints keep these within the contracts unions.
    source: row.source as RuleSource,
    field: row.field,
    matchType: row.matchType as RuleMatchType,
    pattern: row.pattern,
    targetId,
    priority: row.priority,
  });

  return buildRuleSet(
    commodity.map((row) => rule(row, row.commodityId)),
    hazard.map((row) => rule(row, row.hazardId)),
  );
}
