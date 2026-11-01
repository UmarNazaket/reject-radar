import {
  dashboardQuery,
  firmSearchQuery,
  importAlertNumberSchema,
  importAlertQuery,
  mrlQuery,
  noticeSearchQuery,
  residueSearchQuery,
  taxonomyQuery,
} from '@rejectradar/contracts';
import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

interface PublicRoute {
  path: string;
  summary: string;
  query?: z.ZodObject;
  pathParams?: Record<string, JsonSchema>;
}

const ID = { type: 'integer', minimum: 1 };

/** Every route under `/v1/public`, in the README's order; openapi.e2e.spec.ts fails when one is missing. */
const ROUTES: PublicRoute[] = [
  { path: '/notices', summary: "Search notices, newest first, within the account's history window. `next` in the answer is the cursor of the next page.", query: noticeSearchQuery },
  { path: '/notices/{id}', summary: 'One notice.', pathParams: { id: ID } },
  { path: '/dashboards/topic', summary: 'Monthly counts, top hazards and the latest notices for an origin, commodity and destinations.', query: dashboardQuery },
  { path: '/firms/search', summary: 'Find firms by name or FDA FEI number, best match first.', query: firmSearchQuery },
  { path: '/firms/{id}', summary: "A firm's profile with its records. Uses one firm lookup of the plan, as in the app.", pathParams: { id: ID } },
  {
    path: '/import-alerts/{number}',
    summary: "An FDA Import Alert's text and its approved summary.",
    query: importAlertQuery,
    pathParams: { number: inputSchema(importAlertNumberSchema) },
  },
  { path: '/mrl', summary: 'The EU maximum residue level of a residue in a commodity, optionally compared with a lab value in mg/kg.', query: mrlQuery },
  { path: '/mrl/residues', summary: 'Find pesticide residues by name, for the residue id `/mrl` takes.', query: residueSearchQuery },
  { path: '/taxonomy', summary: 'The commodities, hazards, destinations and countries the other routes take, with their labels.', query: taxonomyQuery },
  { path: '/usage', summary: "This month's API calls and the plan's limit. Not charged." },
];

/** The schema of what a client sends: transforms (numbers, comma lists) are described by their string input. */
function inputSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;
  delete json['$schema'];
  return json;
}

function parameters(route: PublicRoute): JsonSchema[] {
  const fromPath = Object.entries(route.pathParams ?? {}).map(([name, schema]) => ({ name, in: 'path', required: true, schema }));
  if (!route.query) return fromPath;
  const { properties = {}, required = [] } = inputSchema(route.query) as { properties?: Record<string, JsonSchema>; required?: string[] };
  return [...fromPath, ...Object.entries(properties).map(([name, schema]) => ({ name, in: 'query', required: required.includes(name), schema }))];
}

const QUOTA_HEADERS = {
  'X-Quota-Used': { description: "This month's API calls, this one included.", schema: { type: 'integer' } },
  'X-Quota-Limit': { description: "The plan's monthly API calls.", schema: { type: 'integer' } },
};

const ERROR = { description: 'An error; `code` says which. See https://rejectradar.umarnazaket.com/developers.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

/** The public API as OpenAPI 3.1. Parameters come from the zod schemas the API validates with; answers are described in words. */
export function buildOpenApi(): JsonSchema {
  return {
    openapi: '3.1.0',
    info: {
      title: 'RejectRadar public API',
      version: '1',
      description:
        'Read-only access for Business and Enterprise accounts. Every route answers with the same JSON as the web app; the reference with examples is at https://rejectradar.umarnazaket.com/developers.',
    },
    servers: [{ url: '/v1/public' }],
    security: [{ apiKey: [] }],
    paths: Object.fromEntries(
      ROUTES.map((route) => [
        route.path,
        {
          get: {
            summary: route.summary,
            parameters: parameters(route),
            responses: {
              '200': { description: 'The same JSON as the web app’s route of the same name.', headers: route.path === '/usage' ? undefined : QUOTA_HEADERS },
              '400': ERROR,
              '401': ERROR,
              '403': ERROR,
              '404': ERROR,
              '429': { ...ERROR, headers: { 'Retry-After': { description: 'Seconds to wait.', schema: { type: 'integer' } } } },
            },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key, `rr_live_…`, from Settings, API keys.' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message', 'requestId'],
          properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } },
        },
      },
    },
  };
}
