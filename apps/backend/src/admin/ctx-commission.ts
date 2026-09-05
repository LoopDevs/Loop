/**
 * Admin CTX operator-commission proxy (ctx-interop).
 *
 * `GET /api/admin/ctx-commission` — surfaces the operator commission
 * balance CTX accrues for Loop-attributed orders, plus the most
 * recent CTX settlements, by proxying CTX's
 * `GET /companies/:id/commission` and
 * `GET /companies/:id/commission/settlements` with Loop's operator
 * API credentials (the same `X-Api-Key`/`X-Api-Secret` pair the
 * user-provisioning module uses — see `ctx/user-provisioning.ts`).
 *
 * Ops uses this next to `/api/admin/supplier-spend` on the treasury
 * page: supplier-spend is Loop's own record of what flowed through
 * CTX; this endpoint is CTX's record of what it owes Loop back. The
 * two diffing cleanly is the cross-company reconciliation check the
 * interop design leans on.
 *
 * Loop's company id is not configuration — it's resolved from CTX
 * `GET /me` under the same API credentials and cached per process.
 * The credentials themselves are boot-required by the env schema, so
 * `configured` is always true on the wire (the field survives for
 * response-shape stability with older admin bundles). Upstream
 * failures (network, non-2xx, schema drift) return 502 — this is a
 * read-only reporting surface, so there is nothing to fail closed
 * over.
 *
 * Amounts stay MAJOR-unit decimal strings exactly as CTX returns
 * them (see the shared-type rationale in
 * `@loop/shared/admin-ctx-commission.ts`).
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { env } from '../env.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { logger } from '../logger.js';
import type { AdminCtxCommissionResponse } from '@loop/shared';

const log = logger.child({ handler: 'admin-ctx-commission' });

const UPSTREAM_TIMEOUT_MS = 10_000;
/** Recent settlements shown on the admin card; history walking stays in CTX admin. */
const SETTLEMENTS_PER_PAGE = 10;

/**
 * CTX `GET /companies/:id/commission` response. `.passthrough()`
 * everywhere — CTX owns these shapes and additive drift must not
 * break the proxy; only the fields Loop renders are pinned.
 */
const CtxCommissionResponse = z
  .object({
    companyId: z.string(),
    balances: z.array(
      z
        .object({
          currency: z.string(),
          amount: z.string(),
          entryCount: z.number().int().min(0),
        })
        .passthrough(),
    ),
    lastSettlementAt: z.string().optional(),
  })
  .passthrough();

/** CTX `GET /companies/:id/commission/settlements` response (paginated). */
const CtxCommissionSettlementsResponse = z
  .object({
    result: z.array(
      z
        .object({
          id: z.string(),
          amount: z.string(),
          currency: z.string(),
          periodStart: z.string(),
          periodEnd: z.string(),
          giftCardIds: z.array(z.string()),
          entryCount: z.number().int().min(0),
          created: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function ctxApiKeyHeaders(): Record<string, string> {
  return {
    'X-Api-Key': env.GIFT_CARD_API_KEY,
    'X-Api-Secret': env.GIFT_CARD_API_SECRET,
  };
}

/**
 * CTX `GET /me` under API-key auth — only the company id is pinned;
 * everything else passes through.
 */
const CtxMeResponse = z
  .object({ company: z.object({ id: z.string().min(1) }).passthrough() })
  .passthrough();

/**
 * Loop's company id on CTX, resolved once per process from `GET /me`
 * with the operator API credentials and cached — it's Loop's own
 * identity and cannot change under the same key pair, so there is no
 * invalidation concern. A failed resolution is NOT cached; the next
 * request retries. Exported reset for tests.
 */
let cachedCompanyId: string | null = null;

export function resetCtxCompanyIdCache(): void {
  cachedCompanyId = null;
}

async function resolveCompanyId(): Promise<string> {
  if (cachedCompanyId !== null) return cachedCompanyId;
  const me = CtxMeResponse.parse(await fetchCtxJson('/me'));
  cachedCompanyId = me.company.id;
  return cachedCompanyId;
}

async function fetchCtxJson(path: string): Promise<unknown> {
  const res = await fetch(upstreamUrl(path), {
    headers: ctxApiKeyHeaders(),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = scrubUpstreamBody(await res.text().catch(() => ''));
    throw new Error(`CTX ${path} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function adminCtxCommissionHandler(c: Context): Promise<Response> {
  try {
    const companyId = await resolveCompanyId();
    const [commissionRaw, settlementsRaw] = await Promise.all([
      fetchCtxJson(`/companies/${encodeURIComponent(companyId)}/commission`),
      fetchCtxJson(
        `/companies/${encodeURIComponent(companyId)}/commission/settlements?page=1&perPage=${SETTLEMENTS_PER_PAGE}`,
      ),
    ]);

    const commission = CtxCommissionResponse.safeParse(commissionRaw);
    const settlements = CtxCommissionSettlementsResponse.safeParse(settlementsRaw);
    if (!commission.success || !settlements.success) {
      log.error(
        {
          commissionIssues: commission.success ? undefined : commission.error.issues,
          settlementIssues: settlements.success ? undefined : settlements.error.issues,
        },
        'CTX commission response schema drift',
      );
      return c.json({ code: 'UPSTREAM_ERROR', message: 'CTX commission response invalid' }, 502);
    }

    const body: AdminCtxCommissionResponse = {
      configured: true,
      companyId: commission.data.companyId,
      balances: commission.data.balances.map((row) => ({
        currency: row.currency,
        amount: row.amount,
        entryCount: row.entryCount,
      })),
      ...(commission.data.lastSettlementAt !== undefined
        ? { lastSettlementAt: commission.data.lastSettlementAt }
        : {}),
      settlements: settlements.data.result.map((row) => ({
        id: row.id,
        amount: row.amount,
        currency: row.currency,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        giftCardIds: row.giftCardIds,
        entryCount: row.entryCount,
        created: row.created,
      })),
    };
    return c.json(body, 200);
  } catch (err) {
    log.error({ err }, 'CTX commission fetch failed');
    return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch commission from CTX' }, 502);
  }
}
