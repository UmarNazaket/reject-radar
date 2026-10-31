import { appUser, auditLog, type Database, invite, membership, org, prepareTestDatabase, usageCounter, uuidv7 } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { BACKUP_TABLES, backupApp, restoreApp } from './backup';

describe('backup:app and backup:restore', () => {
  let source: ReturnType<typeof openDb>;
  let target: ReturnType<typeof openDb>;
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'backup-')), 'app.ndjson.gz');

  beforeAll(async () => {
    source = openDb(await prepareTestDatabase('ingest_backup_source'));
    target = openDb(await prepareTestDatabase('ingest_backup_target'));
    const orgId = uuidv7();
    const userId = uuidv7();
    const db = source.db;
    await db.insert(org).values({ id: orgId, name: 'زرفین رائس ملز', planOverride: 'business' });
    await db.insert(appUser).values({ id: userId, email: 'sara@example.com', passwordHash: 'x', name: 'Sara', locale: 'ur', emailVerifiedAt: new Date('2026-10-01T08:00:00.123Z') });
    await db.insert(membership).values({ orgId, userId, role: 'owner' });
    await db.insert(invite).values({ id: uuidv7(), orgId, email: 'ali@example.com', role: 'member', tokenHash: 'h', invitedBy: userId, expiresAt: new Date('2026-11-01T00:00:00Z') });
    await db.insert(usageCounter).values({ orgId, period: '2026-10', lookups: 12 });
    await db.insert(auditLog).values([
      { actorUserId: userId, action: 'org.plan_override', targetType: 'org', targetId: orgId, details: { before: null, after: 'business', note: 'a "quoted" line\nand a second' } },
      { action: 'taxonomy.remap_run', targetType: 'taxonomy', targetId: 'rules', details: { updated: { rasff: 3 } } },
    ]);
  });

  afterAll(async () => {
    await source.close();
    await target.close();
  });

  const dump = async (db: Database, table: string) =>
    (await db.execute<{ row: string }>(sql`select row_to_json(t)::text as row from ${sql.identifier(table)} t`)).rows.map((r) => r.row).sort();

  it('restores every account table as it was, into an empty database', async () => {
    const counts = await backupApp(source.db, file);
    expect(counts).toMatchObject({ org: 1, app_user: 1, membership: 1, invite: 1, usage_counter: 1, audit_log: 2, alert: 0 });
    // Gzip, never plain text.
    expect(readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    expect(await restoreApp(target.db, file)).toEqual(counts);
    for (const table of BACKUP_TABLES) expect(await dump(target.db, table)).toEqual(await dump(source.db, table));

    // The identity sequence moved past the restored ids.
    const [{ id }] = await target.db.insert(auditLog).values({ action: 'test', targetType: 't', targetId: '1' }).returning({ id: auditLog.id });
    expect(id).toBeGreaterThan(Math.max(...(await target.db.select({ id: auditLog.id }).from(auditLog)).filter((r) => r.id !== id).map((r) => r.id)));
  });

  it('refuses to restore over account rows', async () => {
    await expect(restoreApp(target.db, file)).rejects.toThrow('org already has rows');
  });
});
