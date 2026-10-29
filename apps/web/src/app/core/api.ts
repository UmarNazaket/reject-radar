/** Set at build time (`define` in project.json): the API's origin, or '' to call the same origin (the dev proxy). */
declare const API_ORIGIN: string;

/** The full URL of an API path such as `/v1/me`. */
export const apiUrl = (path: string): string => `${API_ORIGIN}${path}`;

/** True for a request to the RejectRadar API. */
export const isApiUrl = (url: string): boolean => url.startsWith(`${API_ORIGIN}/v1/`);

/** The JSON body of an API error (`code` is stable; `message` is English). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}
