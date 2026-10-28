import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PADDLE_HANDLED_EVENTS, parsePaddleEvent } from './events';

const sample = (): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'subscription-updated.json'), 'utf8'));

describe('parsePaddleEvent', () => {
  it('lists the handled events', () => {
    expect(PADDLE_HANDLED_EVENTS).toEqual(['subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.past_due', 'transaction.completed']);
  });

  it('parses a subscription.updated sample', () => {
    const event = parsePaddleEvent(sample());
    expect(event.kind).toBe('subscription');
    if (event.kind !== 'subscription') throw new Error('unreachable');
    expect(event.event_id).toBe('evt_01hv8x3k4m5n6p7q8r9s0t1v2w');
    expect(event.event_type).toBe('subscription.updated');
    // Kept as the string Paddle sent, microseconds included, so Postgres compares it at full precision.
    expect(event.occurred_at).toBe('2024-04-12T10:18:49.621022Z');
    expect(event.data).toEqual({
      id: 'sub_01hv8x2a9b0c1d2e3f4g5h6j7k',
      status: 'active',
      customer_id: 'ctm_01hv8wt8nffez4p2t6tkg5bp9s',
      items: [{ price: { id: 'pri_01hv0vax6rv18t4tamj848ne4d' } }],
      billing_cycle: { interval: 'month' },
      current_billing_period: { ends_at: '2024-05-12T10:12:23.528379Z' },
      scheduled_change: { action: 'cancel', effective_at: '2024-05-12T10:12:23.528379Z' },
      custom_data: { orgId: '0192e0a4-5b6c-7d8e-9f01-23456789abcd' },
    });
  });

  it('parses a transaction.completed', () => {
    const event = parsePaddleEvent({
      event_id: 'evt_01hv8x3k4m5n6p7q8r9s0t1v2x',
      event_type: 'transaction.completed',
      occurred_at: '2024-04-12T10:12:30.150473Z',
      data: { id: 'txn_01hv8x1p2q3r4s5t6v7w8x9y0z', status: 'completed', customer_id: 'ctm_01hv8wt8nffez4p2t6tkg5bp9s', subscription_id: null, custom_data: null },
    });
    expect(event).toMatchObject({
      kind: 'transaction',
      data: { id: 'txn_01hv8x1p2q3r4s5t6v7w8x9y0z', customer_id: 'ctm_01hv8wt8nffez4p2t6tkg5bp9s', subscription_id: null, custom_data: null },
    });
  });

  it('accepts a subscription without a period, a scheduled change or custom data', () => {
    const json = sample();
    const data = json.data as Record<string, unknown>;
    data.current_billing_period = null;
    data.scheduled_change = null;
    delete data.custom_data;
    const event = parsePaddleEvent({ ...json, event_type: 'subscription.canceled' });
    expect(event).toMatchObject({ kind: 'subscription', data: { current_billing_period: null, scheduled_change: null } });
  });

  it('keeps unknown event types', () => {
    const event = parsePaddleEvent({ event_id: 'evt_1', event_type: 'customer.updated', occurred_at: '2024-04-12T10:18:49.621022Z', data: { anything: [1, 2] } });
    expect(event).toEqual({ kind: 'other', event_id: 'evt_1', event_type: 'customer.updated', occurred_at: '2024-04-12T10:18:49.621022Z', data: { anything: [1, 2] } });
  });

  it('rejects an envelope without event_id', () => {
    const json = sample();
    delete json.event_id;
    expect(() => parsePaddleEvent(json)).toThrow();
  });

  it('rejects a handled event whose data does not fit', () => {
    const json = sample();
    (json.data as Record<string, unknown>).status = 'mystery';
    expect(() => parsePaddleEvent(json)).toThrow();
    expect(() => parsePaddleEvent({ ...sample(), occurred_at: 'yesterday' })).toThrow();
  });
});
