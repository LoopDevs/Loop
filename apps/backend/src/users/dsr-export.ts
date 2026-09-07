/**
 * A2-1906 — Data Subject Rights (DSR) export.
 *
 * `GET /api/users/me/dsr/export` — returns every stored record Loop
 * holds keyed to the calling user. Self-serve compliance with the
 * GDPR "right to data portability" / CCPA equivalent.
 *
 * What's included:
 *   - `users` doc (id, email, homeCurrency, ctxUserId)
 *   - `user_identities` docs (Google / Apple linkage; ADR 014)
 *   - `orders` docs (purchase history with the per-order economics)
 *
 * What's NOT included (must be requested via privacy@loopfinance.io):
 *   - CTX-side data — gift card codes live on CTX's side after
 *     fulfillment; Loop stores only the mapping (included).
 *   - Backend access logs / Sentry events (off-host, short retention).
 *
 * Sensitive material the export deliberately REDACTS:
 *   - `redeemCode` / `redeemPin` on orders. These are the gift card
 *     secret material — exporting them in plaintext would mean a
 *     stolen Loop bearer + this endpoint = full gift-card theft. The
 *     export shows whether a redeem code was issued (`redeemIssued`)
 *     and points at the in-app order view instead.
 */
import { db } from '../db/client.js';

export const DSR_EXPORT_SCHEMA_VERSION = 2;

export interface DsrExport {
  schemaVersion: number;
  generatedAt: string;
  user: {
    id: string;
    email: string;
    homeCurrency: string;
    createdAt: string;
    ctxUserId: string | null;
  };
  identities: Array<{
    id: string;
    provider: string;
    providerSub: string;
    emailAtLink: string;
    createdAt: string;
  }>;
  orders: Array<{
    id: string;
    merchantId: string;
    state: string;
    faceValueMinor: string;
    currency: string;
    chargeMinor: string;
    chargeCurrency: string;
    paymentCryptoCurrency: string | null;
    userCashbackMinor: string;
    ctxOrderId: string | null;
    redeemIssued: boolean;
    failureReason: string | null;
    createdAt: string;
    fulfilledAt: string | null;
    failedAt: string | null;
  }>;
  notes: {
    excluded: string[];
    fallbackContact: string;
  };
}

export async function buildDsrExport(userId: string): Promise<DsrExport | null> {
  const userDoc = await db.collection('users').findOne({ id: userId });
  if (userDoc === null) return null;

  const [identities, orders] = await Promise.all([
    db.collection('user_identities').findMany({ userId }),
    db.collection('orders').findMany({ userId }),
  ]);

  return {
    schemaVersion: DSR_EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    user: {
      id: userDoc.id,
      email: userDoc.email,
      homeCurrency: userDoc.homeCurrency,
      createdAt: userDoc.createdAt.toISOString(),
      ctxUserId: userDoc.ctxUserId,
    },
    identities: identities.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerSub: r.providerSub,
      emailAtLink: r.emailAtLink,
      createdAt: r.createdAt.toISOString(),
    })),
    orders: orders.map((r) => ({
      id: r.id,
      merchantId: r.merchantId,
      state: r.state,
      faceValueMinor: r.faceValueMinor.toString(),
      currency: r.currency,
      chargeMinor: r.chargeMinor.toString(),
      chargeCurrency: r.chargeCurrency,
      paymentCryptoCurrency: r.paymentCryptoCurrency,
      userCashbackMinor: r.userCashbackMinor.toString(),
      ctxOrderId: r.ctxOrderId,
      // Bool, not the secret. See module header for rationale.
      redeemIssued: r.redeemCode !== null || r.redeemUrl !== null,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
      fulfilledAt: r.fulfilledAt?.toISOString() ?? null,
      failedAt: r.failedAt?.toISOString() ?? null,
    })),
    notes: {
      excluded: [
        'CTX-side gift card data (request via privacy@loopfinance.io)',
        'Backend access logs (14-day retention, off-host)',
        'Sentry error events (30-day retention, off-host)',
      ],
      fallbackContact: 'privacy@loopfinance.io',
    },
  };
}
