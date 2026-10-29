import { randomBytes } from 'node:crypto';
import type { ApiEnv } from '@rejectradar/contracts';
import request from 'supertest';
import type { PaddleGateway } from '../billing/paddle/gateway';
import { signPaddlePayload } from '../billing/paddle/signature';
import { API_ENV } from '../config/env';
import type { TestApp } from './test-app';

/** A gateway that never calls Paddle: it records the portal sessions asked for and returns a fixed URL. */
export class FakePaddleGateway implements PaddleGateway {
  readonly portalCalls: { customerId: string; subscriptionIds: string[] }[] = [];

  createPortalSession(customerId: string, subscriptionIds: string[]): Promise<string> {
    this.portalCalls.push({ customerId, subscriptionIds });
    return Promise.resolve(`https://sandbox-customer-portal.paddle.com/fake/${customerId}`);
  }
}

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz0123456789';

/** A fresh Paddle-style id such as `sub_01…` (26 lowercase characters after the prefix). */
export function paddleId(prefix: 'evt' | 'ntf' | 'sub' | 'ctm' | 'txn' | 'pri'): string {
  const tail = [...randomBytes(24)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
  return `${prefix}_01${tail}`;
}

export interface PaddleEventEnvelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: unknown;
}

/** A Paddle notification envelope around `data`, with a fresh event id and `occurred_at` of now unless `overrides` says otherwise. */
export function paddleEvent(type: string, data: unknown, overrides: Partial<Omit<PaddleEventEnvelope, 'event_type' | 'data'>> = {}): PaddleEventEnvelope {
  return { event_id: paddleId('evt'), event_type: type, occurred_at: new Date().toISOString(), notification_id: paddleId('ntf'), data, ...overrides };
}

export interface PaddleSubscriptionFields {
  priceId: string;
  id?: string;
  status?: string;
  customerId?: string;
  /** `custom_data.orgId`; null or left out sends `custom_data: null`. */
  orgId?: string | null;
  /** `current_billing_period.ends_at`; null sends no period (a canceled subscription). */
  periodEndsAt?: string | null;
  scheduledChange?: { action: 'cancel' | 'pause' | 'resume'; effective_at: string } | null;
}

/** A Paddle subscription entity, shaped like the one in `subscription.*` notifications, with the fields the API reads. */
export function paddleSubscription(fields: PaddleSubscriptionFields): Record<string, unknown> {
  const periodEndsAt = fields.periodEndsAt === undefined ? '2030-02-15T10:00:00.123456Z' : fields.periodEndsAt;
  return {
    id: fields.id ?? paddleId('sub'),
    status: fields.status ?? 'active',
    customer_id: fields.customerId ?? paddleId('ctm'),
    currency_code: 'USD',
    collection_mode: 'automatic',
    billing_cycle: { frequency: 1, interval: 'month' },
    current_billing_period: periodEndsAt === null ? null : { starts_at: '2030-01-15T10:00:00.123456Z', ends_at: periodEndsAt },
    scheduled_change: fields.scheduledChange ?? null,
    items: [{ status: 'active', quantity: 1, recurring: true, price: { id: fields.priceId, type: 'standard', status: 'active' } }],
    custom_data: fields.orgId ? { orgId: fields.orgId } : null,
  };
}

/**
 * Posts `event` to the webhook as Paddle would: the JSON body, no cookies, no CSRF header, and a `Paddle-Signature`
 * made with the app's webhook secret at the current time. `secret` and `ts` (unix seconds) sign it differently.
 */
export function postWebhook(t: TestApp, event: unknown, { secret, ts }: { secret?: string; ts?: number } = {}): request.Test {
  const raw = JSON.stringify(event);
  const header = signPaddlePayload(Buffer.from(raw), secret ?? t.app.get<ApiEnv>(API_ENV).PADDLE_WEBHOOK_SECRET, ts ?? Math.floor(Date.now() / 1000));
  return request(t.app.getHttpServer()).post('/v1/webhooks/paddle').set('Content-Type', 'application/json').set('Paddle-Signature', header).send(raw);
}
