import { type DashboardResponse, DESTINATIONS, type Destination } from '@rejectradar/contracts';
import { lookupLog, notice } from '@rejectradar/db';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { daysAgo, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';
import { PDF_COPY } from './pdf-copy';
import { cellText, pageCount, tableBodies, textOf } from './pdf-test-utils';
import { TopicReportService } from './topic-report.service';

/** supertest keeps a body it has no parser for as text; a PDF is read as raw bytes instead. */
const binary = (res: import('supertest').Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('topic report PDF', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_topic_report');
    await seedReferenceData(t.db);
    // A busy origin the base fixture never uses: 12 hazards, every destination, notices across 3 years.
    const destinations = ['US', 'EU', 'UK', 'AU'] as const;
    const source = {
      US: 'fda_refusal',
      EU: 'rasff',
      UK: 'uk_bn',
      AU: 'au_ifis',
    } as const;
    const type = {
      US: 'refusal',
      EU: 'rasff_alert',
      UK: 'uk_border_notification',
      AU: 'au_failed_test',
    } as const;
    await t.db.insert(notice).values(
      Array.from({ length: 60 }, (_, i) => {
        const destination = destinations[i % 4];
        return {
          source: source[destination],
          sourceKey: `topic-report-busy-${i}`,
          destination,
          noticeType: type[destination],
          noticeOn: daysAgo(3 + i * 17),
          originCountry: 'BD',
          commodityId: 101,
          hazardIds: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200].slice(i % 12, (i % 12) + 2),
          productText: `Busy origin product ${i}`,
          firmName: `Busy Exporter ${i} Ltd`,
        };
      }),
    );
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  async function account(plan: 'free' | 'pro' = 'pro', company = `Topic Company ${n + 1}`) {
    n += 1;
    const who = await signUpVerified(t, {
      email: `user${n}@topic-report.test`,
      company,
    });
    if (plan !== 'free') await setPlan(t, who.orgId, plan);
    return { ...who, company };
  }

  const lookups = async (orgId: string) => (await t.app.get(EntitlementsService).usage(orgId)).lookups;
  const getPdf = (session: TestSession, query: string) => session.get(`/v1/dashboards/topic/report.pdf${query}`).buffer(true).parse(binary);

  it('answers a Pro account with the PDF as an attachment, named after the topic, and charges no lookup', async () => {
    const { session, orgId } = await account();
    const res = await getPdf(session, '?origin=PK&commodity=101&destination=US').expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="rejectradar-topic-pk-101-us.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
    expect(await lookups(orgId)).toBe(0);
    expect(await t.db.select().from(lookupLog)).toEqual([]);
  });

  it('names the file after the origin alone with "all" for the missing commodity and destinations', async () => {
    const { session } = await account();
    const res = await getPdf(session, '?origin=PK').expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="rejectradar-topic-pk-all-all.pdf"');
  });

  it('joins several destinations with a plus, in the order of the query', async () => {
    const { session } = await account();
    const res = await getPdf(session, '?origin=PK&commodity=100&destination=US,EU').expect(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="rejectradar-topic-pk-100-us+eu.pdf"');
  });

  it('refuses a Free account with PLAN_UPGRADE_REQUIRED, as JSON', async () => {
    const { session } = await account('free');
    const res = await session.get('/v1/dashboards/topic/report.pdf?origin=PK').expect(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      code: 'PLAN_UPGRADE_REQUIRED',
      details: { feature: 'pdf', plan: 'free' },
    });
  });

  it.each([
    '',
    '?origin=pk',
    '?origin=PAK',
    '?origin=PK&destination=XX',
    '?origin=PK&commodity=0',
    '?origin=PK&commodity=2147483648',
    '?commodity=100',
  ])('rejects %s with the same 400 as the dashboard', async (query) => {
    const { session } = await account();
    const report = await session.get(`/v1/dashboards/topic/report.pdf${query}`).expect(400);
    const dashboard = await session.get(`/v1/dashboards/topic${query}`).expect(400);
    expect(report.body).toMatchObject({ code: 'BAD_REQUEST' });
    expect({ ...report.body, requestId: undefined }).toEqual({ ...dashboard.body, requestId: undefined });
  });

  it('refuses a caller without a session', async () => {
    await t.session().get('/v1/dashboards/topic/report.pdf?origin=PK').expect(401);
  });

  it('keeps the dashboard and its report on their own routes', async () => {
    const { session } = await account();
    const dashboard = await session.get('/v1/dashboards/topic?origin=PK').expect(200);
    expect(dashboard.headers['content-type']).toMatch(/application\/json/);
    expect(dashboard.body).toHaveProperty('months');
    const report = await getPdf(session, '?origin=PK').expect(200);
    expect(report.headers['content-type']).toBe('application/pdf');
  });

  it("prints the dashboard's own monthly counts, top hazards and latest notices, with the disclaimer and the data dates", async () => {
    const { session, orgId, company } = await account();
    const other = await account('pro', 'Some Other Company');
    for (const query of ['?origin=BD', '?origin=BD&commodity=101&destination=US,EU', '?origin=PK&destination=AU']) {
      const dash = (await session.get(`/v1/dashboards/topic${query}`).expect(200)).body as DashboardResponse;
      const params = new URLSearchParams(query.slice(1));
      const destination = params.get('destination')?.split(',');
      const { doc } = await t.app.get(TopicReportService).document(
        { orgId },
        {
          origin: params.get('origin') as string,
          ...(params.get('commodity') ? { commodity: Number(params.get('commodity')) } : {}),
          ...(destination ? { destination: destination as (typeof DESTINATIONS)[number][] } : {}),
        },
      );
      const columns = DESTINATIONS.filter((d) => (destination ?? DESTINATIONS).includes(d));
      const counts = (c: Record<Destination, number>, total: number) => [
        ...columns.map((d) => String(c[d])),
        ...(columns.length > 1 ? [String(total)] : []),
      ];
      const sum = (c: Record<Destination, number>) => columns.reduce((acc, d) => acc + c[d], 0);
      const bodies = tableBodies(doc.content);
      const monthRows = bodies
        .filter((body) => body[0] && cellText(body[0][0]) === PDF_COPY.month)
        .flatMap((body) => body.slice(1).map((row) => row.map(cellText)));
      expect(monthRows).toEqual(dash.months.map((m) => [m.month, ...counts(m, sum(m))]));

      const hazardRows =
        bodies
          .find((body) => body[0] && cellText(body[0][0]) === PDF_COPY.hazard)
          ?.slice(1)
          .map((r) => r.map(cellText)) ?? [];
      expect(hazardRows.map((r) => r.slice(1))).toEqual(dash.findings.map((f) => counts(f.byDestination, f.count)));
      expect(hazardRows).toHaveLength(dash.findings.length);

      const text = textOf(doc).join('\n');
      for (const item of dash.latest.slice(0, 10)) {
        expect(text).toContain(item.noticeOn);
        expect(text).toContain((item.productText ?? '').slice(0, 30));
      }
      for (const item of dash.latest.slice(10)) expect(text).not.toContain(item.productText ?? '\u0000');
      expect(text).toContain(PDF_COPY.disclaimer);
      expect(text).toContain(company);
      expect(text).not.toContain(other.company);
      const sourceOf = { US: 'fda_refusals', EU: 'rasff', UK: 'uk_bn', AU: 'au_ifis' } as const;
      for (const f of dash.freshness.filter((x) => columns.some((d) => sourceOf[d] === x.source) && x.latestMonth === null)) {
        expect(text).toContain(f.lastSuccessAt?.slice(0, 10) ?? PDF_COPY.notSynced);
      }
    }
  });

  it('names hazards and the commodity in English, from the taxonomy', async () => {
    const { orgId } = await account();
    const labels = await t.app.get(TaxonomyService).labels('en');
    const { doc } = await t.app.get(TopicReportService).document({ orgId }, { origin: 'BD', commodity: 101 });
    const text = textOf(doc).join('\n');
    expect(text).toContain(labels.commodities.find((c) => c.id === 101)?.label);
    expect(text).toContain(labels.hazards.find((h) => h.id === 100)?.label);
    expect(text).not.toContain(PDF_COPY.hazardNumber(100));
  });

  it('puts a busy topic, 36 months with every destination, on one page', async () => {
    const { session } = await account();
    const res = await getPdf(session, '?origin=BD').expect(200);
    expect(pageCount(res.body as Buffer)).toBe(1);
  });

  it('does not touch the lookup count however many reports are made', async () => {
    const { session, orgId } = await account();
    await getPdf(session, '?origin=PK').expect(200);
    await getPdf(session, '?origin=BD').expect(200);
    expect(await lookups(orgId)).toBe(0);
  });
});
