/**
 * A2-1906 — Data Subject Rights (DSR) export.
 *
 * `GET /api/users/me/dsr/export` — returns every database row
 * Loop holds keyed to the calling user. Self-serve compliance with
 * the GDPR "right to data portability" / CCPA equivalent that our
 * privacy policy promises (`/privacy` route, §5).
 *
 * What's included:
 *   - `users` row (id, email, isAdmin, homeCurrency, stellarAddress)
 *   - `user_identities` rows (Google / Apple linkage; ADR 014)
 *   - `user_credits` rows (per-currency balance)
 *   - `credit_transactions` rows (full ledger history)
 *   - `orders` rows (purchase history with the cashback split)
 *   - `pending_payouts` rows (queued + submitted cashback payouts)
 *
 * What's NOT included (must be requested via privacy@loopfinance.io
 * per the privacy policy):
 *   - CTX-side data — gift card codes, redeem URLs, CTX user mapping.
 *     The Loop side stores the CTX user id (mapping included) but the
 *     gift card codes themselves live on CTX's side after fulfillment.
 *   - Backend access logs (Pino → Fly logflow). These are stored
 *     off-host with 14-day retention (`docs/log-policy.md`); a per-
 *     user log dump requires an off-host log query and is a manual
 *     operator process, not a self-serve endpoint.
 *   - Sentry events — same off-host story; 30d retention.
 *   - Discord audit messages — text channel; not extractable per-user.
 *
 * The response is a stable JSON envelope versioned at the top level
 * (`schemaVersion: 1`). Future additions bump the version so tooling
 * downstream can branch on shape.
 *
 * Sensitive material the export DOES surface:
 *   - The user's email (it's their own; trivially knowable to them).
 *   - Stellar address linked for cashback (it's theirs).
 *   - Order memos + ctxOrderId (these are payment-tracking values
 *     specific to that order; they don't reveal anything beyond the
 *     fact that the order exists, which the user already knows).
 *
 * Sensitive material the export deliberately REDACTS:
 *   - `redeem_code` / `redeem_pin` on `orders`. These are the gift
 *     card secret material — exporting them in plaintext would mean
 *     a stolen Loop bearer + this endpoint = full gift-card theft
 *     even if the user has redeemed/burned the card already. The
 *     export shows whether a redeem code was issued (`redeemIssued`
 *     boolean) and where to retrieve it (the existing in-app order
 *     view), not the secret itself.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  creditTransactions,
  orders,
  pendingPayouts,
  userCredits,
  userIdentities,
  users,
} from '../db/schema.js';

export const DSR_EXPORT_SCHEMA_VERSION = 1;

export interface DsrExport {
  schemaVersion: number;
  generatedAt: string;
  user: {
    id: string;
    email: string;
    isAdmin: boolean;
    homeCurrency: string;
    stellarAddress: string | null;
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
  credits: Array<{
    currency: string;
    balanceMinor: string;
    updatedAt: string;
  }>;
  creditTransactions: Array<{
    id: string;
    type: string;
    amountMinor: string;
    currency: string;
    referenceType: string | null;
    referenceId: string | null;
    reason: string | null;
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
    paymentMethod: string;
    paymentMemo: string | null;
    userCashbackMinor: string;
    ctxOrderId: string | null;
    redeemIssued: boolean;
    failureReason: string | null;
    createdAt: string;
    paidAt: string | null;
    fulfilledAt: string | null;
    failedAt: string | null;
  }>;
  pendingPayouts: Array<{
    id: string;
    state: string;
    kind: string;
    orderId: string | null;
    amountStroops: string;
    assetCode: string;
    assetIssuer: string;
    toAddress: string;
    memoText: string;
    txHash: string | null;
    lastError: string | null;
    attempts: number;
    createdAt: string;
    submittedAt: string | null;
    confirmedAt: string | null;
    failedAt: string | null;
  }>;
  notes: {
    excluded: string[];
    fallbackContact: string;
  };
}

export async function buildDsrExport(userId: string): Promise<DsrExport | null> {
  const userRow = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (userRow === undefined) return null;

  const [identitiesRows, creditsRows, txRows, ordersRows, payoutsRows] = await Promise.all([
    db.select().from(userIdentities).where(eq(userIdentities.userId, userId)),
    db.select().from(userCredits).where(eq(userCredits.userId, userId)),
    db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId)),
    db.select().from(orders).where(eq(orders.userId, userId)),
    db.select().from(pendingPayouts).where(eq(pendingPayouts.userId, userId)),
  ]);

  return {
    schemaVersion: DSR_EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    user: {
      id: userRow.id,
      email: userRow.email,
      isAdmin: userRow.isAdmin,
      homeCurrency: userRow.homeCurrency,
      stellarAddress: userRow.stellarAddress,
      createdAt: userRow.createdAt.toISOString(),
      ctxUserId: userRow.ctxUserId,
    },
    identities: identitiesRows.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerSub: r.providerSub,
      emailAtLink: r.emailAtLink,
      createdAt: r.createdAt.toISOString(),
    })),
    credits: creditsRows.map((r) => ({
      currency: r.currency,
      balanceMinor: r.balanceMinor.toString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    creditTransactions: txRows.map((r) => ({
      id: r.id,
      type: r.type,
      amountMinor: r.amountMinor.toString(),
      currency: r.currency,
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
    orders: ordersRows.map((r) => ({
      id: r.id,
      merchantId: r.merchantId,
      state: r.state,
      faceValueMinor: r.faceValueMinor.toString(),
      currency: r.currency,
      chargeMinor: r.chargeMinor.toString(),
      chargeCurrency: r.chargeCurrency,
      paymentMethod: r.paymentMethod,
      paymentMemo: r.paymentMemo,
      userCashbackMinor: r.userCashbackMinor.toString(),
      ctxOrderId: r.ctxOrderId,
      // Bool, not the secret. See module header for rationale.
      redeemIssued: r.redeemCode !== null || r.redeemUrl !== null,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      fulfilledAt: r.fulfilledAt?.toISOString() ?? null,
      failedAt: r.failedAt?.toISOString() ?? null,
    })),
    pendingPayouts: payoutsRows.map((r) => ({
      id: r.id,
      state: r.state,
      kind: r.kind,
      orderId: r.orderId,
      amountStroops: r.amountStroops.toString(),
      assetCode: r.assetCode,
      assetIssuer: r.assetIssuer,
      toAddress: r.toAddress,
      memoText: r.memoText,
      txHash: r.txHash,
      lastError: r.lastError,
      attempts: r.attempts,
      createdAt: r.createdAt.toISOString(),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      failedAt: r.failedAt?.toISOString() ?? null,
    })),
    notes: {
      excluded: [
        'Gift card redeem codes / PINs (in-app order view shows them; not exported as plaintext per A2-1906)',
        'CTX-side gift card metadata (request via privacy@loopfinance.io)',
        'Backend access logs (off-host, 14d retention via Fly logflow; manual operator process)',
        'Sentry events (off-host, 30d retention; manual operator process)',
        'Discord audit messages (per-channel text; not per-user extractable)',
      ],
      fallbackContact: 'privacy@loopfinance.io',
    },
  };
}
