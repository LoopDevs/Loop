/**
 * CTX merchant-link registry + user-discount push (ADR 052).
 *
 * The single "User Cashback %" knob (merchant_cashback_configs.
 * user_cashback_pct — the share of Loop's margin given to the
 * customer) is delivered as CTX's native user discount: Loop pushes
 * `userDiscountBasisPoints = floor(operatorDiscountBp × pct / 100)`
 * onto its merchant link via the bulk `PUT /merchant-links`
 * endpoint (operator-permitted update; CTX enforces user ≤
 * operator).
 *
 * Two write paths, both fail-soft:
 *
 *   - Admin save (`upsert-config-handler.ts`) fires a push for that
 *     merchant immediately after commit.
 *   - The hourly catalog sweep (`sync.ts`) reconciles every active
 *     config against the link state CTX just reported, catching
 *     missed pushes, CTX-side edits, and operator-discount changes
 *     that alter the derived user bp.
 *
 * The registry is fed by the sweep (and is empty after a warm-start
 * until the first sweep lands) — a push with no registry entry is a
 * no-op logged at info; the next sweep closes the gap. Nothing here
 * throws to its caller: cashback delivery degrades to "eventually
 * consistent with CTX", never blocks an admin save or a sweep.
 */
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { ctxFetch } from '../ctx/api-fetch.js';
import { upstreamUrl } from '../upstream.js';
import { operatorCompanyId } from '../orders/ctx-order.js';

const log = logger.child({ module: 'ctx-links' });

const CTX_WRITE_TIMEOUT_MS = 15_000;

export interface CtxMerchantLink {
  id: string;
  operatorDiscountBasisPoints: number | null;
  userDiscountBasisPoints: number | null;
}

let linksByMerchantId = new Map<string, CtxMerchantLink>();

export function __resetCtxLinksForTests(): void {
  linksByMerchantId = new Map();
}

/**
 * Atomically replaces the registry — called by the sweep with the
 * links it just parsed, mirroring the merchant store's replace-not-
 * merge semantics so a merchant CTX stopped serving drops out.
 */
export function replaceMerchantLinks(links: Map<string, CtxMerchantLink>): void {
  linksByMerchantId = links;
}

export function getMerchantLink(merchantId: string): CtxMerchantLink | undefined {
  return linksByMerchantId.get(merchantId);
}

/**
 * The link-level user discount the config demands: floor(operator
 * discount × pct / 100). Null when the operator discount is unknown
 * (no link entry yet, or CTX hasn't set Loop's rate for this
 * merchant) — unknown never silently becomes zero.
 */
export function desiredUserDiscountBp(
  link: CtxMerchantLink | undefined,
  userCashbackPct: number,
): number | null {
  if (link === undefined || link.operatorDiscountBasisPoints === null) return null;
  return Math.floor((link.operatorDiscountBasisPoints * userCashbackPct) / 100);
}

async function pushLinkUserDiscount(link: CtxMerchantLink, userBp: number): Promise<boolean> {
  const companyId = await operatorCompanyId();
  if (companyId === null) {
    log.warn({ linkId: link.id }, 'CTX company id unresolved — skipping user-discount push');
    return false;
  }
  try {
    const res = await ctxFetch(upstreamUrl('/merchant-links'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        targetEntityType: 'company',
        targetEntityId: companyId,
        update: [
          {
            id: link.id,
            userDiscountBasisPoints: userBp,
          },
        ],
      }),
      signal: AbortSignal.timeout(CTX_WRITE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(
        { linkId: link.id, status: res.status, body: body.slice(0, 500) },
        'CTX rejected user-discount push',
      );
      return false;
    }
    await res.arrayBuffer().catch(() => undefined);
    return true;
  } catch (err) {
    log.warn({ err, linkId: link.id }, 'CTX user-discount push failed');
    return false;
  }
}

/**
 * Push one merchant's configured cashback share to CTX. Fired after
 * an admin config save. Inactive configs push 0 (no discount).
 * Returns whether a write landed — callers only log; the sweep is
 * the safety net.
 */
export async function pushUserDiscountForMerchant(
  merchantId: string,
  userCashbackPct: number,
  active: boolean,
): Promise<boolean> {
  const link = getMerchantLink(merchantId);
  const desired = desiredUserDiscountBp(link, active ? userCashbackPct : 0);
  if (link === undefined || desired === null) {
    log.info(
      { merchantId },
      'No CTX link data for merchant yet — user-discount push deferred to the next sweep',
    );
    return false;
  }
  if (link.userDiscountBasisPoints === desired) return true;
  const pushed = await pushLinkUserDiscount(link, desired);
  if (pushed) {
    linksByMerchantId.set(merchantId, { ...link, userDiscountBasisPoints: desired });
    log.info({ merchantId, userDiscountBasisPoints: desired }, 'Pushed user discount to CTX');
  }
  return pushed;
}

/**
 * Sweep-time reconcile: every active config's derived user bp is
 * compared against what CTX just reported on the link; drifted
 * links are pushed. Serial on purpose — this runs right after the
 * hourly catalog sweep and a config set is small; a burst of
 * parallel writes against CTX buys nothing.
 */
export async function reconcileUserDiscounts(): Promise<void> {
  let configs;
  try {
    configs = await db.collection('merchant_cashback_configs').findMany({ active: true });
  } catch (err) {
    log.error({ err }, 'Cashback-config read failed — skipping user-discount reconcile');
    return;
  }
  let pushed = 0;
  for (const config of configs) {
    const link = getMerchantLink(config.merchantId);
    const desired = desiredUserDiscountBp(link, Number(config.userCashbackPct));
    if (link === undefined || desired === null) continue;
    if ((link.userDiscountBasisPoints ?? 0) === desired) continue;
    if (await pushLinkUserDiscount(link, desired)) {
      linksByMerchantId.set(config.merchantId, { ...link, userDiscountBasisPoints: desired });
      pushed++;
    }
  }
  if (pushed > 0) {
    log.info({ pushed, configs: configs.length }, 'Reconciled CTX user discounts after sweep');
  }
}
