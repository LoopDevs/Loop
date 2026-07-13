/**
 * Admin emission endpoint (ADR-024 / A2-901, re-scoped by ADR 036).
 *
 * `POST /api/admin/users/:userId/emissions` — queues an on-chain
 * LOOP-asset payment to the user WITHOUT debiting the off-chain
 * `user_credits` mirror (ADR 036: emission materialises the on-chain
 * half of a liability that already exists — e.g. backfilling a
 * missed/failed cashback payout). Admin-mediated only; the user-facing
 * way value leaves the system is redemption (gift-card loop_asset
 * payment today, fiat-out later).
 *
 * Two-layer idempotency mirrors the credit-adjustment / refund
 * handlers:
 *
 *   - Admin idempotency key (ADR 017) — advisory-lock-serialised
 *     actor+key snapshot replay, covers double-clicks and retried
 *     POSTs with the same key.
 *   - DB semantic uniqueness fence on active emission intents
 *     (`pending_payouts_active_emission_unique`) — catches the
 *     "fresh key, same user/asset/address/amount" race. Surfaces as
 *     409 EMISSION_ALREADY_ISSUED.
 *
 * The operator `reason` has no ledger row to live on (no credit-tx is
 * written) — it persists in the ADR-017 idempotency snapshot and the
 * Discord admin-audit fanout.
 *
 * Response envelope matches the refund handler's shape so the admin
 * UI can share the post-action renderer.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';
import { getUserById, type User } from '../db/users.js';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { generatePayoutMemo } from '../credits/payout-builder.js';
import {
  applyAdminEmission,
  EmissionAlreadyIssuedError,
  EmissionExceedsUnemittedBalanceError,
} from '../credits/emissions.js';
import { InsufficientBalanceError, DailyAdjustmentLimitError } from '../credits/adjustments.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-emission' });

/**
 * Body schema. `amountMinor` is unsigned integer-as-string; same
 * 10,000,000 cap as refund/adjustment. `destinationAddress` is the
 * user's Stellar wallet.
 *
 * MNY-10: the well-formed address the admin supplies is NOT trusted as
 * a free destination — the handler pins the emission to the TARGET
 * user's registered wallet and rejects (`DESTINATION_NOT_REGISTERED`)
 * any address that does not match it. The field survives as an
 * explicit operator confirmation/checksum: a typo'd or malicious value
 * can no longer redirect an on-chain LOOP payment to an account the
 * user does not control. See the resolution + guards in the handler.
 */
const BodySchema = z.object({
  amountMinor: z
    .string()
    .regex(/^\d+$/, 'amountMinor must be a positive integer string')
    .refine((s) => {
      try {
        const n = BigInt(s);
        return n > 0n && n <= 10_000_000n;
      } catch {
        return false;
      }
    }, 'amountMinor must be positive and within 10_000_000 minor units'),
  currency: z.enum(HOME_CURRENCIES),
  destinationAddress: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, 'destinationAddress must be a Stellar public key (G...)'),
  reason: z.string().min(2).max(500),
});

export interface EmissionResponse {
  payoutId: string;
  userId: string;
  currency: string;
  amountMinor: string;
  destinationAddress: string;
  /** Mirror balance at queue time — unchanged by the emission (ADR 036). */
  balanceMinor: string;
  createdAt: string;
}

export async function adminEmissionHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }

  const idempotencyKey = c.req.header('idempotency-key');
  if (!validateIdempotencyKey(idempotencyKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
      },
      400,
    );
  }

  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      },
      400,
    );
  }

  // Target user must exist before we queue an on-chain payment in
  // their name — fail fast with 404 rather than letting
  // `applyAdminEmission` write a payout row referencing a missing
  // user_id.
  const targetUser = await getUserById(userId);
  if (targetUser === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Target user not found' }, 404);
  }

  // MNY-10: pin the emission destination to the TARGET user's
  // registered wallet. The supplied `destinationAddress` must never be
  // trusted as a free destination — a typo'd or malicious value would
  // queue an on-chain LOOP payment to an account the user does not
  // control (the emission is Admin-mediated and irreversible once the
  // submit worker signs it). Resolve the canonical destination the
  // SAME way every other payout path does — the order-cashback builder
  // (orders/fulfillment.ts → credits/payout-builder.ts) and the
  // interest-mint sweep (credits/interest-mint.ts): an ACTIVATED
  // embedded wallet wins over the legacy linked `stellarAddress`; a
  // wallet that exists but is not `activated` has no LOOP trustlines
  // and must not be targeted, so it does NOT contribute a destination.
  const registeredWallet: string | null =
    (targetUser.walletProvisioning === 'activated' ? targetUser.walletAddress : null) ??
    targetUser.stellarAddress;
  if (registeredWallet === null) {
    // No activated embedded wallet and no linked legacy address — there
    // is no registered wallet to pin to. Reject rather than trust the
    // free input (the safe default): an emission to an unregistered
    // destination is exactly the hole MNY-10 closes.
    return c.json(
      {
        code: 'NO_REGISTERED_WALLET',
        message:
          'Target user has no registered wallet (activated embedded wallet or linked Stellar address) — cannot pin an emission destination',
      },
      400,
    );
  }
  if (parsed.data.destinationAddress !== registeredWallet) {
    return c.json(
      {
        code: 'DESTINATION_NOT_REGISTERED',
        message:
          "destinationAddress does not match the target user's registered wallet — emissions are pinned to the user's registered wallet",
      },
      400,
    );
  }

  // Resolve LOOP asset for the requested currency — same
  // payoutAssetFor mapping as order-cashback (USD→USDLOOP,
  // GBP→GBPLOOP, EUR→EURLOOP). Issuer absent in env → return 503
  // NOT_CONFIGURED so ops sees the misconfiguration loud.
  const asset = payoutAssetFor(parsed.data.currency as HomeCurrency);
  const assetIssuer = asset.issuer;
  if (assetIssuer === null) {
    return c.json(
      {
        code: 'NOT_CONFIGURED',
        message: `Issuer for ${asset.code} not configured in env`,
      },
      503,
    );
  }

  // Convert the minor-unit amount into Stellar stroops.
  // 1 minor unit = 100,000 stroops (1:1 peg, 7 decimals — same as
  // payout-builder.ts for order-cashback rows).
  //
  // A4-029: lock the 100_000 ratio to the LOOP-asset code set. A
  // future asset code with a different decimal layout (USDC variant,
  // non-7-decimal LOOP) would silently send 100x off without this
  // guard. The emission path resolves `asset` via
  // `payoutAssetFor(parsed.data.currency)` above.
  if (asset.code !== 'USDLOOP' && asset.code !== 'GBPLOOP' && asset.code !== 'EURLOOP') {
    return c.json(
      {
        code: 'INTERNAL_ERROR',
        message: `Unsupported emission asset code '${asset.code}' — stroops/minor ratio assumes LOOP-asset 7-decimal layout`,
      },
      500,
    );
  }
  const amountMinor = BigInt(parsed.data.amountMinor);
  const amountStroops = amountMinor * 100_000n;

  let guardResult;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: `/api/admin/users/${userId}/emissions`,
      },
      async () => {
        const applied = await applyAdminEmission({
          userId,
          currency: parsed.data.currency,
          amountMinor,
          intent: {
            assetCode: asset.code,
            assetIssuer,
            // MNY-10: queue the DB-authoritative registered wallet, not
            // the raw request field. They are equal here (validated
            // above), but pinning to the resolved value keeps the
            // on-chain destination sourced from the user's record.
            toAddress: registeredWallet,
            amountStroops,
            memoText: generatePayoutMemo(),
          },
        });

        const result: EmissionResponse = {
          payoutId: applied.payoutId,
          userId: applied.userId,
          currency: applied.currency,
          amountMinor: applied.amountMinor.toString(),
          destinationAddress: registeredWallet,
          balanceMinor: applied.balanceMinor.toString(),
          createdAt: applied.createdAt.toISOString(),
        };

        const envelope: AdminAuditEnvelope<EmissionResponse> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: applied.createdAt,
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return c.json(
        {
          code: 'INSUFFICIENT_BALANCE',
          message: err.message,
        },
        400,
      );
    }
    if (err instanceof EmissionAlreadyIssuedError) {
      return c.json(
        {
          code: 'EMISSION_ALREADY_ISSUED',
          message: err.message,
        },
        409,
      );
    }
    if (err instanceof EmissionExceedsUnemittedBalanceError) {
      // Hardening A1: cumulative conservation — the balance guard
      // passed but prior emissions/payouts already materialised the
      // liability on-chain. Numbers in the body so the operator sees
      // exactly how much headroom remains.
      return c.json(
        {
          code: 'EMISSION_EXCEEDS_UNEMITTED_BALANCE',
          message: err.message,
        },
        409,
      );
    }
    if (err instanceof DailyAdjustmentLimitError) {
      // Hardening A1: fleet-wide per-currency daily emission cap —
      // same shape as the adjustment/compensation caps so a
      // compromised admin session cannot drain the treasury through
      // emissions inside one UTC day.
      return c.json(
        {
          code: 'DAILY_LIMIT_EXCEEDED',
          message: `Daily ${err.currency} emission cap (${err.capMinor} minor) hit — ${err.usedMinor} used today, attempted ${err.attemptedDelta}`,
        },
        429,
      );
    }
    log.error({ err, userId, adminUserId: actor.id }, 'Emission failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to apply emission' }, 500);
  }

  const priorResult = (guardResult.body as { result?: EmissionResponse }).result;

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: `POST /api/admin/users/${userId}/emissions`,
    targetUserId: userId,
    ...(priorResult?.amountMinor !== undefined ? { amountMinor: priorResult.amountMinor } : {}),
    ...(priorResult?.currency !== undefined ? { currency: priorResult.currency } : {}),
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200);
}
