import { Client } from 'pg';
import { POOL_DEFAULTS } from './client';
import { prepareTestDatabase } from './testing';

const EXPECTED_TABLES = [
  'alert', 'api_key', 'app_user', 'au_failing_food', 'audit_log', 'bulk_job', 'bulk_job_row', 'change_event',
  'commodity', 'commodity_rule', 'dispute', 'email_delivery', 'email_token', 'eu_mrl', 'eu_mrl_product',
  'eu_pesticide_residue', 'fda_charge_code', 'fda_refusal', 'firm', 'firm_alias', 'firm_fei', 'hazard', 'hazard_rule',
  'import_alert', 'import_alert_listing', 'import_alert_listing_product', 'import_alert_summary', 'invite', 'job_cursor',
  'lookup_log', 'match_review', 'membership', 'notice', 'notification_pref', 'org', 'paddle_event', 'rasff_notification',
  'refresh_token', 'source_file', 'source_sync_run', 'subscription', 'uk_border_notification', 'usage_counter', 'watchlist_item',
];

const ORG_A = '0192c7a0-0000-7000-8000-0000000000a1';

describe('database schema (spec §7)', () => {
  let client: Client;

  beforeAll(async () => {
    const url = await prepareTestDatabase('db');
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('insert into org (id, name) values ($1, $2)', [ORG_A, 'Org A']);
  });

  afterAll(async () => {
    await client.end();
  });

  it('creates exactly the 44 tables in spec §7', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('enables pg_trgm', async () => {
    const { rowCount } = await client.query("select 1 from pg_extension where extname = 'pg_trgm'");
    expect(rowCount).toBe(1);
  });

  it.each([
    'firm_name_norm_trgm_idx',
    'fda_refusal_name_trgm_idx',
    'import_alert_listing_name_trgm_idx',
    'au_failing_food_name_trgm_idx',
    'eu_pesticide_residue_name_trgm_idx',
    'notice_product_trgm_idx',
  ])('builds %s as a trigram GIN index', async (indexName) => {
    const { rows } = await client.query<{ indexdef: string }>('select indexdef from pg_indexes where indexname = $1', [indexName]);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('USING gin');
    expect(rows[0].indexdef).toContain('gin_trgm_ops');
  });

  it('treats app_user emails as case-insensitively unique', async () => {
    const insert = 'insert into app_user (id, email, password_hash, name) values ($1, $2, $3, $4)';
    await client.query(insert, ['0192c7a0-0000-7000-8000-000000000001', 'Owner@Example.com', 'hash', 'Owner']);
    await expect(
      client.query(insert, ['0192c7a0-0000-7000-8000-000000000002', 'owner@example.com', 'hash', 'Owner 2']),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('defaults a new user to English', async () => {
    const { rows } = await client.query<{ locale: string }>("select locale from app_user where email = 'Owner@Example.com'");
    expect(rows[0].locale).toBe('en');
  });

  it('deletes listing products together with their Import Alert listing', async () => {
    await client.query("insert into import_alert (number, title, text_sha256, url) values ('99-08', 'Pesticides', 'abc', 'https://example.gov/99-08')");
    const { rows } = await client.query<{ id: string }>(
      "insert into import_alert_listing (listing_key, alert_number, list, firm_name, name_norm, first_seen_on, last_seen_on) values ('k1', '99-08', 'red', 'Acme Foods', 'acme foods', '2026-10-01', '2026-10-01') returning id",
    );
    await client.query("insert into import_alert_listing_product (listing_id, product_code) values ($1, '28AYY99')", [rows[0].id]);
    await client.query('delete from import_alert_listing where id = $1', [rows[0].id]);
    const { rowCount } = await client.query('select 1 from import_alert_listing_product where listing_id = $1', [rows[0].id]);
    expect(rowCount).toBe(0);
  });

  it('lets one FEI belong to only one firm', async () => {
    const { rows } = await client.query<{ id: string }>(
      "insert into firm (display_name, name_norm, country_code) values ('Acme Foods', 'acme foods', 'PK') returning id",
    );
    await client.query('insert into firm_fei (fei, firm_id) values (3004249948, $1)', [rows[0].id]);
    await expect(client.query('insert into firm_fei (fei, firm_id) values (3004249948, $1)', [rows[0].id])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('requires a firm for firm watchlist items', async () => {
    await expect(
      client.query("insert into watchlist_item (id, org_id, kind) values ('0192c7a0-0000-7000-8000-0000000000b1', $1, 'firm')", [ORG_A]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps topic watchlist items unique per account', async () => {
    const insert =
      "insert into watchlist_item (id, org_id, kind, origin_country, topic_key) values ($1, $2, 'topic', 'PK', 'PK|*|EU|*')";
    await client.query(insert, ['0192c7a0-0000-7000-8000-0000000000b2', ORG_A]);
    await expect(client.query(insert, ['0192c7a0-0000-7000-8000-0000000000b3', ORG_A])).rejects.toMatchObject({ code: '23505' });
  });

  it('records which firm a match review was opened for, and why', async () => {
    const firmIds = await client.query<{ id: string }>(
      "insert into firm (display_name, name_norm, country_code) values ('Al Rehman Rice Mills', 'al rahman rice mills', 'PK'), ('Al Rahman Rice Mills', 'al rahman rice mills', 'PK') returning id",
    );
    const [newFirm, candidate] = firmIds.rows.map((r) => r.id);
    const { rows } = await client.query<{ reason: string; evidence: unknown; status: string }>(
      "insert into match_review (source, source_key, firm_id, candidate_firm_id, score) values ('au_failing_food', 'au-1', $1, $2, 0.81) returning reason, evidence, status",
      [newFirm, candidate],
    );
    expect(rows[0]).toEqual({ reason: 'score_band', evidence: {}, status: 'open' });
    await expect(
      client.query("insert into match_review (source, source_key, candidate_firm_id, score) values ('au_failing_food', 'au-2', $1, 0.8)", [candidate]),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('stores a dispute kind, defaulting to other', async () => {
    const firm = await client.query<{ id: string }>("insert into firm (display_name, name_norm, country_code) values ('Disputed Foods', 'disputed foods', 'PK') returning id");
    const { rows } = await client.query<{ kind: string }>(
      "insert into dispute (id, org_id, firm_id, message) values ('0192c7a0-0000-7000-8000-0000000000d1', $1, $2, 'Wrong firm') returning kind",
      [ORG_A, firm.rows[0].id],
    );
    expect(rows[0].kind).toBe('other');
  });

  it('timestamps taxonomy rules when they are added', async () => {
    await client.query("insert into hazard (id, slug, name, category) values (1, 'pesticide_residues', 'Pesticide residues', 'pesticide_residues')");
    const { rows } = await client.query<{ created_at: Date | null }>(
      "insert into hazard_rule (source, field, match_type, pattern, hazard_id) values ('rasff', 'hazard', 'keyword', 'anthraquinone', 1) returning created_at",
    );
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('indexes org_id on every account-owned table with a full (non-partial) index (spec §7)', async () => {
    const owned = ['membership', 'invite', 'subscription', 'lookup_log', 'usage_counter', 'watchlist_item', 'alert', 'bulk_job', 'dispute', 'api_key'];
    for (const table of owned) {
      const { rows } = await client.query<{ indexdef: string }>('select indexdef from pg_indexes where tablename = $1', [table]);
      const usable = rows.some((r) => /\(org_id[,)]/.test(r.indexdef) && !r.indexdef.includes(' WHERE '));
      expect({ table, usable }).toEqual({ table, usable: true });
    }
  });

  const noticeInsert = (source: string, destination: string, noticeType: string) =>
    client.query(
      "insert into notice (source, source_key, destination, notice_type, notice_on) values ($1, 'k', $2, $3, '2026-01-01')",
      [source, destination, noticeType],
    );
  const eventInsert = (kind: string, severity: string) =>
    client.query(
      "insert into change_event (source, source_key, kind, severity, occurred_on) values ('fda_refusal', 'k', $1, $2, '2026-01-01')",
      [kind, severity],
    );

  it.each([
    ['notice.source', () => noticeInsert('bogus', 'US', 'refusal')],
    ['notice.destination', () => noticeInsert('fda_refusal', 'XX', 'refusal')],
    ['notice.notice_type', () => noticeInsert('fda_refusal', 'US', 'bogus')],
    [
      'change_event.source',
      () =>
        client.query(
          "insert into change_event (source, source_key, kind, severity, occurred_on) values ('bogus', 'k', 'fda_refusal', 'high', '2026-01-01')",
        ),
    ],
    ['change_event.kind', () => eventInsert('bogus', 'high')],
    ['change_event.severity', () => eventInsert('fda_refusal', 'low')],
    [
      'change_event.destination',
      () =>
        client.query(
          "insert into change_event (source, source_key, kind, severity, occurred_on, destination) values ('fda_refusal', 'k', 'fda_refusal', 'high', '2026-01-01', 'XX')",
        ),
    ],
    ['source_sync_run.source', () => client.query("insert into source_sync_run (source, status) values ('bogus', 'running')")],
    ['source_sync_run.status', () => client.query("insert into source_sync_run (source, status) values ('rasff', 'done')")],
    [
      'import_alert_listing.list',
      () =>
        client.query(
          "insert into import_alert_listing (listing_key, alert_number, list, firm_name, name_norm, first_seen_on, last_seen_on) values ('k2', '99-08', 'blue', 'Acme', 'acme', '2026-10-01', '2026-10-01')",
        ),
    ],
    [
      'commodity_rule.match_type',
      () => client.query("insert into commodity_rule (source, field, match_type, pattern, commodity_id) values ('rasff', 'f', 'regex', 'p', 1)"),
    ],
    [
      'commodity_rule.source',
      () => client.query("insert into commodity_rule (source, field, match_type, pattern, commodity_id) values ('bogus', 'f', 'exact', 'p', 1)"),
    ],
    [
      'hazard_rule.match_type',
      () => client.query("insert into hazard_rule (source, field, match_type, pattern, hazard_id) values ('rasff', 'f', 'regex', 'p', 1)"),
    ],
    [
      'hazard_rule.source',
      () => client.query("insert into hazard_rule (source, field, match_type, pattern, hazard_id) values ('bogus', 'f', 'exact', 'p', 1)"),
    ],
    ['source_file.source', () => client.query("insert into source_file (source, url, sha256, rows) values ('bogus', 'https://x', 'abc', 3)")],
  ])('rejects an unknown value for %s', async (_column, run) => {
    await expect(run()).rejects.toMatchObject({ code: '23514' });
  });

  it('records a loaded source file with a default load time', async () => {
    const { rows } = await client.query<{ loaded_at: Date }>(
      "insert into source_file (source, url, sha256, rows) values ('uk_bn', 'https://x', 'abc', 3) returning loaded_at",
    );
    expect(rows[0].loaded_at).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - rows[0].loaded_at.getTime())).toBeLessThan(60_000);
  });

  it('keeps pool settings that let Neon scale to zero (spec §5.4)', () => {
    expect(POOL_DEFAULTS.max).toBe(5);
    expect(POOL_DEFAULTS.idleTimeoutMillis).toBe(10_000);
  });
});
