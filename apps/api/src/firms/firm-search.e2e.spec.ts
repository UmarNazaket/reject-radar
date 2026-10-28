import type { FirmSearchQuery, FirmSearchResponse } from '@rejectradar/contracts';
import { firm, firmFei, lookupLog, usageCounter } from '@rejectradar/db';
import { inArray } from 'drizzle-orm';
import { insertFirm } from '@rejectradar/entities';
import { labelQueryScore, MATCH_CONFIG, normalizeCity, queryScore } from '@rejectradar/matching';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';
import { type FirmSearchHit, FirmSearchService } from './firm-search.service';

describe('firm search', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let session: TestSession;

  beforeAll(async () => {
    t = await startTestApp('api_firm_search');
    fx = await seedReferenceData(t.db);
    session = (await signUpVerified(t, { email: 'user@firm-search.test' })).session;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const search = async (query: string, who: TestSession = session): Promise<FirmSearchResponse['results']> => {
    const res = await who.get(`/v1/firms/search${query}`).expect(200);
    return (res.body as FirmSearchResponse).results;
  };

  it('FEI goes straight to the firm', async () => {
    const results = await search('?fei=3001234567');
    expect(results).toEqual([
      {
        id: fx.firms.zarfeen,
        displayName: 'ZARFEEN RICE MILLS (PVT) LTD',
        label: 'strong',
        score: 1,
        countryCode: 'PK',
        city: 'lahore',
        region: 'Punjab',
        commodityIds: [101],
        lastNoticeOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    ]);
    expect(await search('?fei=3009999999')).toEqual([]);
  });

  it('an FEI of a firm merged away goes to the firm it was merged into', async () => {
    await t.db.insert(firmFei).values({ fei: 3007654321, firmId: fx.firms.mergedAway });
    const results = await search('?fei=3007654321');
    expect(results.map((r) => r.id)).toEqual([fx.firms.zarfeen]);
  });

  it("the spec's examples (§8.3)", async () => {
    const withCity = await search('?name=Al Rahman Rice Mills&country=PK&city=Lahore');
    expect(withCity.map((r) => [r.id, r.score, r.label])).toEqual([
      [fx.firms.alRahmanLahore, 0.91, 'strong'],
      [fx.firms.alRahmanKarachi, 0.85, 'possible'],
    ]);

    const withoutCity = await search('?name=Al Rahman Rice Mills&country=PK');
    expect(withoutCity.map((r) => [r.id, r.score, r.label])).toEqual([
      [fx.firms.alRahmanLahore, 0.85, 'possible'],
      [fx.firms.alRahmanKarachi, 0.85, 'possible'],
    ]);

    // Unique exact: the merged-away copy of ZARFEEN is not a second candidate.
    const unique = await search('?name=Zarfeen Rice Mills');
    expect(unique.map((r) => [r.id, r.score, r.label])).toEqual([[fx.firms.zarfeen, 0.9, 'strong']]);
  });

  it('the city is compared in its stored, normalised form', async () => {
    expect(normalizeCity('  LAHORE ')).toBe('lahore');
    const results = await search('?name=Al Rahman Rice Mills&city=%20LAHORE%20');
    expect(results[0]).toMatchObject({ id: fx.firms.alRahmanLahore, score: 0.91 });
  });

  it('SQL score equals queryScore', async () => {
    // Firms that are near, but not equal to, the queried names, so sims other than 1 are covered.
    const extra = [
      await insertFirm(t.db, { displayName: 'Zarfeen Rice Mill Trading Co', countryCode: 'PK', city: 'lahore' }),
      await insertFirm(t.db, { displayName: 'Rahman Rice Mills', countryCode: 'IN', city: 'delhi' }),
      await insertFirm(t.db, { displayName: 'Al Rahman Spice Traders', countryCode: 'PK', city: 'karachi' }),
    ];
    const service = t.app.get(FirmSearchService);
    const queries: FirmSearchQuery[] = [
      { name: 'Zarfeen Rice Mills' },
      { name: 'Zarfeen Rice', city: 'Lahore' },
      { name: 'Al Rahman Rice Mills', country: 'PK', city: 'Karachi' },
      { name: 'Rahman Rice Mills' },
      { name: 'Al Rahman Spice', city: 'karachi' },
    ];
    let compared = 0;
    try {
      for (const query of queries) {
        const hits: FirmSearchHit[] = await service.searchWithEvidence(query);
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
          const { sim, cityMatch, uniqueNearExact } = hit.evidence;
          expect(hit.score).toBe(queryScore({ sim, cityMatch, uniqueNearExact }));
          expect(hit.label).toBe(labelQueryScore(hit.score));
          compared++;
        }
      }
    } finally {
      // The other specs count on the fixture's firms alone.
      await t.db.delete(firm).where(inArray(firm.id, extra));
    }
    expect(compared).toBeGreaterThan(8);
  });

  it('results below the other threshold are dropped, the rest ordered by score then id', async () => {
    // Similar enough to be a candidate (pg_trgm 0.3) but scoring under 0.50.
    const results = await search('?name=Zarfeen Traders');
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(MATCH_CONFIG.query.other);
    const sorted = [...results].sort((a, b) => b.score - a.score || a.id - b.id);
    expect(results).toEqual(sorted);
  });

  it('country is a filter', async () => {
    expect(await search('?name=Al Rahman Rice Mills&country=IN')).toEqual([]);
  });

  it('results show no facts', async () => {
    const results = await search('?name=Zarfeen Rice Mills');
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]).sort()).toEqual(
      ['city', 'commodityIds', 'countryCode', 'displayName', 'id', 'label', 'lastNoticeOn', 'region', 'score'].sort(),
    );
    expect(JSON.stringify(results)).not.toMatch(/flags|metrics|count"/i);
  });

  it('a name of only legal words gives no results', async () => {
    expect(await search('?name=Pvt Ltd')).toEqual([]);
  });

  it('asks for a name or an FEI, and refuses malformed filters', async () => {
    await session.get('/v1/firms/search').expect(400);
    await session.get('/v1/firms/search?country=PK').expect(400);
    await session.get('/v1/firms/search?name=a').expect(400);
    await session.get('/v1/firms/search?name=Zarfeen&country=pk').expect(400);
    await session.get('/v1/firms/search?fei=12ab').expect(400);
    await session.get('/v1/firms/search?fei=1234567890123456').expect(400);
    await session.get(`/v1/firms/search?name=Zarfeen&city=${'x'.repeat(101)}`).expect(400);
  });

  it('needs a session', async () => {
    await t.session().get('/v1/firms/search?name=Zarfeen').expect(401);
  });

  it('30 a minute per user', async () => {
    for (let i = 0; i < 30; i++) await session.get('/v1/firms/search?name=Zarfeen Rice Mills').expect(200);
    const limited = await session.get('/v1/firms/search?name=Zarfeen Rice Mills').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another user has a counter of their own.
    const other = await signUpVerified(t, { email: 'other@firm-search.test' });
    await other.session.get('/v1/firms/search?name=Zarfeen Rice Mills').expect(200);
  });

  it('uses no lookup', async () => {
    await search('?name=Zarfeen Rice Mills');
    await search('?fei=3001234567');
    expect(await t.db.select().from(usageCounter)).toEqual([]);
    expect(await t.db.select().from(lookupLog)).toEqual([]);
  });

  it('works for unverified users', async () => {
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@firm-search.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@firm-search.test', password: 'zarfeen-rice-2026' }).expect(200);
    expect((await search('?name=Zarfeen Rice Mills', unverified)).map((r) => r.id)).toEqual([fx.firms.zarfeen]);
  });
});
