// CTX gift-card-detail fetch + parsing — ADR 010, ADR 015
import { z } from 'zod';
import { logger } from '../logger.js';
import { ctxFetch, ctxApiCredentials } from '../ctx/api-fetch.js';
import { streamGiftCardStatus } from '../ctx/stream.js';
import { upstreamUrl } from '../upstream.js';
import { notifyCtxSchemaDrift } from '../discord.js';
import { summariseZodIssues } from './handler-shared.js';

const log = logger.child({ area: 'procurement-redemption' });

const CtxGiftCardDetailResponse = z.object({
  number: z.string().optional(),
  pin: z.string().optional(),
  redeemUrl: z.string().optional(),
});

// Rejects non-http(s) protocols to prevent javascript: injection in clickable links (money review 2026-07-08)
export function sanitizeRedeemUrl(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : null;
}

export async function fetchRedemption(ctxOrderId: string): Promise<{
  code: string | null;
  pin: string | null;
  url: string | null;
}> {
  const res = await ctxFetch(upstreamUrl(`/gift-cards/${encodeURIComponent(ctxOrderId)}`), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    log.warn(
      { ctxOrderId, status: res.status },
      'CTX gift-card detail fetch returned non-ok; persisting order without redemption payload',
    );
    return { code: null, pin: null, url: null };
  }
  const raw = await res.json();
  const parsed = CtxGiftCardDetailResponse.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { ctxOrderId, issues: parsed.error.issues },
      'CTX gift-card detail schema mismatch; persisting order without redemption payload',
    );
    notifyCtxSchemaDrift({
      surface: 'GET /gift-cards/:id',
      issuesSummary: summariseZodIssues(parsed.error.issues),
    });
    return { code: null, pin: null, url: null };
  }
  const out = {
    code: parsed.data.number ?? null,
    pin: parsed.data.pin ?? null,
    url: sanitizeRedeemUrl(parsed.data.redeemUrl ?? null),
  };
  // Logs key names only to distinguish field-name drift from empty response without leaking live codes/PINs (FT-14)
  if (out.code === null && out.pin === null && out.url === null) {
    const keys = raw !== null && typeof raw === 'object' ? Object.keys(raw) : [];
    log.info(
      { ctxOrderId, keys },
      'CTX gift-card detail returned no redemption fields — capturing shape for diagnosis',
    );
  }
  return out;
}

export interface WaitForRedemptionOptions {
  /** Total wall-clock budget across stream + polling fallback (ms). Default 5 min. */
  totalTimeoutMs?: number;
  /** Polling interval after a stream error (ms). Default 1 s. */
  pollIntervalMs?: number;
}

// Reads timing defaults from env to allow tests to collapse 5-min/1-s budgets without changing function signature
function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export async function waitForRedemption(
  ctxOrderId: string,
  opts: WaitForRedemptionOptions = {},
): Promise<{
  code: string | null;
  pin: string | null;
  url: string | null;
}> {
  const totalTimeoutMs =
    opts.totalTimeoutMs ?? numericEnv('LOOP_REDEMPTION_TOTAL_TIMEOUT_MS', 5 * 60 * 1000);
  const pollIntervalMs =
    opts.pollIntervalMs ?? numericEnv('LOOP_REDEMPTION_POLL_INTERVAL_MS', 1000);
  const deadline = Date.now() + totalTimeoutMs;

  const creds = ctxApiCredentials();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
    try {
      await streamGiftCardStatus(ctxOrderId, {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        clientId: creds.clientId,
        signal: controller.signal,
        onUpdate: (frame) => {
          const status =
            typeof frame.fulfilmentStatus === 'string'
              ? frame.fulfilmentStatus
              : typeof frame.status === 'string'
                ? frame.status
                : 'unknown';
          log.debug({ ctxOrderId, status }, 'CTX SSE frame');
        },
      });
    } finally {
      clearTimeout(timer);
    }
    return await fetchRedemption(ctxOrderId);
  } catch (err) {
    // Propagates CTX-side rejections to trigger order failure; falls back to polling for transport errors
    const msg = err instanceof Error ? err.message : String(err);
    if (/^CTX order .* (rejected|failed|error)/.test(msg)) {
      throw err;
    }
    log.warn({ ctxOrderId, err: msg }, 'CTX SSE stream errored — falling back to polling');
  }

  let last: { code: string | null; pin: string | null; url: string | null } = {
    code: null,
    pin: null,
    url: null,
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      last = await fetchRedemption(ctxOrderId);
      if (last.code !== null || last.pin !== null || last.url !== null) {
        return last;
      }
    } catch (err) {
      log.warn(
        { ctxOrderId, err: err instanceof Error ? err.message : String(err) },
        'Polling fetchRedemption tick failed — continuing',
      );
    }
  }
  log.warn(
    { ctxOrderId },
    'waitForRedemption budget exhausted with no redemption payload — persisting nulls',
  );
  return last;
}
