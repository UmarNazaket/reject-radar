import { z } from 'zod';
import { DESTINATIONS } from './destinations';
import type { FirmFlags } from './firms';
import { positiveInt } from './notices';
import type { TopicFields, WatchlistKind } from './product';

/** A record id in a JSON body: a whole number that fits a Postgres `integer`, as `positiveInt` is for a query string. */
const jsonId = z.number().int().min(1).max(2147483647);
const originCountry = z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code in capitals');
const destination = z.enum(DESTINATIONS);

const label = z.string().trim().max(100);
const notes = z.string().trim().max(1000);

/** `POST /v1/watchlist` (spec §7.2, P5-D2): a firm, or a topic whose origin is required and whose other parts mean "any" when left out. */
export const createWatchlistItemRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('firm'),
    firmId: jsonId,
    /** What the user typed when searching, kept to show next to the firm. */
    inputName: z.string().trim().max(200).optional(),
    label: label.optional(),
    notes: notes.optional(),
  }),
  z.object({
    kind: z.literal('topic'),
    originCountry,
    commodityId: jsonId.optional(),
    destination: destination.optional(),
    hazardId: jsonId.optional(),
    label: label.optional(),
    notes: notes.optional(),
  }),
]);
export type CreateWatchlistItemRequest = z.output<typeof createWatchlistItemRequest>;

/** `PATCH /v1/watchlist/:id`: `null` clears a field. */
export const updateWatchlistItemRequest = z
  .object({ label: label.nullable().optional(), notes: notes.nullable().optional() })
  .refine((body) => body.label !== undefined || body.notes !== undefined, { message: 'Send a label or notes to change' });
export type UpdateWatchlistItemRequest = z.output<typeof updateWatchlistItemRequest>;

/** `GET /v1/watchlist/topic-estimate`: the four parts of a topic as query parameters; the answer is how many notices the topic had in 12 months. */
export const topicEstimateQuery = z
  .object({
    originCountry,
    commodityId: positiveInt.optional(),
    destination: destination.optional(),
    hazardId: positiveInt.optional(),
  })
  .transform(
    (query): TopicFields => ({
      originCountry: query.originCountry,
      commodityId: query.commodityId ?? null,
      destination: query.destination ?? null,
      hazardId: query.hazardId ?? null,
    }),
  );
export type TopicEstimateQuery = z.output<typeof topicEstimateQuery>;

export interface TopicEstimateResponse {
  total12m: number;
  /** `total12m / 12`, to one decimal. */
  perMonth: number;
}

export interface WatchlistItem {
  id: string;
  kind: WatchlistKind;
  firm: { id: number; displayName: string; countryCode: string | null; facts: FirmFlags } | null;
  topic: (TopicFields & { notices12m: number }) | null;
  inputName: string | null;
  label: string | null;
  notes: string | null;
  /** `YYYY-MM-DD` of the newest record: the firm's latest notice, or the topic's latest notice. */
  lastRecordOn: string | null;
  unreadAlerts: number;
  createdAt: string;
}

export interface WatchlistResponse {
  items: WatchlistItem[];
  used: number;
  limit: number;
}
