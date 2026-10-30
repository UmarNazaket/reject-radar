import { HttpErrorResponse } from '@angular/common/http';
import type { FirmRecordSource } from '@rejectradar/contracts';
import type { ApiErrorBody } from '../core/api';
import { errorMessage } from '../core/errors';
import type { I18n } from '../core/i18n';

export const RECORD_SOURCE_LABELS: Record<FirmRecordSource, string> = {
  fda_refusal: 'FDA refusal',
  import_alert: 'Import Alert listing',
  au_ifis: 'Australian failed test',
};

const TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

/** A timestamp for the admin screens, which are in English: day, month, year and time, in UTC. */
export const adminTime = (iso: string): string => `${TIME.format(new Date(iso))} UTC`;

/** A refused request's English message from the API, which tells staff why (such as a merge it cannot do). */
export function adminError(i18n: I18n, error: unknown): string {
  const body = error instanceof HttpErrorResponse && error.status >= 400 && error.status < 500 ? (error.error as Partial<ApiErrorBody> | null) : null;
  return body?.message ?? errorMessage(i18n, error);
}
