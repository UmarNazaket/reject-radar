import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type AdminTaxonomyRule,
  type CreateTaxonomyRuleRequest,
  NOTICE_SOURCES,
  type NoticeSource,
  type RuleMatchType,
  type RuleSource,
  TAXONOMY_REMAP_RAN,
  TAXONOMY_REMAP_REQUESTED,
  TAXONOMY_RULE_LIMIT,
  type TaxonomyClassification,
  type TaxonomyPreviewRequest,
  type TaxonomyPreviewResponse,
  type TaxonomyRemapStatus,
  type TaxonomyRuleKind,
  type TaxonomyRuleQuery,
  type TaxonomyRuleRequest,
  type TaxonomyRulesResponse,
  UNMAPPED_LIMIT,
  type UnmappedQuery,
  type UnmappedResponse,
} from '@rejectradar/contracts';
import { appUser, auditLog, commodity, commodityRule, type Database, hazard, hazardRule } from '@rejectradar/db';
import { buildRuleSet, classifyCommodity, classifyHazards, loadRuleSet, normalizeRuleText, type RuleSet, type TaxonomyRule } from '@rejectradar/taxonomy';
import { and, asc, desc, eq, ilike, type SQL, sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';

/** The table, target column and target table of each kind; the two rule tables have the same shape. */
const KINDS = {
  commodity: { table: commodityRule, target: commodityRule.commodityId, targets: commodity },
  hazard: { table: hazardRule, target: hazardRule.hazardId, targets: hazard },
} as const;

/** Keyword and exact patterns are compared normalised, so they are stored that way (as the seeds are). */
const storedPattern = (matchType: RuleMatchType, pattern: string): string => (matchType === 'code_prefix' ? pattern : normalizeRuleText(pattern));

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');

/** The commodity and hazard rules (P10): list, add, change and delete them, try them on a sample, ask for a remap, and see what no rule matched. */
@Injectable()
export class TaxonomyRulesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(query: TaxonomyRuleQuery): Promise<TaxonomyRulesResponse> {
    const { table, target } = KINDS[query.kind];
    const filters: (SQL | undefined)[] = [
      query.source === undefined ? undefined : eq(table.source, query.source),
      query.field === undefined ? undefined : eq(table.field, query.field),
      query.target === undefined ? undefined : eq(target, query.target),
      query.q === undefined ? undefined : ilike(table.pattern, `%${escapeLike(query.q)}%`),
    ];
    const rows = await this.db
      .select({ id: table.id, source: table.source, field: table.field, matchType: table.matchType, pattern: table.pattern, targetId: target, priority: table.priority })
      .from(table)
      .where(and(...filters))
      .orderBy(asc(table.priority), asc(table.id))
      .limit(TAXONOMY_RULE_LIMIT + 1);
    const fields = await this.db.selectDistinct({ source: table.source, field: table.field }).from(table).orderBy(asc(table.source), asc(table.field));
    return {
      items: rows.slice(0, TAXONOMY_RULE_LIMIT).map((row) => this.toRule(query.kind, row)),
      more: rows.length > TAXONOMY_RULE_LIMIT,
      fields: fields.map((f) => ({ source: f.source as RuleSource, field: f.field })),
    };
  }

  async create(ctx: RequestContext, body: CreateTaxonomyRuleRequest): Promise<AdminTaxonomyRule> {
    const { kind, ...fields } = body;
    await this.assertValid(kind, fields);
    return this.db.transaction(async (tx) => {
      const { table } = KINDS[kind];
      const [{ id }] = await tx.insert(table).values({ ...this.values(kind, fields), createdBy: ctx.userId }).returning({ id: table.id });
      const rule = this.toRule(kind, { id, ...fields, pattern: storedPattern(fields.matchType, fields.pattern) });
      await tx.insert(auditLog).values({ actorUserId: ctx.userId, action: 'taxonomy_rule.create', targetType: `${kind}_rule`, targetId: String(id), details: { rule } });
      return rule;
    });
  }

  async update(ctx: RequestContext, kind: TaxonomyRuleKind, id: number, body: TaxonomyRuleRequest): Promise<AdminTaxonomyRule> {
    await this.assertValid(kind, body);
    return this.db.transaction(async (tx) => {
      const { table, target } = KINDS[kind];
      const [before] = await tx
        .select({ id: table.id, source: table.source, field: table.field, matchType: table.matchType, pattern: table.pattern, targetId: target, priority: table.priority })
        .from(table)
        .where(eq(table.id, id))
        .for('update');
      if (!before) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
      await tx.update(table).set(this.values(kind, body)).where(eq(table.id, id));
      const rule = this.toRule(kind, { id, ...body, pattern: storedPattern(body.matchType, body.pattern) });
      await tx.insert(auditLog).values({
        actorUserId: ctx.userId,
        action: 'taxonomy_rule.update',
        targetType: `${kind}_rule`,
        targetId: String(id),
        details: { before: this.toRule(kind, before), rule },
      });
      return rule;
    });
  }

  async remove(ctx: RequestContext, kind: TaxonomyRuleKind, id: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { table, target } = KINDS[kind];
      const [deleted] = await tx
        .delete(table)
        .where(eq(table.id, id))
        .returning({ id: table.id, source: table.source, field: table.field, matchType: table.matchType, pattern: table.pattern, targetId: target, priority: table.priority });
      if (!deleted) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
      await tx.insert(auditLog).values({ actorUserId: ctx.userId, action: 'taxonomy_rule.delete', targetType: `${kind}_rule`, targetId: String(id), details: { rule: this.toRule(kind, deleted) } });
    });
  }

  async preview(body: TaxonomyPreviewRequest): Promise<TaxonomyPreviewResponse> {
    const rules = await loadRuleSet(this.db);
    const current = this.classify(rules, body);
    if (!body.rule) return { current, withRule: null };
    const { kind, id, ...fields } = body.rule;
    // An unsaved rule takes the id of the rule it changes, or one after every stored rule.
    const unsaved: TaxonomyRule = { id: id ?? Number.MAX_SAFE_INTEGER, ...fields, pattern: storedPattern(fields.matchType, fields.pattern) };
    const replace = (list: readonly TaxonomyRule[], own: boolean) => (own ? [...list.filter((rule) => rule.id !== id), unsaved] : [...list]);
    const withRule = buildRuleSet(replace(rules.commodity, kind === 'commodity'), replace(rules.hazard, kind === 'hazard'));
    return { current, withRule: this.classify(withRule, body) };
  }

  /** The product texts of notices with no commodity, most frequent first, and each source's notices without a commodity or a hazard. */
  async unmapped(query: UnmappedQuery): Promise<UnmappedResponse> {
    const [values, counts] = await Promise.all([
      this.db.execute<{ source: NoticeSource; text: string; notices: number; last_seen: string }>(sql`
        select source, mode() within group (order by product_text) as text, count(*)::int as notices, max(notice_on)::text as last_seen
        from notice
        where commodity_id is null and btrim(coalesce(product_text, '')) <> '' and (${query.source ?? null}::text is null or source = ${query.source ?? null})
        group by source, lower(btrim(product_text))
        order by notices desc, text asc
        limit ${UNMAPPED_LIMIT}`),
      this.db.execute<{ source: NoticeSource; notices: number; no_commodity: number; no_hazard: number }>(sql`
        select source, count(*)::int as notices, (count(*) filter (where commodity_id is null))::int as no_commodity,
               (count(*) filter (where cardinality(hazard_ids) = 0))::int as no_hazard
        from notice
        group by source`),
    ]);
    return {
      values: values.rows.map((row) => ({ source: row.source, text: row.text, notices: row.notices, lastSeen: row.last_seen })),
      sources: NOTICE_SOURCES.map((source) => {
        const row = counts.rows.find((r) => r.source === source);
        return { source, notices: row?.notices ?? 0, noCommodity: row?.no_commodity ?? 0, noHazard: row?.no_hazard ?? 0 };
      }),
    };
  }

  async remapStatus(): Promise<TaxonomyRemapStatus> {
    const [requested] = await this.db
      .select({ at: auditLog.createdAt, by: appUser.name })
      .from(auditLog)
      .leftJoin(appUser, eq(appUser.id, auditLog.actorUserId))
      .where(eq(auditLog.action, TAXONOMY_REMAP_REQUESTED))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const [ran] = await this.db
      .select({ at: auditLog.createdAt, details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, TAXONOMY_REMAP_RAN))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    return {
      requested: requested ? { at: requested.at.toISOString(), by: requested.by } : null,
      lastRun: ran ? { at: ran.at.toISOString(), updated: (ran.details as { updated?: Record<string, number> }).updated ?? {} } : null,
      waiting: !!requested && (!ran || requested.at > ran.at),
    };
  }

  /** Records the request; the daily sync job runs the remap after its syncs (`taxonomy:remap --if-requested`). */
  async requestRemap(ctx: RequestContext): Promise<TaxonomyRemapStatus> {
    await this.db.insert(auditLog).values({ actorUserId: ctx.userId, action: TAXONOMY_REMAP_REQUESTED, targetType: 'taxonomy', targetId: 'rules' });
    return this.remapStatus();
  }

  private classify(rules: RuleSet, body: TaxonomyPreviewRequest): TaxonomyClassification {
    const values = Object.fromEntries(Object.entries(body.fields).map(([field, text]) => [field, [text]]));
    return { commodityId: classifyCommodity(rules, body.source, body.fields), hazardIds: classifyHazards(rules, body.source, values) };
  }

  /** A rule must point at a commodity or hazard that exists, and a text pattern must keep a letter or digit once normalised. */
  private async assertValid(kind: TaxonomyRuleKind, body: TaxonomyRuleRequest): Promise<void> {
    if (storedPattern(body.matchType, body.pattern) === '') throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The pattern has no letters or digits.');
    const { targets } = KINDS[kind];
    const [found] = await this.db.select({ id: targets.id }).from(targets).where(eq(targets.id, body.targetId));
    if (!found) throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', `There is no ${kind} ${body.targetId}.`);
  }

  private values(kind: TaxonomyRuleKind, body: TaxonomyRuleRequest) {
    const common = { source: body.source, field: body.field, matchType: body.matchType, pattern: storedPattern(body.matchType, body.pattern), priority: body.priority };
    return kind === 'commodity' ? { ...common, commodityId: body.targetId } : { ...common, hazardId: body.targetId };
  }

  private toRule(
    kind: TaxonomyRuleKind,
    row: { id: number; source: string; field: string; matchType: string; pattern: string; targetId: number; priority: number },
  ): AdminTaxonomyRule {
    return { id: row.id, kind, source: row.source as RuleSource, field: row.field, matchType: row.matchType as RuleMatchType, pattern: row.pattern, targetId: row.targetId, priority: row.priority };
  }
}
