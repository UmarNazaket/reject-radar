import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { type ApiEnv, isPaidSubscriptionStatus, priceCatalog, type PriceCatalog } from '@rejectradar/contracts';
import { type Database, paddleEvent, subscription } from '@rejectradar/db';
import { eq, type SQL, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { AppError } from '../common/errors';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import type { Tx } from '../database/tx';
import { type PaddleEvent, parsePaddleEvent, type PaddleSubscriptionData, type PaddleTransactionData } from './paddle/events';
import { verifyPaddleSignature } from './paddle/signature';

/** What `receive` did: `duplicate` when the event id was already recorded, and the accounts that have just moved into `past_due` (P7-D7). */
export interface WebhookResult {
  duplicate: boolean;
  pastDueOrgIds: string[];
}

/** Postgres reads any hex UUID; anything else in `custom_data.orgId` cannot name an account, and would fail the uuid cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AccountRefs {
  orgId?: string | null;
  subscriptionId?: string | null;
  customerId?: string | null;
}

/**
 * Applies Paddle's notifications to the account's `subscription` row (spec §10.2, P7-D2 to D5). It is the only writer
 * of that row after sign-up. Each event is recorded and applied in one transaction, so a duplicate changes nothing, an
 * error keeps nothing (Paddle retries it), and an event older than the last one applied is recorded but not applied.
 */
@Injectable()
export class PaddleWebhookService {
  private readonly logger = new Logger(PaddleWebhookService.name);
  private readonly catalog: PriceCatalog;
  private readonly secret: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.catalog = priceCatalog(env);
    this.secret = env.PADDLE_WEBHOOK_SECRET;
  }

  /** Verifies, records and applies one notification. Throws `401 INVALID_SIGNATURE` for a bad signature and `400` for a body that is not a Paddle event. */
  async receive(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
    if (!verifyPaddleSignature(rawBody, signature, this.secret)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', 'The Paddle signature does not match the body');
    }
    const { json, event } = this.parse(rawBody);

    return this.db.transaction(async (tx) => {
      // Two deliveries of one event serialise on the primary key: the second waits for the first to commit, then inserts nothing.
      const recorded = await tx
        .insert(paddleEvent)
        .values({ eventId: event.event_id, type: event.event_type, payload: json })
        .onConflictDoNothing({ target: paddleEvent.eventId })
        .returning({ eventId: paddleEvent.eventId });
      if (recorded.length === 0) return { duplicate: true, pastDueOrgIds: [] };

      const pastDueOrgIds = await this.apply(tx, event);
      await tx.update(paddleEvent).set({ processedAt: sql`now()` }).where(eq(paddleEvent.eventId, event.event_id));
      return { duplicate: false, pastDueOrgIds };
    });
  }

  private parse(rawBody: Buffer): { json: unknown; event: PaddleEvent } {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
      return { json, event: parsePaddleEvent(json) };
    } catch (error) {
      // Signed by Paddle but not a shape the API reads: answering 400 leaves it in Paddle's retry queue until the parser is fixed.
      const raw = (json as { event_id?: unknown } | undefined)?.event_id;
      const eventId = typeof raw === 'string' ? raw : null;
      if (error instanceof ZodError) {
        // The paths say which fields to fix; the values could hold an email address, so they are never logged.
        this.logger.error({ eventId, issues: error.issues.map((issue) => issue.path.join('.')) }, 'Paddle event does not fit the expected shape');
      } else {
        this.logger.warn({ eventId }, 'Paddle event body is not JSON');
      }
      throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The body is not a Paddle event the API can read');
    }
  }

  private async apply(tx: Tx, event: PaddleEvent): Promise<string[]> {
    switch (event.kind) {
      case 'subscription':
        return this.applySubscription(tx, event.event_id, event.occurred_at, event.data);
      case 'transaction':
        await this.applyTransaction(tx, event.event_id, event.data);
        return [];
      case 'other':
        this.logger.warn({ eventId: event.event_id }, 'Paddle event type is not handled');
        return [];
    }
  }

  /** Writes Paddle's view of the subscription onto the account's row, unless a later event has been applied already (P7-D3). */
  private async applySubscription(tx: Tx, eventId: string, occurredAt: string, data: PaddleSubscriptionData): Promise<string[]> {
    const account = await this.locate(tx, { orgId: data.custom_data?.orgId, subscriptionId: data.id, customerId: data.customer_id });
    if (!account) {
      this.logger.warn({ eventId }, 'Paddle event matches no account');
      return [];
    }
    const otherSubscription = account.paddleSubscriptionId !== data.id;
    // A paused or canceled subscription can be replaced by a new checkout; a later event about the old one (canceling it in
    // the portal, say) must not overwrite the one that now bills the account. The row is locked, so this read holds.
    if (account.paddleSubscriptionId && otherSubscription && isPaidSubscriptionStatus(account.status)) {
      if (isPaidSubscriptionStatus(data.status)) {
        // The old one is billing again (resumed, say) next to the tracked one: the owner is being charged twice.
        this.logger.warn({ eventId, orgId: account.orgId }, 'The account has two live Paddle subscriptions; the event about the untracked one is recorded, not applied');
      } else {
        this.logger.debug({ eventId }, 'Paddle event is about a subscription the account has replaced; recorded, not applied');
      }
      return [];
    }
    const price = this.catalog.byPrice.get(data.items[0]?.price.id ?? '');
    // P7-D5: an unknown price leaves the plan as it is; the status, period and cancel date still apply.
    if (!price) this.logger.warn({ eventId }, 'Paddle event names an unknown price');

    // Timestamps go to Postgres as Paddle's strings, so the microseconds survive for the order check.
    const at = (value: string | null | undefined): SQL | null => (value ? sql`${value}::timestamptz` : null);
    const cancelAt = data.scheduled_change?.action === 'cancel' ? data.scheduled_change.effective_at : null;
    // The order watermark belongs to the tracked subscription. A different one that now bills replaces it whenever its
    // event is stamped, since Paddle's clocks say nothing about the order of two subscriptions; one that does not bill
    // still has to be newer, so a late event about an old canceled subscription can never relink the row.
    const ordered = otherSubscription && isPaidSubscriptionStatus(data.status) ? sql`true` : sql`${occurredAt}::timestamptz > coalesce(${subscription.paddleOccurredAt}, '-infinity'::timestamptz)`;
    const [updated] = await tx
      .update(subscription)
      .set({
        ...(price ? { plan: price.plan, interval: price.interval } : {}),
        status: data.status,
        paddleSubscriptionId: data.id,
        paddleCustomerId: data.customer_id,
        currentPeriodEnd: at(data.current_billing_period?.ends_at),
        cancelAt: at(cancelAt),
        paddleOccurredAt: at(occurredAt),
        updatedAt: sql`now()`,
      })
      .where(sql`${subscription.orgId} = ${account.orgId} and ${ordered}`)
      .returning({ status: subscription.status });
    if (!updated) {
      this.logger.debug({ eventId }, 'Paddle event is older than the last one applied; recorded, not applied');
      return [];
    }
    return updated.status === 'past_due' && account.status !== 'past_due' ? [account.orgId] : [];
  }

  /** A completed payment names the Paddle customer; an account that does not have one yet gets it. */
  private async applyTransaction(tx: Tx, eventId: string, data: PaddleTransactionData): Promise<void> {
    const account = await this.locate(tx, { orgId: data.custom_data?.orgId, subscriptionId: data.subscription_id, customerId: data.customer_id });
    if (!account) {
      this.logger.warn({ eventId }, 'Paddle event matches no account');
      return;
    }
    if (!data.customer_id) return;
    await tx
      .update(subscription)
      .set({ paddleCustomerId: data.customer_id, updatedAt: sql`now()` })
      .where(sql`${subscription.orgId} = ${account.orgId} and ${subscription.paddleCustomerId} is null`);
  }

  /**
   * The account an event is about (P7-D4): `custom_data.orgId`, else the row with the subscription id, else the one
   * row with the customer id. The row is locked until the transaction ends, so events about one account apply one at a
   * time and the status read here is the one the update replaces.
   */
  private async locate(tx: Tx, refs: AccountRefs): Promise<{ orgId: string; status: string; paddleSubscriptionId: string | null } | undefined> {
    const lookups: SQL[] = [];
    if (refs.orgId && UUID.test(refs.orgId)) lookups.push(eq(subscription.orgId, refs.orgId));
    if (refs.subscriptionId) lookups.push(eq(subscription.paddleSubscriptionId, refs.subscriptionId));
    if (refs.customerId) lookups.push(eq(subscription.paddleCustomerId, refs.customerId));
    for (const where of lookups) {
      // The customer id is not unique; two rows sharing it cannot say which account is meant, so neither is picked.
      const rows = await tx
        .select({ orgId: subscription.orgId, status: subscription.status, paddleSubscriptionId: subscription.paddleSubscriptionId })
        .from(subscription)
        .where(where)
        .limit(2)
        .for('update');
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) return undefined;
    }
    return undefined;
  }
}
