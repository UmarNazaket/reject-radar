import { SUBSCRIPTION_STATUSES } from '@rejectradar/contracts';
import { z } from 'zod';

/** The Paddle notifications the API acts on (spec §10.2); any other type is recorded and left alone. */
export const PADDLE_HANDLED_EVENTS = ['subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.past_due', 'transaction.completed'] as const;
export type PaddleHandledEvent = (typeof PADDLE_HANDLED_EVENTS)[number];

const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set<PaddleHandledEvent>(['subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.past_due']);

/** Paddle's timestamps (`2024-04-12T10:18:49.621022Z`). Kept as strings so Postgres reads the microseconds a JS `Date` would drop. */
const timestamp = z.iso.datetime({ offset: true });

/** `custom_data` is whatever checkout passed; only `orgId` is read, and anything else in it is ignored. */
const customData = z.object({ orgId: z.string().optional() }).nullish();

const envelope = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: timestamp,
  data: z.unknown(),
});

const subscriptionData = z.object({
  id: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  customer_id: z.string().min(1),
  items: z.array(z.object({ price: z.object({ id: z.string().min(1) }) })),
  billing_cycle: z.object({ interval: z.string() }),
  current_billing_period: z.object({ ends_at: timestamp }).nullish(),
  scheduled_change: z.object({ action: z.string(), effective_at: timestamp }).nullish(),
  custom_data: customData,
});

const transactionData = z.object({
  id: z.string().min(1),
  customer_id: z.string().min(1).nullish(),
  subscription_id: z.string().min(1).nullish(),
  custom_data: customData,
});

export type PaddleSubscriptionData = z.infer<typeof subscriptionData>;
export type PaddleTransactionData = z.infer<typeof transactionData>;

interface Envelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
}

/** A verified Paddle notification. `kind` says which `data` shape was parsed; `other` keeps the data unread. */
export type PaddleEvent =
  | (Envelope & { kind: 'subscription'; data: PaddleSubscriptionData })
  | (Envelope & { kind: 'transaction'; data: PaddleTransactionData })
  | (Envelope & { kind: 'other'; data: unknown });

/**
 * Parses a Paddle notification body: the envelope always, and `data` for the handled event types. Unknown fields are
 * dropped and unknown event types keep their `data` as it came. Throws a `ZodError` when the body does not fit.
 */
export function parsePaddleEvent(json: unknown): PaddleEvent {
  const { event_id, event_type, occurred_at, data } = envelope.parse(json);
  const head = { event_id, event_type, occurred_at };
  if (SUBSCRIPTION_EVENTS.has(event_type)) return { kind: 'subscription', ...head, data: subscriptionData.parse(data) };
  if (event_type === 'transaction.completed') return { kind: 'transaction', ...head, data: transactionData.parse(data) };
  return { kind: 'other', ...head, data };
}
