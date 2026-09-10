// CTX gift-card-detail fetch + parsing — ADR 010, ADR 015
import { z } from 'zod';
import { logger } from '../logger.js';
import { ctxFetch } from '../ctx/api-fetch.js';
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
