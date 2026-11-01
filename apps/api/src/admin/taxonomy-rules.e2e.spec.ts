import type { AdminTaxonomyRule, TaxonomyPreviewResponse, TaxonomyRemapStatus, TaxonomyRulesResponse, UnmappedResponse } from '@rejectradar/contracts';
import { appUser, auditLog, commodity, commodityRule, hazard, notice } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('admin taxonomy rules', () => {
  let t: TestApp;
  let admin: TestSession;
  let adminId: string;
  let user: TestSession;
  let turmeric: number;
  let spices: number;

  beforeAll(async () => {
    t = await startTestApp('api_admin_taxonomy');
    const staff = await signUpVerified(t, { email: 'staff@taxonomy.test', name: 'Hina Staff' });
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, staff.userId));
    ({ session: admin, userId: adminId } = staff);
    ({ session: user } = await signUpVerified(t, { email: 'customer@taxonomy.test' }));
    const idOf = async (slug: string) => (await t.db.select({ id: commodity.id }).from(commodity).where(eq(commodity.slug, slug)))[0].id;
    turmeric = await idOf('turmeric');
    spices = await idOf('mixed-spices');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => t.resetRateLimits());

  const sample = { source: 'rasff', fields: { subject: 'Aflatoxins in turmeric powder from India' } };

  it('is for platform admins only', async () => {
    const routes = [
      ['get', '/v1/admin/taxonomy-rules'],
      ['post', '/v1/admin/taxonomy-rules'],
      ['post', '/v1/admin/taxonomy-rules/preview'],
      ['patch', '/v1/admin/taxonomy-rules/commodity/1'],
      ['delete', '/v1/admin/taxonomy-rules/commodity/1'],
      ['get', '/v1/admin/taxonomy/remap'],
      ['get', '/v1/admin/taxonomy/unmapped'],
      ['post', '/v1/admin/taxonomy/remap'],
    ] as const;
    for (const [method, path] of routes) {
      await t.session()[method](path).expect(401);
      expect((await user[method](path).expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('lists one kind of rule in evaluation order, narrowed by the filters', async () => {
    const all = (await admin.get('/v1/admin/taxonomy-rules').query({ kind: 'hazard' }).expect(200)).body as TaxonomyRulesResponse;
    expect(all.items).toHaveLength(200);
    expect(all.more).toBe(true);
    const priorities = all.items.map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));

    const found = (await admin.get('/v1/admin/taxonomy-rules').query({ source: '*', field: 'subject', q: 'turmeric' }).expect(200))
      .body as TaxonomyRulesResponse;
    expect(found.more).toBe(false);
    expect(found.items).toEqual([expect.objectContaining({ kind: 'commodity', source: '*', field: 'subject', matchType: 'keyword', pattern: 'turmeric', targetId: turmeric })]);
    expect(found.fields).toContainEqual({ source: 'rasff', field: 'subject' });
    await admin.get('/v1/admin/taxonomy-rules').query({ kind: 'colour' }).expect(400);
  });

  it('previews a sample with the stored rules and with an unsaved one', async () => {
    const plain = (await admin.post('/v1/admin/taxonomy-rules/preview').send(sample).expect(200)).body as TaxonomyPreviewResponse;
    expect(plain.current.commodityId).toBe(turmeric);
    expect(plain.current.hazardIds.length).toBeGreaterThan(0);
    expect(plain.withRule).toBeNull();

    const rule = { kind: 'commodity', source: 'rasff', field: 'subject', matchType: 'keyword', pattern: 'Turmeric Powder', targetId: spices, priority: 1 };
    const tried = (await admin.post('/v1/admin/taxonomy-rules/preview').send({ ...sample, rule }).expect(200)).body as TaxonomyPreviewResponse;
    expect(tried.current.commodityId).toBe(turmeric);
    expect(tried.withRule).toEqual({ commodityId: spices, hazardIds: plain.current.hazardIds });
    await admin.post('/v1/admin/taxonomy-rules/preview').send({ source: '*', fields: sample.fields }).expect(400);
  });

  it('adds, changes and deletes a rule, auditing each', async () => {
    const created = (
      await admin
        .post('/v1/admin/taxonomy-rules')
        .send({ kind: 'commodity', source: 'uk_bn', field: 'commodity', matchType: 'keyword', pattern: ' Chilli  Flakes! ', targetId: spices, priority: 5 })
        .expect(201)
    ).body as AdminTaxonomyRule;
    expect(created).toMatchObject({ kind: 'commodity', pattern: 'chilli flakes', targetId: spices, priority: 5 });
    const [stored] = await t.db.select().from(commodityRule).where(eq(commodityRule.id, created.id));
    expect(stored).toMatchObject({ pattern: 'chilli flakes', commodityId: spices, createdBy: adminId });

    const changed = (
      await admin
        .patch(`/v1/admin/taxonomy-rules/commodity/${created.id}`)
        .send({ source: 'uk_bn', field: 'commodity', matchType: 'code_prefix', pattern: '0904.21', targetId: turmeric, priority: 6 })
        .expect(200)
    ).body as AdminTaxonomyRule;
    // A code pattern is kept as written; the classifier ignores its separators.
    expect(changed).toMatchObject({ id: created.id, matchType: 'code_prefix', pattern: '0904.21', targetId: turmeric });

    await admin.delete(`/v1/admin/taxonomy-rules/commodity/${created.id}`).expect(204);
    await admin.delete(`/v1/admin/taxonomy-rules/commodity/${created.id}`).expect(404);
    const actions = (await t.db.select().from(auditLog).where(eq(auditLog.targetId, String(created.id)))).map((row) => [row.action, row.targetType]);
    expect(actions).toEqual([
      ['taxonomy_rule.create', 'commodity_rule'],
      ['taxonomy_rule.update', 'commodity_rule'],
      ['taxonomy_rule.delete', 'commodity_rule'],
    ]);
  });

  it('refuses a rule without a target, a pattern without letters or digits, or an unknown kind', async () => {
    const rule = { kind: 'hazard', source: 'rasff', field: 'subject', matchType: 'keyword', pattern: 'mould', targetId: 32000, priority: 5 };
    expect((await admin.post('/v1/admin/taxonomy-rules').send(rule).expect(400)).body.message).toBe('There is no hazard 32000.');
    await admin.post('/v1/admin/taxonomy-rules').send({ ...rule, targetId: turmeric, kind: 'commodity', pattern: '!!' }).expect(400);
    await admin.patch('/v1/admin/taxonomy-rules/colour/1').send({ ...rule, kind: undefined }).expect(400);
    const [{ id: hazardId }] = await t.db.select({ id: hazard.id }).from(hazard).limit(1);
    await admin.patch('/v1/admin/taxonomy-rules/hazard/999999').send({ ...rule, kind: undefined, targetId: hazardId }).expect(404);
  });

  it('lists the product texts no commodity rule matched, and each source\'s gaps', async () => {
    const base = { destination: 'EU', noticeType: 'rasff_border_rejection', source: 'rasff' } as const;
    await t.db.insert(notice).values([
      // The same text in three spellings, counted together under the most common one.
      { ...base, sourceKey: 'u1', noticeOn: '2026-09-01', productText: 'Dried mango slices' },
      { ...base, sourceKey: 'u2', noticeOn: '2026-10-02', productText: 'Dried mango slices' },
      { ...base, sourceKey: 'u3', noticeOn: '2026-08-03', productText: '  dried MANGO slices ' },
      { ...base, sourceKey: 'u4', noticeOn: '2026-10-04', productText: 'Jackfruit chips', hazardIds: [(await t.db.select({ id: hazard.id }).from(hazard).limit(1))[0].id] },
      // Mapped, or with no text: not listed.
      { ...base, sourceKey: 'u5', noticeOn: '2026-10-05', productText: 'Turmeric powder', commodityId: turmeric },
      { ...base, sourceKey: 'u6', noticeOn: '2026-10-06', productText: '   ' },
      { ...base, source: 'uk_bn', noticeType: 'uk_border_notification', destination: 'UK', sourceKey: 'u7', noticeOn: '2026-10-07', productText: 'Okra' },
    ]);
    const all = (await admin.get('/v1/admin/taxonomy/unmapped').expect(200)).body as UnmappedResponse;
    expect(all.values).toEqual([
      { source: 'rasff', text: 'Dried mango slices', notices: 3, lastSeen: '2026-10-02' },
      { source: 'rasff', text: 'Jackfruit chips', notices: 1, lastSeen: '2026-10-04' },
      { source: 'uk_bn', text: 'Okra', notices: 1, lastSeen: '2026-10-07' },
    ]);
    expect(all.sources.map((s) => s.source)).toEqual(['fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis']);
    expect(all.sources.find((s) => s.source === 'rasff')).toEqual({ source: 'rasff', notices: 6, noCommodity: 5, noHazard: 5 });
    expect(all.sources.find((s) => s.source === 'fda_refusal')).toEqual({ source: 'fda_refusal', notices: 0, noCommodity: 0, noHazard: 0 });

    const uk = (await admin.get('/v1/admin/taxonomy/unmapped').query({ source: 'uk_bn' }).expect(200)).body as UnmappedResponse;
    expect(uk.values.map((v) => v.text)).toEqual(['Okra']);
    await admin.get('/v1/admin/taxonomy/unmapped').query({ source: 'nope' }).expect(400);
  });

  it('records a remap request until the daily job runs it', async () => {
    expect((await admin.get('/v1/admin/taxonomy/remap').expect(200)).body).toEqual({ requested: null, lastRun: null, waiting: false });
    const requested = (await admin.post('/v1/admin/taxonomy/remap').expect(200)).body as TaxonomyRemapStatus;
    expect(requested).toMatchObject({ requested: { by: 'Hina Staff' }, lastRun: null, waiting: true });

    await t.db.insert(auditLog).values({ action: 'taxonomy.remap_run', targetType: 'taxonomy', targetId: 'rules', details: { updated: { rasff: 3 } } });
    const ran = (await admin.get('/v1/admin/taxonomy/remap').expect(200)).body as TaxonomyRemapStatus;
    expect(ran).toMatchObject({ lastRun: { updated: { rasff: 3 } }, waiting: false });
  });
});
