import { userAgent } from './fetch-file';

export const FDA_REFUSALS_URL = 'https://api-datadashboard.fda.gov/v1/import_refusals';
export const FDA_MAX_ROWS = 5000;

export interface FdaCredentials {
  user: string;
  key: string;
}

export interface FdaPageRequest {
  /** YYYY-MM-DD */
  from: string;
  /** YYYY-MM-DD */
  to: string;
  /** 1-based first row. */
  start?: number;
  rows?: number;
  countTotal?: boolean;
}

export interface FdaPage {
  records: Record<string, unknown>[];
  total: number | null;
}

export interface FdaResponse {
  statuscode?: number;
  message?: string;
  resultcount?: number;
  totalrecordcount?: number;
  result?: unknown;
  [key: string]: unknown;
}

/** Required keys are always sent; optional keys only when used (https://datadashboard.fda.gov/oii/api/index.htm). */
export function buildRefusalsBody(req: FdaPageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    columns: [],
    filters: { RefusalDateFrom: [req.from], RefusalDateTo: [req.to] },
    sort: '',
    sortorder: 'asc',
    rows: Math.min(req.rows ?? FDA_MAX_ROWS, FDA_MAX_ROWS),
    start: req.start ?? 1,
  };
  if (req.countTotal) body['returntotalcount'] = true;
  return body;
}

/** The Data Dashboard reports success as statuscode 400 with "Success." and "no results" as 412. */
export function interpretFdaResponse(body: FdaResponse): FdaPage {
  if (body.statuscode === 412) return { records: [], total: 0 };
  if (body.statuscode === 400 && /^success/i.test(body.message ?? '')) {
    return {
      records: Array.isArray(body.result) ? (body.result as Record<string, unknown>[]) : [],
      total: typeof body.totalrecordcount === 'number' ? body.totalrecordcount : null,
    };
  }
  const details = Object.keys(body)
    .filter((key) => key.startsWith('invalid'))
    .map((key) => `${key}: ${JSON.stringify(body[key])}`)
    .join('; ');
  throw new Error(`FDA API error ${body.statuscode ?? 'unknown'}: ${body.message ?? 'no message'}${details ? ` (${details})` : ''}`);
}

export async function fetchRefusalsPage(
  creds: FdaCredentials,
  req: FdaPageRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<FdaPage> {
  const response = await fetchImpl(FDA_REFUSALS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization-User': creds.user,
      'Authorization-Key': creds.key,
      'User-Agent': userAgent(),
    },
    body: JSON.stringify(buildRefusalsBody(req)),
  });
  const text = await response.text();
  let body: FdaResponse;
  try {
    body = JSON.parse(text) as FdaResponse;
  } catch {
    throw new Error(`FDA API returned HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`);
  }
  return interpretFdaResponse(body);
}
