/**
 * Merchant-side admin surfaces: the manual catalog resync, the
 * per-merchant order stats, and the catalog CSV export.
 *
 * `POST /api/admin/merchants/resync`      — force an upstream sweep
 * `GET  /api/admin/merchant-stats`        — orders rolled up per merchant
 * `GET  /api/admin/merchants-catalog.csv` — the catalog + its rates
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { forceRefreshMerchants, getMerchants } from '../merchants/sync.js';
import { db } from '../db/client.js';
import type { User } from '../db/users.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { csvRow } from './csv-escape.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-merchants' });

// ─── Manual catalog resync ──────────────────────────────────────────────────

/**
 * `POST /api/admin/merchants/resync` — forces an immediate sweep of
 * the upstream CTX catalog so ops can apply a merchant change (a new
 * store, a denomination tweak, a disabled flag) within seconds instead
 * of waiting for the scheduled refresh. The in-memory catalog is
 * swapped atomically once the new snapshot is fully built.
 *
 * Rate-limited tightly, because every hit goes to CTX — this is a
 * manual override, not a polled surface. Two admins clicking at once
 * coalesce into a single upstream sweep; one sees `triggered: true`,
 * the other `false` with the same `loadedAt`.
 *
 * A 502 on failure rather than a 500: it is a CTX problem, not a
 * backend bug. The cached snapshot is kept rather than zeroed, so
 * `/api/merchants` keeps serving the prior catalog through the
 * outage.
 *
 * Not step-up gated: it moves no money, creates nothing, and is
 * self-correcting — the worst outcome of an unwanted resync is that
 * the catalog matches CTX slightly sooner than it would have.
 */
export interface AdminMerchantResyncResponse {
  /** Post-sync total, not a delta against the previous snapshot. */
  merchantCount: number;
  loadedAt: string;
  /** False when another sweep was already in flight and this call coalesced. */
  triggered: boolean;
}

const ResyncBody = z.object({
  // A2-509: the reason answers "why did ops force this" later, without
  // anyone having to reconstruct it from chat history.
  reason: z.string().min(2).max(500),
});

export async function adminMerchantsResyncHandler(c: Context): Promise<Response> {
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
  const parsed = ResyncBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await withIdempotencyGuard(
      {
        adminUserId: actor.id,
        key: idempotencyKey,
        method: 'POST',
        path: '/api/admin/merchants/resync',
      },
      async () => {
        const outcome = await forceRefreshMerchants();
        const store = getMerchants();
        const result: AdminMerchantResyncResponse = {
          merchantCount: store.merchants.length,
          loadedAt: new Date(store.loadedAt).toISOString(),
          triggered: outcome.triggered,
        };
        const envelope: AdminAuditEnvelope<AdminMerchantResyncResponse> = buildAuditEnvelope({
          result,
          actor,
          idempotencyKey,
          appliedAt: new Date(store.loadedAt),
          replayed: false,
        });
        return { status: 200, body: envelope as unknown as Record<string, unknown> };
      },
    );
  } catch (err) {
    log.error({ err }, 'Admin merchant-catalog resync failed');
    return c.json(
      { code: 'UPSTREAM_ERROR', message: 'Failed to refresh the merchant catalog from upstream' },
      502,
    );
  }

  notifyAdminAudit({
    actorUserId: actor.id,
    endpoint: 'POST /api/admin/merchants/resync',
    reason: parsed.data.reason,
    idempotencyKey,
    replayed: guardResult.replayed,
  });

  return c.json(guardResult.body, guardResult.status as 200 | 400 | 500);
}

// ─── Per-merchant order stats ───────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
/**
 * Rows scanned to build the roll-up. The store has no aggregation, so
 * the tally happens here — this bound is what stops a wide window from
 * pulling an unbounded number of orders into memory. When it bites,
 * the response says so rather than quietly under-reporting.
 */
const STATS_SCAN_LIMIT = 20000;

export interface AdminMerchantStatsRow {
  merchantId: string;
  /** Catalog name when the merchant is still in the catalog, else null. */
  merchantName: string | null;
  orderCount: number;
  fulfilledCount: number;
  /**
   * Face value summed per currency. Orders in different currencies are
   * never added together — a single total would be a made-up number.
   */
  faceValueMinorByCurrency: Record<string, number>;
  userCashbackMinorByCurrency: Record<string, number>;
}

export interface AdminMerchantStatsResponse {
  windowDays: number;
  /** True when the scan cap was reached and the figures are partial. */
  truncated: boolean;
  rows: AdminMerchantStatsRow[];
}

/**
 * `GET /api/admin/merchant-stats` — which merchants people are
 * actually buying, and how much cashback each is costing, over a
 * trailing window. The commercial view behind the cashback-rate knob:
 * a rate edit is hard to justify without knowing the volume it
 * applies to.
 */
export async function adminMerchantStatsHandler(c: Context): Promise<Response> {
  const raw = c.req.query('windowDays');
  const parsed = Number.parseInt(raw ?? String(DEFAULT_WINDOW_DAYS), 10);
  const windowDays = Math.min(
    Math.max(Number.isNaN(parsed) ? DEFAULT_WINDOW_DAYS : parsed, 1),
    MAX_WINDOW_DAYS,
  );

  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const orders = await db
      .collection('orders')
      .findMany({ createdAt: { $gte: since } }, { limit: STATS_SCAN_LIMIT + 1 });
    const truncated = orders.length > STATS_SCAN_LIMIT;
    const scanned = truncated ? orders.slice(0, STATS_SCAN_LIMIT) : orders;

    const byMerchant = new Map<string, AdminMerchantStatsRow>();
    const { merchantsById } = getMerchants();
    for (const order of scanned) {
      let row = byMerchant.get(order.merchantId);
      if (row === undefined) {
        row = {
          merchantId: order.merchantId,
          merchantName: merchantsById.get(order.merchantId)?.name ?? null,
          orderCount: 0,
          fulfilledCount: 0,
          faceValueMinorByCurrency: {},
          userCashbackMinorByCurrency: {},
        };
        byMerchant.set(order.merchantId, row);
      }
      row.orderCount += 1;
      if (order.state === 'fulfilled') row.fulfilledCount += 1;
      row.faceValueMinorByCurrency[order.currency] =
        (row.faceValueMinorByCurrency[order.currency] ?? 0) + order.faceValueMinor;
      row.userCashbackMinorByCurrency[order.chargeCurrency] =
        (row.userCashbackMinorByCurrency[order.chargeCurrency] ?? 0) + order.userCashbackMinor;
    }

    const rows = [...byMerchant.values()].sort((a, b) => b.orderCount - a.orderCount);
    return c.json<AdminMerchantStatsResponse>({ windowDays, truncated, rows });
  } catch (err) {
    log.error({ err }, 'Admin merchant stats failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to load merchant stats' }, 500);
  }
}

// ─── Catalog export ─────────────────────────────────────────────────────────

/**
 * `GET /api/admin/merchants-catalog.csv` — the live catalog joined to
 * its configured cashback rate. The one place an operator can see, in
 * a single artifact, which merchants are advertised and what each is
 * promising — including the ones with no config at all, which are
 * silently on the fallback split.
 */
export async function adminMerchantsCatalogCsvHandler(c: Context): Promise<Response> {
  try {
    const configs = await db.collection('merchant_cashback_configs').findMany();
    const byMerchant = new Map(configs.map((cfg) => [cfg.merchantId, cfg]));
    const { merchants } = getMerchants();

    const lines = [
      csvRow([
        'merchant_id',
        'merchant_name',
        'user_cashback_pct',
        'cashback_config_active',
        'has_cashback_config',
      ]),
    ];
    for (const merchant of merchants) {
      const cfg = byMerchant.get(merchant.id);
      lines.push(
        csvRow([
          merchant.id,
          merchant.name,
          cfg === undefined ? '' : String(cfg.userCashbackPct),
          cfg === undefined ? '' : cfg.active ? 'true' : 'false',
          cfg === undefined ? 'false' : 'true',
        ]),
      );
    }

    return new Response(`${lines.join('\n')}\n`, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="merchants-catalog.csv"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error({ err }, 'Admin merchants-catalog CSV export failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to export the catalog' }, 500);
  }
}
