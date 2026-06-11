/**
 * Public LOOP-asset transparency endpoint (ADR 015 / 020).
 *
 * `GET /api/public/loop-assets` — the configured LOOP-branded Stellar
 * assets Loop pays cashback in, with their issuer public keys. Lets
 * third parties (wallet apps, block explorers, users manually adding
 * trustlines) verify the asset list without having to guess from
 * on-chain traffic patterns.
 *
 * Response:
 *   {
 *     assets: [
 *       { code: "USDLOOP", issuer: "GA...xyz" },
 *       { code: "GBPLOOP", issuer: "GB...xyz" },
 *       ...
 *     ]
 *   }
 *
 * Only assets whose issuer is configured at boot appear in the
 * response — publishing an unconfigured code risks a user adding a
 * trustline to whichever account happens to issue a same-named token,
 * which is exactly the asset-spoofing vector ADR 015 avoids by
 * pinning the issuer.
 *
 * Public-first conventions (ADR 020):
 *   - Never 500. The underlying helper is pure env reads — there's
 *     no DB call that could fail — but the handler still ships the
 *     same try/catch + fallback as the other public endpoints to
 *     make the contract uniform.
 *   - `Cache-Control: public, max-age=300` (5 min) for the happy
 *     path. Matches sibling public endpoints so a CDN can cache
 *     the same way.
 *   - No PII. Just a list of asset codes and public Stellar account
 *     ids — already broadcast to any Horizon consumer.
 */
import type { Context } from 'hono';
import type { PublicLoopAsset, PublicLoopAssetsResponse } from '@loop/shared';
import { configuredLoopPayableAssets } from '../credits/payout-asset.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'public-loop-assets' });

// PublicLoopAsset and PublicLoopAssetsResponse are now the single source
// of truth from @loop/shared (packages/shared/src/public-loop-assets.ts — ADR 019).
export type { PublicLoopAsset, PublicLoopAssetsResponse };

export async function publicLoopAssetsHandler(c: Context): Promise<Response> {
  try {
    // Pure env read — the helper is synchronous, no I/O, but we
    // wrap in try/catch so the "never 500" contract holds even if
    // a future caller grows this into a DB lookup.
    const pairs = configuredLoopPayableAssets();
    const body: PublicLoopAssetsResponse = {
      assets: pairs.map((p) => ({ code: p.code, issuer: p.issuer })),
    };
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(body);
  } catch (err) {
    log.error({ err }, 'Public loop-assets handler failed — serving empty list');
    // ADR 020 never-500. Empty list is a valid response (the
    // deployment simply hasn't configured any issuers yet).
    c.header('Cache-Control', 'public, max-age=60');
    return c.json<PublicLoopAssetsResponse>({ assets: [] });
  }
}
