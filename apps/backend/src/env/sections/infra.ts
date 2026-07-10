/**
 * env section (hardening D2 split): a field-map spread into the
 * composed `EnvSchema` in `../../env.ts`. Add new vars for this
 * domain HERE — keeps `env.ts` from being a merge-conflict magnet.
 */
import { z } from 'zod';
import { envBoolean } from '../schema-helpers.js';

export const infraEnvFields = {
  // Interest pool depletion threshold (days of cover).
  //
  // The pool watcher pages the Discord monitoring channel when the
  // on-chain pool balance can cover fewer than this many days of
  // forecast daily interest at the current APY. 7 days gives the
  // operator a week to mint the next batch before users would be
  // under-allocated. Tighter ops can lower it (3-5 days); operators
  // with monthly mint cadence + multi-day reaction time should
  // raise it.
  LOOP_INTEREST_POOL_MIN_DAYS_COVER: z.coerce.number().int().min(1).max(365).default(7),

  // Transactional email provider (ADR 013). When unset / `console`
  // the dev-only stub fires; production refuses to start with the
  // console value (see auth/email.ts). Add a real provider before
  // flipping `LOOP_AUTH_NATIVE_ENABLED=true` in production.
  // Currently supported: `resend`. Each provider has its own
  // API-key + from-address envs.
  EMAIL_PROVIDER: z.enum(['console', 'resend']).optional(),

  // Resend API key (https://resend.com). Required when
  // EMAIL_PROVIDER=resend. Format is `re_...` — never log this.
  RESEND_API_KEY: z.string().optional(),

  // Sender address used by the email provider. Must be a domain
  // the operator has verified DKIM/SPF for at the provider's
  // dashboard. Defaults to `noreply@loopfinance.io` if unset.
  EMAIL_FROM_ADDRESS: z.string().email().optional(),

  // Display name for the From header. Defaults to `Loop`.
  EMAIL_FROM_NAME: z.string().optional(),

  // Optional Reply-To address for transactional email. When set, OTP
  // emails carry a `reply_to` header so user replies route to a
  // monitored inbox (production sets hello@loopfinance.io via
  // fly.toml) instead of bouncing off the no-reply sender. Unset →
  // the reply_to key is omitted from the provider payload entirely.
  //
  // Declared in the schema so a typo'd address fails parseEnv at boot
  // (it previously bypassed env.ts via a bare process.env read in
  // auth/email.ts — a malformed value silently sent mail with no
  // Reply-To). The call site still reads process.env live, matching
  // the documented test-reload pattern (A2-1513 / A2-1812 resolution
  // notes) used by the sibling EMAIL_* vars: zod validates at boot,
  // runtime reads stay live so tests can mutate process.env and reset
  // the cached provider.
  EMAIL_REPLY_TO_ADDRESS: z.string().email().optional(),

  // Network passphrase for payout signing. PUBLIC mainnet is the
  // default; operators override with TESTNET string for staging.
  // Anything non-empty is accepted so a self-hosted network can
  // set its own passphrase.
  LOOP_STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .default('Public Global Stellar Network ; September 2015'),

  // A2-1513: Horizon base URL for all payment-watcher / balance /
  // circulation reads AND the payout-worker submit. Previously every
  // consumer did `process.env['LOOP_STELLAR_HORIZON_URL']` directly,
  // bypassing the env.ts zod layer — a typo in the URL (missing
  // https://, trailing slash, etc.) only surfaced on the first
  // Horizon call rather than at boot. Moved into the zod schema so
  // a malformed URL fails `parseEnv()` at startup.
  LOOP_STELLAR_HORIZON_URL: z.string().url().default('https://horizon.stellar.org'),

  // A2-1812: price-feed + operator-pool bypass fix. These three
  // were previously read via `process.env[...]` in `payments/price-feed.ts`
  // and `ctx/operator-pool.ts` with no zod schema — a malformed URL
  // or malformed JSON only surfaced at first use (mid-request). Moved
  // into the schema so boot catches them. Callers still read from
  // `process.env` directly at their call sites — that's the
  // documented test-reload pattern (A2-1513 resolution notes) where
  // a test mutates `process.env[...]` and expects the next read to
  // pick the mutation up. Zod validates at boot; runtime reads stay
  // live.
  //
  // `CTX_OPERATOR_POOL` is a JSON-encoded array of
  // `{ id, bearer }` objects (ADR 013). Left as `string` here — the
  // full JSON-shape validation lives in `operator-pool.ts::loadOperators`
  // where a good error message is easier to produce.
  LOOP_XLM_PRICE_FEED_URL: z.string().url().optional(),
  LOOP_FX_FEED_URL: z.string().url().optional(),
  CTX_OPERATOR_POOL: z.string().min(1).optional(),

  // Payout-worker tick interval (seconds). 30s matches ADR 016's
  // recommended pacing — the worker is slower than the watcher
  // (10s) or procurement (5s) because each payout is a Stellar
  // submit + ledger-close (~5s) and parallelism on the operator
  // account is unsafe (sequence numbers serialise).
  LOOP_PAYOUT_WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  // R3-5: upper-band sanity check for CTX's SEP-7 settlement amount.
  // Before paying CTX, procurement compares the URI amount against
  // the order's expected wholesale XLM quote. Default 12_500 bps =
  // 125%, leaving room for ordinary FX/oracle movement while refusing
  // obvious CTX mispricing / tampered payment URLs. Exact lower-bound
  // checking is intentionally omitted: an under-quoted CTX URI is not
  // a treasury-loss vector and CTX owns its own requested amount.
  LOOP_CTX_PAYMENT_MAX_BPS_OF_EXPECTED: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(100_000)
    .default(12_500),

  // Max auto-retry attempts before a row promotes from transient
  // failure to terminal `failed`. ADR 016 default 5.
  LOOP_PAYOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // A2-602 watchdog: rows stuck in `submitted` for longer than this
  // (seconds) are re-picked by the worker. The idempotency pre-check
  // converges them to `confirmed` if the prior submit actually landed;
  // otherwise a fresh submit is issued with a new sequence number.
  // Default 300s (5m) — a well-behaved Horizon close is ~5s, so five
  // minutes is well outside the normal submit→seal window while still
  // short enough that a crash-loop doesn't silently eat payouts.
  LOOP_PAYOUT_WATCHDOG_STALE_SECONDS: z.coerce.number().int().positive().default(300),

  // A2-1921 fee-bump strategy. Under Stellar network congestion the
  // SDK default `BASE_FEE` (100 stroops) gets out-bid by user-side
  // traffic and the tx returns `tx_insufficient_fee`. The worker now
  // scales the fee per-attempt so a congested period drains naturally:
  //   attempt 1 → BASE
  //   attempt 2 → BASE * MULTIPLIER
  //   attempt 3 → BASE * MULTIPLIER^2
  //   …capped at CAP
  // Defaults: 100 → 200 → 400 → 800 → 1600 stroops at MULTIPLIER=2,
  // CAP=100_000 (any single payout is well under $0.001 of fee even
  // at the cap, so this is cheap insurance against a stuck row).
  LOOP_PAYOUT_FEE_BASE_STROOPS: z.coerce.number().int().positive().default(100),
  LOOP_PAYOUT_FEE_CAP_STROOPS: z.coerce.number().int().positive().default(100_000),
  LOOP_PAYOUT_FEE_MULTIPLIER: z.coerce.number().positive().default(2),

  // Feature flag for the Loop-native order workers (ADR 010). When
  // true at boot, the backend starts the payment watcher and
  // procurement worker intervals. Default false — workers are opt-in
  // per deployment so a fresh clone doesn't start hitting Horizon /
  // CTX pre-configuration.
  LOOP_WORKERS_ENABLED: envBoolean.default(false),

  // ADR 031 §Detailed design D9: vault-subsystem master switch for the
  // LOOPUSD/LOOPEUR DeFindex-vault path (V1 foundation — schema +
  // read layer only, no Soroban client / emission / withdraw logic
  // yet). Distinct from `LOOP_PHASE_1_ONLY`, which gates the
  // user-facing cashback/wallet surface generally — this flag gates
  // the vault subsystem specifically, so the read layer
  // (`credits/vaults/registry.ts`) stays a no-op even once
  // `loop_vaults` rows exist. Default false: an empty registry table
  // + this flag off is byte-identical to pre-migration.
  LOOP_VAULTS_ENABLED: envBoolean.default(false),

  // ADR 031 §Detailed design D2/D9, V2 (Soroban vault client). Soroban
  // RPC endpoint the vault client (`credits/vaults/vault-client.ts`)
  // uses for account loads, `simulateTransaction` /
  // `prepareTransaction` / `sendTransaction` / `getTransaction` —
  // distinct from `LOOP_STELLAR_HORIZON_URL` (Horizon is a classic-
  // ledger REST API; Soroban RPC is a separate JSON-RPC endpoint,
  // even on the same network). Nullable — the cross-field check below
  // requires it only when `LOOP_VAULTS_ENABLED=true` (mirrors the
  // `LOOP_WALLET_PROVIDER=privy` → `PRIVY_APP_ID`/`PRIVY_APP_SECRET`
  // pattern), so a deployment that never flips the vault flag doesn't
  // need to configure Soroban RPC at all.
  LOOP_SOROBAN_RPC_URL: z.string().url().optional(),

  // Hardening A6: auto-refund late deposits. A deposit that lands just
  // after its order expires is recorded + abandoned; an operator can
  // always refund it to the sender via
  // `POST /api/admin/deposits/:paymentId/refund` (step-up gated). When
  // this is `true` (and the operator Stellar signer is configured), the
  // skip-sweep ALSO refunds such `order_gone` late deposits
  // automatically the moment they're abandoned — same
  // `refundDeposit()` path, same idempotency, no button press. Default
  // false (admin-triggered only). Read live (like the kill switches) so
  // flipping it takes effect on the next sweep without a redeploy.
  LOOP_DEPOSIT_REFUND_AUTO: envBoolean.default(false),

  // A2-1907: runtime kill switches. Setting any of these to `true` on
  // a running deployment makes the matching surface return 503
  // SUBSYSTEM_DISABLED without redeploying. Toggle via:
  //   `fly secrets set LOOP_KILL_<NAME>=true -a loopfinance-api`
  // The Fly secret-set triggers a rolling restart picking up the new
  // value. Default false on every switch — fail-open posture, no
  // surprise blackout if an env var is mis-set.
  LOOP_KILL_ORDERS: envBoolean.default(false),
  // Per-path order switches (comprehensive-audit 2026-06-11, P10):
  // when set they override LOOP_KILL_ORDERS for their path; when
  // UNSET they fall back to it — fully backward compatible. No
  // `.default(false)` on purpose: the unset/false distinction is the
  // fallback semantic (kill-switches.ts reads process.env directly;
  // these entries exist for validation + .env.example parity).
  LOOP_KILL_ORDERS_LEGACY: envBoolean.optional(),
  LOOP_KILL_ORDERS_LOOP: envBoolean.optional(),
  LOOP_KILL_AUTH: envBoolean.default(false),
  // Pre-ADR-036 name: LOOP_KILL_WITHDRAWALS (renamed with the
  // withdrawal→emission re-scope; gates admin emissions + the
  // payout-compensation endpoint).
  LOOP_KILL_EMISSIONS: envBoolean.default(false),

  // Worker tick intervals (seconds). Defaults tuned for a moderate
  // order volume: watcher every 10s to keep deposit latency low;
  // procurement every 5s since a paid order is user-blocking until
  // the gift card arrives.
  LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  LOOP_PROCUREMENT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),

  // Asset-drift watcher (ADR 015). 300s (5m) default — drift is an
  // accounting metric, not latency-sensitive; paging the monitoring
  // channel faster than that would just generate noise from
  // in-flight payouts.
  LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

  // Threshold in stroops at which a non-zero drift pages ops. 1e8
  // stroops = 10 whole LOOP units = $10 of over/under-mint for the
  // USD asset. Leaves room for normal in-flight payout drift (a
  // queue of say 20 × $5 cashbacks still fits) while catching
  // real accounting divergence.
  LOOP_ASSET_DRIFT_THRESHOLD_STROOPS: z.coerce.bigint().nonnegative().default(100_000_000n),

  // R3-1: operator XLM/USDC float reconciliation. This is a historical
  // conservation check over the deposit/operator wallet from an
  // operator-created baseline. XLM gets a wider default tolerance for
  // Stellar fees; USDC should be exact unless an approved manual
  // movement explains the difference.
  LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS: z.coerce.bigint().nonnegative().default(10_000_000n),
  LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS: z.coerce.bigint().nonnegative().default(1n),

  // ADR 030 Phase B: provider-agnostic embedded-wallet substrate.
  // '' (default) → the wallet layer is OFF: `getWalletProvider()`
  // returns null and no vendor code path is reachable. 'privy' →
  // the Privy REST adapter is active and PRIVY_APP_ID +
  // PRIVY_APP_SECRET become required (cross-field check in
  // `parseEnv` below). Nothing user-facing consumes this in Phase B
  // — it is the substrate Phase C wires into flows.
  LOOP_WALLET_PROVIDER: z.enum(['', 'privy']).default(''),

  // Privy app credentials (ADR 030). Used as HTTP Basic auth
  // (`PRIVY_APP_ID:PRIVY_APP_SECRET`) plus the `privy-app-id` header
  // on every Privy REST call. The secret is never logged (pino
  // redaction paths cover PRIVY_APP_SECRET). Both required iff
  // LOOP_WALLET_PROVIDER=privy; ignored otherwise.
  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),

  // A2-905 / ADR 009: interest accrual on user credit balances.
  // Off by default (0 bps) — ADR 009 explicitly feature-flags this
  // "until counsel confirms the framing of interest on promotional
  // credits in each target market." Switching on requires setting
  // INTEREST_APY_BASIS_POINTS > 0 AND LOOP_WORKERS_ENABLED=true.
  // APY in integer basis points (400 = 4.00%); periodsPerYear is
  // the denominator the primitive divides the annual rate by (365
  // for daily, 12 for monthly, 52 for weekly). Tick interval is the
  // scheduler cadence — kept independent from periodsPerYear so a
  // deploy that wants nightly accrual on the first UTC day after
  // boot (periodsPerYear=365) can still tick hourly and rely on the
  // per-cursor idempotency to no-op the duplicates.
  INTEREST_APY_BASIS_POINTS: z.coerce.number().int().min(0).max(10_000).default(0),
  INTEREST_PERIODS_PER_YEAR: z.coerce.number().int().positive().default(365),
  INTEREST_TICK_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // CF-26 / X-PRIV-07/08: auth-row retention purge. Periodic sweep
  // (gated with the other workers on LOOP_WORKERS_ENABLED) that deletes
  // expired/consumed OTP rows and dead (expired or long-revoked)
  // refresh-token rows past the retention grace. Both tables hold PII
  // (email / token hash) with no lawful basis to retain dead rows. The
  // interval is hourly by default — retention hygiene is not latency-
  // sensitive. The retention window defaults to 30 days, comfortably
  // past the refresh horizon so a live session is never reaped, and
  // long enough that the token-theft reuse signal (A2-1608) and the
  // just-expired-OTP 401 edge stay intact.
  LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),

  // Hardening C1 (2026-07 plan): cadence of the ledger-invariant
  // watcher — the scheduled check that user_credits.balance_minor
  // still equals SUM(credit_transactions) per (user, currency), paging
  // Discord while any drift persists. Full-table aggregate, so daily
  // by default; the check single-flights across machines via an
  // advisory lock. Runs under LOOP_WORKERS_ENABLED.
  LOOP_LEDGER_INVARIANT_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  LOOP_AUTH_ROW_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // ADR 031 §Detailed design D4, V5: vault drift + solvency watcher
  // (`credits/vaults/vault-drift-watcher.ts`) — the Soroban
  // LOOPUSD/LOOPEUR twin of the classic asset-drift watcher above.
  // 300s (5m) default, same cadence reasoning: an accounting metric,
  // not latency-sensitive. Runs under LOOP_WORKERS_ENABLED AND
  // LOOP_VAULTS_ENABLED (checked inside the tick — an unstarted
  // watcher with vaults off is consistent, not merely inert).
  LOOP_VAULT_DRIFT_WATCHER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),

  // INV-V1 threshold, in the vault share token's 7-decimal smallest
  // unit (same convention as LOOP-asset stroops). 1e8 = 10 whole
  // shares — mirrors LOOP_ASSET_DRIFT_THRESHOLD_STROOPS's default
  // reasoning: room for a handful of in-flight emissions/redemptions
  // without paging on normal queue depth.
  LOOP_VAULT_DRIFT_SHARES_THRESHOLD_STROOPS: z.coerce.bigint().nonnegative().default(100_000_000n),

  // INV-V2 threshold, in the vault's underlying-asset 7-decimal
  // smallest unit. 1e8 = $10 of tolerance on user-share value vs
  // vault-redeemable backing + hot float — same default as the
  // classic asset-drift threshold for consistency.
  LOOP_VAULT_DRIFT_SOLVENCY_THRESHOLD_STROOPS: z.coerce
    .bigint()
    .nonnegative()
    .default(100_000_000n),

  // ADR 031 §Detailed design D4, V5: vault-aware hot-float
  // reconciliation (`treasury/hot-float-reconciliation.ts`) — checks
  // the operator's actual on-chain vault-share balance against what
  // the emission/redemption bookkeeping (`vault_hot_float
  // .pending_unredeemed_shares` + in-flight `vault_emissions
  // 'deposited'` rows) says it should be holding, catching the V4-
  // accepted slow-withdraw-race / phantom-share residual
  // (`docs/invariants.md`'s "Known residual (NOT self-correcting)"
  // under Vault redemptions). Daily default, matching R3-1's cadence
  // (an accounting reconciliation, not latency-sensitive). Runs under
  // LOOP_WORKERS_ENABLED AND LOOP_VAULTS_ENABLED.
  LOOP_VAULT_FLOAT_RECONCILIATION_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // Share-count tolerance for the float/pool desync check above, same
  // 7-decimal share-token unit as LOOP_VAULT_DRIFT_SHARES_THRESHOLD_STROOPS.
  // Tighter than the drift watcher's threshold (1e6 = 0.1 share)
  // because this check compares two figures that should track exactly
  // in normal operation (no in-flight emission/redemption window to
  // absorb) — see the module header for why a gap here is meaningful.
  LOOP_VAULT_FLOAT_SHARES_THRESHOLD_STROOPS: z.coerce.bigint().nonnegative().default(1_000_000n),
};
