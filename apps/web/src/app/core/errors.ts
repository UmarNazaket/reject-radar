import { HttpErrorResponse } from '@angular/common/http';
import type { ApiErrorBody } from './api';
import type { I18n } from './i18n';

/** The message for a failed request in the user's language: `errors.<code>`, with the request id when the API failed. */
export function errorMessage(i18n: I18n, error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return i18n.t('errors.INTERNAL');
  if (error.status === 0) return i18n.t('errors.SERVICE_UNAVAILABLE');
  const body = error.error as Partial<ApiErrorBody> | null;
  const message = i18n.t(`errors.${body?.code ?? 'HTTP_ERROR'}`);
  const text = message.startsWith('errors.') ? i18n.t('errors.HTTP_ERROR') : message;
  return error.status >= 500 && body?.requestId ? `${text} (${body.requestId})` : text;
}
