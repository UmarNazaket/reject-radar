import { taxonomyQuery, type TaxonomyResponse } from '@rejectradar/contracts';
import { notice } from '@rejectradar/db';
import { CATALOGS } from '@rejectradar/i18n';
import { COMMODITIES, HAZARDS } from '@rejectradar/taxonomy';
import request from 'supertest';
import { startTestApp, type TestApp } from '../testing/test-app';
import { TaxonomyService } from './taxonomy.service';

describe('GET /taxonomy', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_taxonomy');
    // Countries are cached for an hour once read, so the notices go in before the first request.
    await t.db.insert(notice).values(
      ['PK', 'VN', 'PK'].map((originCountry, i) => ({
        source: 'rasff',
        sourceKey: `taxonomy-${i}`,
        destination: 'EU',
        noticeType: 'rasff_alert',
        noticeOn: '2026-10-01',
        originCountry,
      })),
    );
    await t.db.insert(notice).values({
      source: 'rasff',
      sourceKey: 'taxonomy-none',
      destination: 'EU',
      noticeType: 'rasff_alert',
      noticeOn: '2026-10-01',
      originCountry: null,
    });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  it('answers without a session', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/taxonomy').expect(200);
    const body = res.body as TaxonomyResponse;
    expect(body.commodities).toHaveLength(COMMODITIES.length);
    expect(body.hazards).toHaveLength(HAZARDS.length);
    expect(body.commodities.find((c) => c.id === 201)).toEqual({
      id: 201,
      slug: 'chilli-paprika',
      parentId: 200,
      label: CATALOGS.en['taxonomy.commodity.chilli-paprika'],
    });
    expect(body.destinations).toEqual([
      { id: 'US', label: 'United States' },
      { id: 'EU', label: 'European Union' },
      { id: 'UK', label: 'United Kingdom' },
      { id: 'AU', label: 'Australia' },
    ]);
    expect(body.hazardCategories).toHaveLength(12);
    expect(taxonomyQuery.parse({}).locale).toBe('en');
  });

  it('labels in Urdu', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/taxonomy?locale=ur').expect(200);
    const body = res.body as TaxonomyResponse;
    expect(body.commodities.find((c) => c.id === 101)?.label).toBe(CATALOGS.ur['taxonomy.commodity.rice']);
    expect(body.hazards.find((h) => h.id === 300)?.label).toBe(CATALOGS.ur['taxonomy.hazard.aflatoxins']);
    expect(body.destinations[0].label).toBe(CATALOGS.ur['taxonomy.destination.US']);
  });

  it('countries come from the notices', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/taxonomy').expect(200);
    expect((res.body as TaxonomyResponse).countries).toEqual([
      { code: 'PK', label: 'Pakistan' },
      { code: 'VN', label: 'Vietnam' },
    ]);
  });

  it('country names keep Latin digits and come from ICU', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/taxonomy?locale=bn').expect(200);
    const pk = (res.body as TaxonomyResponse).countries.find((c) => c.code === 'PK');
    expect(pk?.label).toBe(new Intl.DisplayNames(['bn'], { type: 'region' }).of('PK'));
  });

  it('rejects an unknown locale', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/taxonomy?locale=fr').expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('knows which commodity and hazard ids exist', async () => {
    const service = t.app.get(TaxonomyService);
    await expect(service.commodityExists(101)).resolves.toBe(true);
    await expect(service.commodityExists(999)).resolves.toBe(false);
    await expect(service.hazardExists(300)).resolves.toBe(true);
    await expect(service.hazardExists(999)).resolves.toBe(false);
  });
});
