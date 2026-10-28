import type { MrlResponse, ResidueSearchResponse } from '@rejectradar/contracts';
import { commodity } from '@rejectradar/db';
import { daysAgo, seedReferenceData } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('MRL checker', () => {
  let t: TestApp;
  let session: TestSession;

  beforeAll(async () => {
    t = await startTestApp('api_mrl');
    await seedReferenceData(t.db);
    session = (await signUpVerified(t, { email: 'user@mrl.test' })).session;
    // The taxonomy has no commodity without codes under one with codes, so this one sits below rice (101, under 100).
    await t.db.insert(commodity).values({ id: 9101, slug: 'test-basmati', name: 'Test basmati', parentId: 101, ancestorIds: [101, 100] });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const residues = async (query: string): Promise<ResidueSearchResponse['residues']> =>
    ((await session.get(`/v1/mrl/residues${query}`).expect(200)).body as ResidueSearchResponse).residues;
  const check = async (query: string): Promise<MrlResponse> => (await session.get(`/v1/mrl${query}`).expect(200)).body as MrlResponse;

  it('residue search by prefix and similarity', async () => {
    expect(await residues('?q=tricyc')).toEqual([{ id: '1001', name: 'tricyclazole' }]);
    // A typo is still found by similarity.
    expect((await residues('?q=tricyclazol')).map((r) => r.id)).toEqual(['1001']);
    await session.get('/v1/mrl/residues?q=t').expect(400);
    await session.get('/v1/mrl/residues').expect(400);
  });

  it('underscore is literal', async () => {
    // Two characters at least, so `_` alone is refused; `under_` finds the residue whose name has a real underscore.
    await session.get('/v1/mrl/residues?q=_').expect(400);
    expect(await residues('?q=under_')).toEqual([{ id: '1002', name: 'under_score test' }]);
    // Unescaped, `u_` (and `%%`) would match every name starting with u (or every name at all).
    expect(await residues('?q=u_')).toEqual([]);
    expect(await residues('?q=%25%25')).toEqual([]);
  });
  it('limits for rice', async () => {
    const res = await check('?commodity=101&residue=1001');
    expect(res).toEqual({
      commodityId: 101,
      residue: { id: '1001', name: 'tricyclazole' },
      productCodes: ['0500060'],
      limits: [
        {
          productCode: '0500060',
          productName: 'Rice',
          mrlMgKg: 0.09,
          isLod: false,
          legalRef: 'Reg. (EU) 2023/1234',
          applicableFrom: '2023-09-01',
          comparison: null,
        },
      ],
      notices: expect.any(Array),
    });
    const lod = await check('?commodity=101&residue=1002');
    expect(lod.limits).toMatchObject([{ mrlMgKg: 0.01, isLod: true, legalRef: null, applicableFrom: null }]);
  });

  it("a parent commodity's codes are used when the child has none", async () => {
    const res = await check('?commodity=9101&residue=1001');
    expect(res.productCodes).toEqual(['0500060']);
    expect(res.limits).toHaveLength(1);
    // Chicken-and-egg guard: a commodity with no codes anywhere above it maps to nothing.
    const none = await check('?commodity=1001&residue=1001');
    expect(none).toMatchObject({ productCodes: [], limits: [] });
  });

  it('lab comparison', async () => {
    expect((await check('?commodity=101&residue=1001&lab=0.1')).limits[0].comparison).toBe('above');
    expect((await check('?commodity=101&residue=1001&lab=0.09')).limits[0].comparison).toBe('at_or_below');
    expect((await check('?commodity=101&residue=1001&lab=0')).limits[0].comparison).toBe('at_or_below');
    expect((await check('?commodity=101&residue=1001')).limits[0].comparison).toBeNull();
  });

  it('recent RASFF notices naming the residue', async () => {
    const res = await check('?commodity=101&residue=1001');
    expect(res.notices).toEqual([
      {
        reference: '2026.9001',
        notifiedOn: daysAgo(20),
        subject: 'Pesticide residues in rice from Pakistan',
        originCountries: ['PK'],
        url: 'https://webgate.ec.europa.eu/rasff-window/screen/notification/9001',
      },
    ]);
    // Reached through the parent commodity and through a descendant of rice, but not for another residue or commodity.
    expect((await check('?commodity=100&residue=1001')).notices).toHaveLength(1);
    expect((await check('?commodity=9101&residue=1001')).notices).toHaveLength(0);
    expect((await check('?commodity=101&residue=1002')).notices).toEqual([]);
    expect((await check('?commodity=201&residue=1001')).notices).toEqual([]);
  });

  it('unknown residue', async () => {
    await session.get('/v1/mrl?commodity=101&residue=9999').expect(404);
    await session.get('/v1/mrl?commodity=424242&residue=1001').expect(404);
  });

  it('refuses malformed queries', async () => {
    await session.get('/v1/mrl?residue=1001').expect(400);
    await session.get('/v1/mrl?commodity=101').expect(400);
    await session.get('/v1/mrl?commodity=abc&residue=1001').expect(400);
    await session.get('/v1/mrl?commodity=101&residue=1001&lab=-1').expect(400);
    await session.get('/v1/mrl?commodity=101&residue=1001&lab=1e3').expect(400);
    await session.get('/v1/mrl?commodity=101&residue=1001&lab=2000000').expect(400);
    await session.get('/v1/mrl?commodity=101&residue=123456789012345678901').expect(400);
  });

  it('needs a session', async () => {
    await t.session().get('/v1/mrl/residues?q=tri').expect(401);
  });
});
