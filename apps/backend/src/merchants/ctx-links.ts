// CTX merchant-link registry + user-discount push — ADR 052
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

// replace-not-merge: merchants CTX stopped serving drop out
export function replaceMerchantLinks(links: Map<string, CtxMerchantLink>): void {
  linksByMerchantId = links;
}

export function getMerchantLink(merchantId: string): CtxMerchantLink | undefined {
  return linksByMerchantId.get(merchantId);
}

// null when operator discount unknown — never silently becomes zero
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

// sweep is the safety net for missed pushes
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

// serial on purpose — small config set, burst of parallel writes buys nothing
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
