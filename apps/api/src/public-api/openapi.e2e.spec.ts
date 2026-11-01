import { NOT_ACCOUNT_OWNED } from '../testing/isolation-registry';
import { startTestApp, type TestApp } from '../testing/test-app';

type Parameter = { name: string; in: string; required: boolean; schema: Record<string, unknown> };
type Document = { openapi: string; paths: Record<string, { get: { parameters: Parameter[] } }> };

describe('public API OpenAPI document', () => {
  let t: TestApp;
  let doc: Document;

  beforeAll(async () => {
    t = await startTestApp('api_openapi');
    // No key and no session: anyone may read it.
    doc = (await t.session().get('/v1/public/openapi.json').expect(200)).body as Document;
  });

  afterAll(async () => {
    await t.close();
  });

  it('describes every public route, and only those', () => {
    const routes = NOT_ACCOUNT_OWNED.filter((r) => r.path.startsWith('/v1/public/') && r.path !== '/v1/public/openapi.json').map((r) =>
      r.path.replace('/v1/public', '').replace(/:(\w+)/g, '{$1}'),
    );
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual(routes.sort());
  });

  it('takes its parameters from the schemas the API validates with', () => {
    const params = (path: string) => Object.fromEntries(doc.paths[path].get.parameters.map((p) => [p.name, p]));
    expect(params('/mrl')).toMatchObject({ commodity: { in: 'query', required: true }, residue: { required: true }, lab: { required: false } });
    expect(params('/notices')['origin']).toMatchObject({ required: false, schema: { pattern: '^[A-Z]{2}$' } });
    expect(params('/notices/{id}')['id']).toMatchObject({ in: 'path', required: true, schema: { type: 'integer' } });
    expect(params('/taxonomy')['locale'].schema).toMatchObject({ enum: ['en', 'ur', 'hi', 'bn'] });
  });
});
