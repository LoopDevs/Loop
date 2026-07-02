# Wallet integration plan (ADR 030 / ADR 036) — working doc

> Implementation companion to ADR 030 (Privy embedded wallet) and ADR 036 (token lifecycle).
> Phases A/B are in flight; this doc pins the design for C/D so review happens before code.
> Delete or fold into the ADRs once the build completes.

## Phase map

| Phase | Scope                                                                                                                             | Status                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A     | RS256 + `kid` token signing, `/.well-known/jwks.json`, dual-verify window, rotation runbook                                       | building                                                          |
| B     | `WalletProvider` interface, Privy REST adapter (fetch+Zod), rawSign→decorated-signature bridge, `users.wallet_provider/wallet_id` | building                                                          |
| C     | Provisioning + payout targeting + one-tap redemption + balance surface                                                            | built — `feat/wallet-phase-c-flows` (backend; web wiring pending) |
| D     | Nightly on-chain interest mints (midnight UTC, APR/365)                                                                           | built — `feat/wallet-phase-d-interest` (see notes below)          |

## Phase C — flows

### C1. Provisioning (signup + backfill)

On native signup (verify-otp success, social login) when `LOOP_WALLET_PROVIDER=privy`:

1. `provider.createWallet(userId)` → `{ walletId, address }` persisted to `users`.
2. **Account activation, operator-sponsored** so the user never funds reserves:
   one transaction, source = operator account:
   - `beginSponsoringFutureReserves(sponsored: address)`
   - `createAccount(destination: address, startingBalance: '0')`
   - `changeTrust` for GBPLOOP (and any other configured LOOP asset) — **source: the user
     account**, so the envelope needs both signatures: operator (local keypair) + user
     (provider rawSign via the Phase-B bridge).
   - `endSponsoringFutureReserves` (source: user account — also covered by the user signature).
     The whole thing is atomic: account exists with trustlines and zero XLM, all reserves on
     the operator. (Alternative considered: fund 1.5 XLM instead of sponsorship — rejected,
     leaks reserve XLM per user and the user could spend it.)
3. Idempotent + fault-tolerant: a `wallet_provisioning` state on the user
   (`none → wallet_created → activated`) re-driven by a small sweeper (same pattern as the
   redemption backfill: attempts + backoff + Discord alert on exhaustion). Signup must NOT
   block on Stellar: provisioning runs async post-signup; the user can browse/buy
   immediately — only payout needs the wallet, and the payout queue already waits.
4. Backfill job: existing users (have `user_credits`, no wallet) provisioned in batches by
   the same sweeper. Their queued/pending payouts then drain naturally (C2).

### C2. Payout targeting

`credits/payout-builder.ts` today requires a user-linked `stellarAddress`. Change: destination
resolution order = embedded wallet address (when provisioned+activated) → legacy linked
address → skip (unchanged). No other payout semantics change — emission/burn/skip machinery
from ADR 036 applies as-is. The A4-023 peg-break skip also unchanged.

### C3. One-tap "pay with Loop balance"

New order payment path (web sends `paymentMethod: 'loop_asset'` exactly as today — no API
shape change):

1. Order created as today (`pending_payment`, memo issued).
2. NEW: `POST /api/orders/loop/:id/pay-with-balance` (authed, rate-limited, idempotent on
   order id): server builds a payment tx — source: user's embedded wallet, destination:
   deposit address, asset: the matching LOOP asset, amount: `chargeMinor`, memo: the order's
   payment memo; fee-bump or sponsor the fee from the operator (user holds zero XLM —
   use a fee-bump transaction wrapped by the operator, which the repo's A2-1921 fee-bump
   vars already anticipate). User inner-tx signed via rawSign; fee-bump signed by operator.
3. Submit through the Phase-B bridge → **everything downstream is the existing pipeline**:
   the deposit watcher matches the memo, `markOrderPaid` debits the mirror + enqueues the
   issuer burn (#1424), skip-table catches any transient failure. No new ledger semantics.
4. Endpoint returns `{ state }`; web polls the order as it already does for crypto payments.
   Balance check up front: read on-chain balance (horizon-balances, 30s cache) and 400
   `INSUFFICIENT_BALANCE` early for honest UX; the authoritative check is still the watcher's.

### C4. Balance surface

`GET /api/me/wallet` → `{ address, provisioning, balances: [{ assetCode, balance }],
interestApyBps }` — on-chain read via the cached horizon-balances client; never-500 with
last-known-good (ADR 020 discipline, but authed). Web: wallet card on home/account showing
GBPLOOP balance (authoritative, per ADR 036) with the mirror nowhere user-visible; "pay with
balance" button on checkout when balance covers the charge.

## Phase D — nightly interest mints (replaces off-chain accrual)

Worker at 00:00 UTC (gated `LOOP_INTEREST_ONCHAIN_ENABLED` + issuer secret configured):

1. Eligible set: users with activated wallets holding > 0 GBPLOOP at the snapshot (read via
   Horizon; an indexed snapshot table keeps the run idempotent and auditable).
2. Mint = `balance × (apyBps / 10000) / 365`, floored to 7 decimals; one payment from the
   **issuer** account per user (issuer payment = mint on Stellar).
3. Mirror credit (`credit_transactions type='interest'`, existing period-cursor partial
   unique index makes it idempotent per (user, currency, night)) in the SAME logical
   operation: write ledger row first with the planned amount, then submit the mint through
   the payout queue (new `kind='interest_mint'`), so a crash re-drives from the queue and
   the cursor blocks double-credit.
4. Drift watcher: interest mints increase on-chain supply AND the mirror equally → already
   neutral under the #1424 equation; remove the TODO(ADR-031) comment with a test.
5. The legacy off-chain `accrue-interest.ts` path is retired (or hard-gated off) in the same
   PR — two interest writers must never coexist.

Open per ADR 036 Q4: interest on earned-but-not-yet-emitted balance — Phase D ships
holders-only first (matches "whilst they have loop tokens"); revisit with ADR 031.

### Phase D — as built (ADR 031 implementation notes)

Gate: `LOOP_INTEREST_ONCHAIN_ENABLED=true` + `INTEREST_APY_BASIS_POINTS > 0` +
≥ 1 `LOOP_STELLAR_<ASSET>_ISSUER_SECRET` (boot-validated by `parseEnv` against the
configured issuer address via Keypair derivation) + `LOOP_WORKERS_ENABLED`.

1. **Worker** `credits/interest-mint.ts` — tick-based (10-min interval, NOT wall-clock
   cron); the period key is the current UTC date (`YYYY-MM-DD`) and a
   `watcher_cursors` row (`name='interest_mint'`) records the last completed period,
   so a process down across midnight self-heals on its first tick. A _fully missed_
   UTC day is deliberately not retro-minted (no balance snapshot exists for it) —
   the gap logs loudly; compensate via admin emission if required.
2. **Eligibility**: `wallet_provisioning='activated'` + > 0 on-chain balance of an
   asset with a validated issuer signer (Horizon trustline read). Each eligible
   holder gets one `interest_mint_snapshots` row per night (migration 0041) — the
   audit record of the balance the mint was computed from AND the idempotency fence.
3. **Sub-minor carry (deviation from the original "mint the 7-decimal accrual"
   sketch)**: the accrual `floor(balance × apyBps / (10_000 × 365))` is computed in
   stroops (7 decimals, dust < 1 stroop skipped), but the `user_credits` mirror is
   integer minor units — minting raw stroops would diverge the drift equation
   monotonically. The payable therefore floors to whole minor units with the
   remainder carried per (user, asset) in the snapshot chain
   (`carry + accrual = minted×1e5 + carryAfter`, DB CHECK-enforced). Mint and
   mirror credit are always exactly equal; small balances accumulate sub-penny
   accruals until they cross a penny.
4. **Atomicity (ADR 036 §3)**: one DB txn per user writes snapshot +
   `credit_transactions type='interest'` (period-cursor partial unique = second
   fence) + `user_credits` bump + `pending_payouts kind='interest_mint'`. The payout
   worker drives the on-chain mint with the existing retry/classify machinery,
   signing `interest_mint` rows with the **issuer** keypair (issuer payment = native
   mint) and running the idempotency pre-check against the issuer's history; all
   other kinds keep the operator path byte-identical.
5. **Legacy retirement**: `accrue-interest.ts` / `interest-scheduler.ts` are
   structurally never started while the flag is on (`index.ts` branches), and
   `startInterestScheduler` additionally hard-throws on the flag — two interest
   writers can never coexist. The interest forward-mint pool watcher is also not
   started on the on-chain branch (the pool is a legacy-path construct; its drift
   term reads zero here and retires when the legacy path is deleted).
6. **Drift watcher**: equation is now
   `drift = onChain − pool − inFlightBurns + inFlightInterestMints − mirror × 1e5` —
   in-flight mints are on the mirror but not yet on-chain, so they ADD to the
   circulation side (mirror image of the burn term); all three states
   (queued/submitted/confirmed) are drift-neutral and a mirror credit with no queued
   mint still pages (that is the alert this term must not mask).
7. **`GET /api/me/wallet`** reports `interestApyBps` only while the on-chain path is
   enabled (the surface shows on-chain balances; legacy mirror-only accrual is not
   advertised). Mint payout failures ride the existing `notifyPayoutFailed` alert →
   `docs/runbooks/payout-failed-alert.md` (no new alert).
8. **Testnet walk** `apps/backend/src/scripts/wallet-testnet-walk.ts`
   (`npm run walk:wallet-testnet -w @loop/backend`) — the pre-staging gate:
   provision → sponsored activation → emission → pay-with-balance redemption →
   watcher tick (mirror debit + burn) → interest-mint tick → issuer-signed mint
   confirm, with a PASS/FAIL report. Required env is documented at the top of the
   script (testnet operator/issuer secrets, real Privy creds, scratch DATABASE_URL).

## Operator setup (Ash) — Privy dashboard

1. Create the Privy app → `PRIVY_APP_ID` / `PRIVY_APP_SECRET` → Fly secrets (staging first).
2. Enable Stellar wallets for the app (Tier 2 chains panel).
3. Custom auth: JWT-based auth → JWKS URL `https://api.loopfinance.io/.well-known/jwks.json`
   (Phase A must be deployed first), user-id claim `sub`.
4. Business DD: ToS jurisdiction coverage (US/EU/UK/CA), pricing tier, counsel review →
   flips ADR 030 to Accepted.

## Test/rollout strategy

- Everything is feature-flagged (`LOOP_WALLET_PROVIDER`) and testable with mocked transport +
  real-ed25519 local signing; first real-credential validation on **testnet** (operator +
  issuer test accounts) via a scripted walk: provision → activate → payout → pay-with-balance
  → burn → interest mint; then staging with real Privy app; then production behind the flag.
- The e2e-real workflow gains a wallet leg only after staging soak.

## Live API verification (2026-06-11, real credentials)

Smoke-tested against the production Privy API with the real app (id `cmqa2j21n00ie0cic2wabbf72`;
secret in git-ignored `apps/backend/.env`, to be rotated before launch):

- `POST https://api.privy.io/v1/wallets` — basic auth `appId:appSecret` + `privy-app-id` header,
  body `{"chain_type":"stellar"}` → created wallet `w339r5i971n9o6nv0ck7uk4o`, address
  `GBC7MYWRWMVM5IKSS7Z236RYXF75PRJBKS52M3S5TQEE5CVBI6IPLVYX`. Response:
  `{id, address, public_key (hex, 00-prefixed), chain_type, policy_ids, additional_signers,
exported_at, imported_at, created_at, owner_id}` — `owner_id` null when created unlinked.
- `POST /v1/wallets/:id/raw_sign` — body `{"params":{"hash":"0x<64-hex>"}}` → response
  `{"method":"raw_sign","data":{"signature":"0x<128-hex>","encoding":"hex"}}`.
- Signature verified locally: `Keypair.fromPublicKey(address).verify(hash, sig) === true`.
- Privy's own JWKS (reverse direction, if Loop ever verifies Privy-issued tokens):
  `https://auth.privy.io/api/v1/apps/cmqa2j21n00ie0cic2wabbf72/jwks.json`.

Remaining dashboard config (after Phase A deploys): JWT-based custom auth →
`https://api.loopfinance.io/.well-known/jwks.json`, user-id claim `sub`.
