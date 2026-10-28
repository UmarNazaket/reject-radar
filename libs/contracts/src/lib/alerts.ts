import { z } from 'zod';
import { DESTINATIONS, type Destination } from './destinations';
import { type EventKind, type NoticeType, SEVERITIES, type Severity } from './ingestion';
import { positiveInt } from './notices';
import { DIGEST_FREQUENCIES } from './product';

/**
 * `GET /v1/alerts` (spec §7.4, P5-D5). `firm` lists a firm item's alerts; `origin`, with the optional `commodity`
 * (its descendants match too, P5-D6), `destination` and `hazard`, lists a topic's alerts. The web app passes the
 * fields of the watchlist item it shows, so the alerts module never reads the watchlist.
 */
export const alertsQuery = z
  .object({
    severity: z.enum(SEVERITIES).optional(),
    unread: z.literal('true').optional(),
    firm: positiveInt.optional(),
    origin: z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code in capitals').optional(),
    commodity: positiveInt.optional(),
    destination: z.enum(DESTINATIONS).optional(),
    hazard: positiveInt.optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .refine((query) => query.origin !== undefined || (query.commodity === undefined && query.destination === undefined && query.hazard === undefined), {
    message: 'commodity, destination and hazard narrow a topic, which starts with its origin',
    path: ['origin'],
  });
export type AlertsQuery = z.output<typeof alertsQuery>;

export interface AlertItem {
  id: string;
  severity: Severity;
  kind: EventKind;
  /** When the alert was raised (ISO 8601). */
  createdAt: string;
  /** `YYYY-MM-DD`: when the event happened, which can be well before the alert was raised. */
  occurredOn: string;
  /** When the user read it (ISO 8601); null while unread. */
  readAt: string | null;
  firm: { id: number; displayName: string } | null;
  notice: {
    id: number;
    noticeType: NoticeType;
    destination: Destination;
    originCountry: string | null;
    productText: string | null;
    title: string | null;
    url: string | null;
  } | null;
}

export interface AlertsResponse {
  items: AlertItem[];
  /** The cursor of the next page; null on the last. */
  next: string | null;
  /** All of the account's unread alerts, whatever the filters (the number on the bell). */
  unread: number;
}

/** `POST /v1/alerts/read`: some alerts by id, or every unread one of the account. */
export const markReadRequest = z.union([z.object({ ids: z.array(z.uuid()).min(1).max(200) }), z.object({ all: z.literal(true) })]);
export type MarkReadRequest = z.output<typeof markReadRequest>;

export interface MarkReadResponse {
  /** How many alerts this call marked; alerts already read, and ids of other accounts, count for nothing. */
  updated: number;
}

/** `GET/PUT /v1/me/notification-prefs`: per user, not per account (spec §11). */
export const notificationPrefsSchema = z.object({
  instantHigh: z.boolean(),
  digest: z.enum(DIGEST_FREQUENCIES),
});
export type NotificationPrefs = z.output<typeof notificationPrefsSchema>;
