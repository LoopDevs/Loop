/**
 * Admin per-asset circulation drift (ADR 015).
 *
 * `GET /api/admin/assets/:assetCode/circulation` — compares
 * on-chain issued circulation (Horizon `/assets`) against the
 * off-chain ledger liability (`user_credits.balance_minor` for
 * the matching home currency). The stablecoin-operator safety
 * metric: a non-zero drift that isn't explained by in-flight
 * payouts is the "something broke" signal.
 *
 * Each LOOP asset is pinned 1:1 to its fiat, so 1 minor unit
 * (cent / pence) corresponds to exactly 1e5 stroops (7-decimal
 * asset units / 100 minor units per whole). `driftStroops =
 * onChainStroops - ledgerLiabilityMinor * 1e5`:
 *
 *   - Positive drift: more in circulation than we owe — we
 *     over-minted or a user still holds LOOP asset from a spent
 *     order. Often a transient during payout processing.
 *   - Negative drift: less in circulation than we owe — the
 *     settlement backlog, effectively. Shrinks as the payout
 *     worker submits + Horizon confirms.
 *   - Zero drift: on-chain matches ledger. Rare because payouts
 *     are never exactly in lockstep with credit writes.
 *
 * Horizon failure surfaces as 503 rather than 500 so the admin
 * UI can render the ledger side with a clear "on-chain read
 * failed" affordance — the liability side comes from Postgres
 * and is always authoritative.
 */
import type { Context } from 'hono';
import {
  HOME_CURRENCIES,
  LOOP_ASSET_CODES,
  isLoopAssetCode,
  type AssetCirculationResponse,
  type HomeCurrency,
  type LoopAssetCode,
} from '@loop/shared';
import { getLoopAssetCirculation } from '../payments/horizon-circulation.js';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { sumOutstandingLiability } from '../credits/liabilities.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-asset-circulation' });

// A2-1506: `AssetCirculationResponse` moved to
// `@loop/shared/admin-assets.ts`. Re-exported below via `export type`
// for in-file builders.
export type { AssetCirculationResponse };

const STROOPS_PER_MINOR = 100_000n;

// A2-812: local `isLoopAsset` was a duplicate of `isLoopAssetCode`
// from `@loop/shared/loop-asset`. Now imported — one place to
// maintain the LOOP-asset allowlist for both backend and web.

function fiatOf(code: LoopAssetCode): HomeCurrency {
  const fiat = code.slice(0, 3);
  if ((HOME_CURRENCIES as ReadonlyArray<string>).includes(fiat)) {
    return fiat as HomeCurrency;
  }
  // Unreachable given LOOP_ASSET_CODES is USD/GBP/EURLOOP only —
  // but type-narrow here so the fiat slice stays inside the enum.
  throw new Error(`Unknown fiat for asset ${code}`);
}

export async function adminAssetCirculationHandler(c: Context): Promise<Response> {
  const assetCodeRaw = c.req.param('assetCode');
  if (assetCodeRaw === undefined || assetCodeRaw.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'assetCode is required' }, 400);
  }
  const assetCode = assetCodeRaw.toUpperCase();
  if (!isLoopAssetCode(assetCode)) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: `assetCode must be one of ${LOOP_ASSET_CODES.join(', ')}`,
      },
      400,
    );
  }

  const { issuer } = payoutAssetFor(fiatOf(assetCode));
  if (issuer === null) {
    return c.json(
      {
        code: 'NOT_CONFIGURED',
        message: `${assetCode} issuer env is not configured`,
      },
      409,
    );
  }

  const fiat = fiatOf(assetCode);

  let ledgerLiabilityMinor: bigint;
  try {
    ledgerLiabilityMinor = await sumOutstandingLiability(fiat);
  } catch (err) {
    log.error({ err, assetCode }, 'Ledger liability read failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to read ledger liability' }, 500);
  }

  let onChainStroops: bigint;
  let onChainAsOfMs: number;
  try {
    const snap = await getLoopAssetCirculation(assetCode, issuer);
    onChainStroops = snap.stroops;
    onChainAsOfMs = snap.asOfMs;
  } catch (err) {
    log.warn({ err, assetCode, issuer }, 'Horizon circulation read failed');
    return c.json(
      {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'On-chain circulation read failed',
      },
      503,
    );
  }

  const liabilityStroops = ledgerLiabilityMinor * STROOPS_PER_MINOR;
  const driftStroops = onChainStroops - liabilityStroops;

  const body: AssetCirculationResponse = {
    assetCode,
    fiatCurrency: fiat,
    issuer,
    onChainStroops: onChainStroops.toString(),
    ledgerLiabilityMinor: ledgerLiabilityMinor.toString(),
    driftStroops: driftStroops.toString(),
    onChainAsOfMs,
  };
  return c.json(body);
}
