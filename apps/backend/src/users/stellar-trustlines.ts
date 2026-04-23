/**
 * `GET /api/users/me/stellar-trustlines` — user-facing trustline
 * check (ADR 015).
 *
 * Answers "can my linked Stellar address actually receive LOOP-asset
 * cashback?". Without a trustline to the configured issuer, the
 * payout worker will submit the tx, Horizon will reject with
 * `op_no_trust`, and the user ends up with a `failed` pending_payouts
 * row they don't understand.
 *
 * Shape:
 *   - `address: null` → user hasn't linked a wallet yet. Returns 200
 *     with `rows: []` + `accountLinked: false`. The UI renders the
 *     link-wallet nudge instead of a trustline list.
 *   - `address: <G...>`: reads Horizon, returns one row per
 *     configured LOOP asset (USDLOOP / GBPLOOP / EURLOOP) with
 *     `present: bool`, plus the asset's issuer so the UI can render
 *     a "add trustline for <issuer>" affordance.
 *
 * Horizon failure → 503. The admin-side drift UI already keeps the
 * ledger-side authoritative; this surface follows the same rule —
 * we'd rather show "couldn't check right now" than a false "no
 * trustline" that shouts at the user.
 */
import type { Context } from 'hono';
import { ApiException } from '@loop/shared';
import type { LoopAssetCode } from '@loop/shared';
import { configuredLoopPayableAssets } from '../credits/payout-asset.js';
import { getAccountTrustlines } from '../payments/horizon-trustlines.js';
import { getUserById, upsertUserFromCtx, type User } from '../db/users.js';
import { decodeJwtPayload } from '../auth/jwt.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'user-stellar-trustlines' });

export interface StellarTrustlineRow {
  code: LoopAssetCode;
  issuer: string;
  present: boolean;
  /** Balance on an existing trustline. BigInt as string. 0 when absent. */
  balanceStroops: string;
  /** Trustline limit. BigInt as string. 0 when absent. */
  limitStroops: string;
}

export interface StellarTrustlinesResponse {
  address: string | null;
  accountLinked: boolean;
  /** True when Horizon has an account record; false for unfunded / unlinked. */
  accountExists: boolean;
  rows: StellarTrustlineRow[];
}

async function resolveCallingUser(c: Context): Promise<User | null> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined) return null;
  if (auth.kind === 'loop') {
    return await getUserById(auth.userId);
  }
  const claims = decodeJwtPayload(auth.bearerToken);
  if (claims === null) return null;
  return await upsertUserFromCtx({
    ctxUserId: claims.sub,
    email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
  });
}

export async function getUserStellarTrustlinesHandler(c: Context): Promise<Response> {
  let user: User | null;
  try {
    user = await resolveCallingUser(c);
  } catch (err) {
    log.error({ err }, 'Failed to resolve calling user');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
  }
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const configured = configuredLoopPayableAssets();

  if (user.stellarAddress === null) {
    return c.json<StellarTrustlinesResponse>({
      address: null,
      accountLinked: false,
      accountExists: false,
      rows: configured.map((c) => ({
        code: c.code,
        issuer: c.issuer,
        present: false,
        balanceStroops: '0',
        limitStroops: '0',
      })),
    });
  }

  try {
    const snap = await getAccountTrustlines(user.stellarAddress);
    const rows: StellarTrustlineRow[] = configured.map(({ code, issuer }) => {
      const key = `${code}::${issuer}`;
      const t = snap.trustlines.get(key);
      return {
        code,
        issuer,
        present: t !== undefined,
        balanceStroops: (t?.balanceStroops ?? 0n).toString(),
        limitStroops: (t?.limitStroops ?? 0n).toString(),
      };
    });
    return c.json<StellarTrustlinesResponse>({
      address: user.stellarAddress,
      accountLinked: true,
      accountExists: snap.accountExists,
      rows,
    });
  } catch (err) {
    if (err instanceof ApiException) throw err;
    log.warn({ err, address: user.stellarAddress }, 'Horizon trustline read failed');
    return c.json({ code: 'UPSTREAM_UNAVAILABLE', message: 'Trustline check unavailable' }, 503);
  }
}
