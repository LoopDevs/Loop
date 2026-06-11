/**
 * Privy embedded-wallet adapter (ADR 030, Phase B).
 *
 * Plain `fetch` + Zod against Privy's REST API — deliberately NO
 * `@privy-io/*` npm dependency on the backend. Repo policy requires
 * an ADR per new dependency, and ADR 030 isolates vendor-specific
 * code to this module precisely so the documented dfns fallback
 * stays a contained swap. The REST surface we need is two endpoints;
 * an SDK buys nothing.
 *
 * Endpoints (verified against https://docs.privy.io/api-reference/
 * wallets/create + the raw_sign path in Privy's OpenAPI spec at
 * https://api.privy.io/v1/openapi.json, 2026-06-11):
 *
 *   GET  /v1/wallets?chain_type=stellar&external_id=<loop-user-id>
 *   POST /v1/wallets            { chain_type: 'stellar', external_id }
 *   POST /v1/wallets/:id/raw_sign  { params: { hash: '0x<64-hex>' } }
 *
 * Auth: HTTP Basic with `PRIVY_APP_ID:PRIVY_APP_SECRET`, plus the
 * required `privy-app-id` header on every request.
 *
 * User linking: Privy's `owner.user_id` field expects a *Privy* user
 * id (`did:privy:...`), which custom-auth users only acquire after a
 * client-side SDK session — the backend has none at provisioning
 * time. The server-side linking field is `external_id` ("a
 * customer-provided identifier for mapping to external systems",
 * write-once, URL-safe ≤64 chars) — Loop user UUIDs fit it exactly.
 *
 * createWallet idempotency (query-before-create, two layers):
 *   1. GET /v1/wallets filtered by `external_id` + `chain_type` —
 *      an existing wallet is returned without a second create.
 *   2. The POST carries a deterministic `privy-idempotency-key`
 *      derived from the user id, so two racing creates inside
 *      Privy's 24h idempotency window collapse to one wallet.
 *   Privy does not enforce `external_id` uniqueness server-side, so
 *   layer 2 covers the race layer 1 cannot; beyond the 24h window
 *   layer 1 always finds the existing wallet first. The partial
 *   unique index on `users.wallet_id` (migration 0039) is the final
 *   DB-side backstop when Phase C persists the linkage.
 */
import { z } from 'zod';
import { WalletProviderError, type WalletProvider } from './provider.js';

const PRIVY_API_BASE_URL = 'https://api.privy.io';

/**
 * Per-request timeout. Mirrors the repo-wide AbortSignal convention
 * (every upstream call has a timeout). 10s matches the image-proxy /
 * email-provider ceilings — Privy's signing path is sub-second in
 * practice; anything past 10s is effectively down and the caller's
 * retry policy should take over.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * NOTE on circuit breakers: upstream calls normally go through
 * `getUpstreamCircuit(...)`, but that registry is scoped to the CTX
 * upstream's endpoint categories (AGENTS.md §Upstream calls — the
 * documented exceptions list). Privy is a different upstream with
 * its own failure domain; grouping it under a CTX breaker key would
 * couple their trip states. Phase B keeps a bare fetch + timeout +
 * transient/terminal classification (the callers' retry loops are
 * the policy layer, as with payout-submit); a dedicated Privy
 * breaker can be added when Phase C puts this on a request path.
 */

/** Loop user ids (UUIDs) satisfy this; pinned to Privy's documented external_id constraints. */
const EXTERNAL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 32-byte Stellar tx hash as hex (optionally 0x-prefixed on input). */
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** 64-byte ed25519 signature as hex, after stripping Privy's 0x prefix. */
const ED25519_SIGNATURE_RE = /^[0-9a-fA-F]{128}$/;

/**
 * Wallet object subset we consume. Privy returns more fields
 * (policy_ids, custody, …) — Zod's default non-strict object mode
 * ignores them, so additive upstream changes don't break us.
 */
const PrivyWalletSchema = z.object({
  id: z.string().min(1),
  address: z.string().min(1),
  chain_type: z.literal('stellar'),
  external_id: z.string().optional(),
});

const PrivyWalletListSchema = z.object({
  data: z.array(PrivyWalletSchema),
  next_cursor: z.string().nullish(),
});

const PrivyRawSignSchema = z.object({
  method: z.literal('raw_sign'),
  data: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'expected 0x-prefixed hex signature'),
    encoding: z.literal('hex'),
  }),
});

export interface PrivyWalletProviderConfig {
  appId: string;
  /** Never logged — see the pino redaction paths in logger.ts. */
  appSecret: string;
  /** Override for tests only; production always hits api.privy.io. */
  baseUrl?: string;
}

interface PrivyRequestInit {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

export function createPrivyWalletProvider(config: PrivyWalletProviderConfig): WalletProvider {
  const baseUrl = config.baseUrl ?? PRIVY_API_BASE_URL;
  const basicAuth = Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64');

  async function privyRequest(init: PrivyRequestInit): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${basicAuth}`,
      'privy-app-id': config.appId,
      'Content-Type': 'application/json',
    };
    if (init.idempotencyKey !== undefined) {
      headers['privy-idempotency-key'] = init.idempotencyKey;
    }

    const requestInit: RequestInit = {
      method: init.method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (init.body !== undefined) {
      requestInit.body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${init.path}`, requestInit);
    } catch (err) {
      // Network failure / DNS / AbortSignal timeout — all transient:
      // nothing was observed from Privy, so a later retry is safe
      // for GETs and idempotency-keyed POSTs alike.
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : 'fetch threw';
      throw new WalletProviderError(
        'transient_provider',
        `Privy ${init.method} ${init.path} failed before a response: ${detail}`,
      );
    }

    if (!res.ok) {
      // Mirror the payout-submit taxonomy: 5xx and 429 are retryable,
      // every other 4xx is a contract/config problem retries won't fix.
      const kind: WalletProviderError['kind'] =
        res.status >= 500 || res.status === 429 ? 'transient_provider' : 'terminal_provider';
      const bodyText = await res.text().catch(() => '');
      throw new WalletProviderError(
        kind,
        `Privy ${init.method} ${init.path} returned ${res.status}: ${bodyText.slice(0, 300)}`,
        res.status,
      );
    }

    try {
      return (await res.json()) as unknown;
    } catch {
      // 2xx with a non-JSON body is provider contract drift — fail
      // loud rather than guessing.
      throw new WalletProviderError(
        'terminal_provider',
        `Privy ${init.method} ${init.path} returned ${res.status} with a non-JSON body`,
        res.status,
      );
    }
  }

  function parseOrDrift<T>(schema: z.ZodType<T>, payload: unknown, context: string): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new WalletProviderError(
        'terminal_provider',
        `Privy ${context} response failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  return {
    name: 'privy',

    async createWallet(userId: string): Promise<{ walletId: string; address: string }> {
      if (!EXTERNAL_ID_RE.test(userId)) {
        throw new WalletProviderError(
          'terminal_provider',
          'userId is not a valid Privy external_id (URL-safe chars, max 64)',
        );
      }

      // Idempotency layer 1: query-before-create on external_id.
      const listPayload = await privyRequest({
        method: 'GET',
        path: `/v1/wallets?chain_type=stellar&external_id=${encodeURIComponent(userId)}`,
      });
      const existing = parseOrDrift(PrivyWalletListSchema, listPayload, 'GET /v1/wallets');
      const match = existing.data[0];
      if (match !== undefined) {
        return { walletId: match.id, address: match.address };
      }

      // Idempotency layer 2: deterministic idempotency key so two
      // racing first-creates collapse inside Privy's 24h window.
      const createPayload = await privyRequest({
        method: 'POST',
        path: '/v1/wallets',
        body: { chain_type: 'stellar', external_id: userId },
        idempotencyKey: `loop-wallet-stellar-${userId}`,
      });
      const created = parseOrDrift(PrivyWalletSchema, createPayload, 'POST /v1/wallets');
      return { walletId: created.id, address: created.address };
    },

    async rawSign(walletId: string, hashHex: string): Promise<string> {
      const normalizedHash = hashHex.startsWith('0x') ? hashHex.slice(2) : hashHex;
      if (!TX_HASH_RE.test(normalizedHash)) {
        throw new WalletProviderError(
          'terminal_provider',
          'hashHex must be the 64-hex-char (32-byte) Stellar transaction hash',
        );
      }

      const payload = await privyRequest({
        method: 'POST',
        path: `/v1/wallets/${encodeURIComponent(walletId)}/raw_sign`,
        // Privy's Hex type requires the 0x prefix.
        body: { params: { hash: `0x${normalizedHash.toLowerCase()}` } },
      });
      const parsed = parseOrDrift(PrivyRawSignSchema, payload, 'POST raw_sign');

      const signatureHex = parsed.data.signature.slice(2).toLowerCase();
      if (!ED25519_SIGNATURE_RE.test(signatureHex)) {
        // A "signature" that isn't 64 bytes can't be an ed25519
        // signature over a Stellar hash — refuse it here so the
        // bad material never reaches transaction assembly.
        throw new WalletProviderError(
          'terminal_provider',
          `Privy raw_sign returned a ${signatureHex.length / 2}-byte signature; expected 64 bytes (ed25519)`,
        );
      }
      return signatureHex;
    },
  };
}
