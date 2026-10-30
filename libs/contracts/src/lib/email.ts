/** Every email the product sends (spec §11); the database restricts `email_delivery.kind` to these. */
export const EMAIL_KINDS = ['verify', 'reset', 'invite', 'account_exists', 'instant_alert', 'digest', 'payment_failed', 'dispute_answered'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** `email_delivery.status`: `sending` is written before the transport is called, `paused` when the daily cap stopped the send. */
export const EMAIL_DELIVERY_STATUSES = ['sending', 'sent', 'failed', 'paused'] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

/**
 * Daily (UTC) limits on emails in status `sending` or `sent`, under the provider's 100-a-day free tier (spec §11).
 * The lower tiers leave room for account emails: instant alerts stop at 70, digests at 90, account emails at 100.
 */
export const EMAIL_CAP_TIERS = { instant: 70, digest: 90, account: 100 } as const;
export type EmailCapTier = keyof typeof EMAIL_CAP_TIERS;

export function capTierFor(kind: EmailKind): EmailCapTier {
  if (kind === 'instant_alert') return 'instant';
  if (kind === 'digest') return 'digest';
  return 'account';
}
