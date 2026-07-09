# AUDIT-2 Adversarial Money/Auth Sweep

Date: 2026-07-09

## Executive Summary

**Scope:** Five domains on the money/auth critical path, read-only —
`credits/`, `payments/`, `orders/`, `wallet/` + `stellar/`, and `auth/`.

**Method:** Five parallel adversarial reviews (`money-reviewer` /
`auth-reviewer` subagents, one per domain, refute-first) anchored on
`docs/invariants.md` (which invariant does this diff/path preserve, and
does any code path silently demote a DB/test tier down to convention?)
and `docs/threat-model.md` (is this a known accepted-risk tradeoff or an
unregistered gap?). Each reviewer worked its domain independently with no
visibility into the others' findings; this document is the lead synthesis
— cross-domain corroboration is called out explicitly where it happened.

**Headline result:** 5 P1s, 0 P0s confirmed in-tree. The most serious
finding (A — USDC deposit matching accepts any-issuer USDC when
`LOOP_STELLAR_USDC_ISSUER` is unset) was **found independently by two
reviewers** (payments and wallet) working different domains, which is the
strongest confidence signal a synthesis pass can get without a live
production check. It is provisionally P1 because production's own
preflight gate (`scripts/preflight-tranche-1.sh`) requires the secret —
but nothing in the deployed boot path enforces that at runtime, so it
escalates to P0 the moment the secret is confirmed unset in production
(operator verification needed; flagged below, not resolved here). None of
the five is a live double-spend or fund-loss bug with a known trigger
today; each is a structural gap that either (a) has no gate at all where
one is assumed to exist, or (b) degrades reliability/observability rather
than money-safety. The state-machine core — order transitions, payout/
refund issuance, LOOP-asset issuer pinning, and the bulk of the auth
surface — held up well under adversarial review; see **Clean areas**
below.

---

## Findings Table

| ID  | Severity                            | Domain                                      | Finding                                                                                                                                                                                                                                     | Key refs                                                                                                                                                          |
| --- | ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | P1 (→P0 if confirmed unset in prod) | payments + wallet (independent double-find) | Any-issuer USDC accepted as a valid deposit when `LOOP_STELLAR_USDC_ISSUER` is unset                                                                                                                                                        | `payments/watcher.ts:166-170`, `payments/horizon.ts:191-213` (211), `payments/amount-sufficient.ts:99-119`, `env.ts:112-129`, `scripts/preflight-tranche-1.sh:43` |
| B   | P1 (LIVE-RISK)                      | orders                                      | `loop_asset` payment method has no server-side Phase-1 gate                                                                                                                                                                                 | `orders/loop-handler.ts`, `orders/redeem.ts`, `orders/transitions.ts:73-211`, `credits/emissions.ts:342-347`, `fly.toml`                                          |
| C   | P1                                  | payments                                    | Deposit watcher silently drops `no_match`/`no_memo` payments — no skip record                                                                                                                                                               | `payments/watcher.ts:192,207-208,438-441`, `payments/horizon.ts:199,203-204`, `docs/audit-2026-06-30-cold/raw/v-payments.md`                                      |
| D   | P1                                  | credits                                     | Interest-mint idempotency-skip catch never matches the real error shape                                                                                                                                                                     | `credits/interest-mint.ts:324-337`, `credits/accrue-interest.ts:183-201`, contrast `credits/refunds.ts:502-515`, `credits/emissions.ts:378-388`                   |
| E   | P1                                  | auth                                        | `/__test__/mint-loop-token` has no defense-in-depth beyond `NODE_ENV`                                                                                                                                                                       | `apps/backend/src/test-endpoints.ts`, `apps/backend/src/app.ts:127-129`, `Dockerfile`, `fly.toml`                                                                 |
| P2  | P2                                  | orders                                      | `sweepStuckProcurement` not S4-8 single-flighted (row-lock-partitioned, efficiency only); R3-10 idempotency-window residual missing from threat-model register; `loop-create-response.ts:160-169` "fail-open" comment is actually fail-safe | see detail                                                                                                                                                        |
| P2  | P2                                  | credits                                     | Conservation trigger (migration 0044) integration-tested only for `kind='emission'`; advisory-lock acquisition order in `emissions.ts` is a documented, fragile-by-convention landmine                                                      | see detail                                                                                                                                                        |
| P2  | P2                                  | wallet                                      | `enqueueWalletProvisioning` fire-and-forget races the sweeper lock but is self-healing                                                                                                                                                      | see detail                                                                                                                                                        |

---

## Findings — Detail

### A. USDC deposit matching accepts any-issuer USDC when `LOOP_STELLAR_USDC_ISSUER` is unset

**Severity:** P1, escalates to P0 if the operator confirms the secret is
unset in production today (not verified in this read-only sweep — flagged
for operator follow-up).

**Independently found by two reviewers** (payments domain and wallet
domain), which is the strongest confidence signal in this sweep.

`watcher.ts:166-170` builds the USDC match options and only includes
`assetIssuer` when `args.usdcIssuer !== undefined`:

```ts
const matchesUsdc = isMatchingIncomingPayment(p, {
  account: args.account,
  assetCode: 'USDC',
  ...(args.usdcIssuer !== undefined ? { assetIssuer: args.usdcIssuer } : {}),
});
```

`horizon.ts:191-213` implements the match, and line 211 is the vacuous-true
issuer clause:

```ts
opts.assetIssuer === undefined || p.asset_issuer === opts.assetIssuer;
```

When `LOOP_STELLAR_USDC_ISSUER` is unset, `opts.assetIssuer` is `undefined`,
so this clause is always true — **any** credit-alphanum asset code `USDC`
from **any** issuer matches, including one an attacker self-issues for
free. `amount-sufficient.ts:99-119` then does an amount-only check with no
identity re-check — it validates the _quantity_ of the payment against the
oracle-converted charge amount, never the issuer.

Contrast `credits/payout-asset.ts:73-84`, which gets this exactly right for
the analogous LOOP-asset case and says so in the comment: `configuredLoopPayableAssets()`
skips any currency whose issuer isn't configured, "because we can't sanely
asset-match a LOOP asset without pinning its issuer — an attacker could
issue a fake 'USDLOOP' asset from a different account otherwise." The USDC
path has the identical attack shape and no equivalent guard.

**Boot-time posture makes this worse, not better.** `env.ts:112-129` only
warns — and only when the value is _present but wrong_ (differs from
Circle's canonical mainnet issuer on mainnet). When the value is _absent_,
there is no warning at all; boot succeeds silently. The only place that
actually requires the secret is `scripts/preflight-tranche-1.sh:43`, an
operator-run shell script gating `flyctl deploy`, not a runtime or boot
guard. This is exactly the failure shape INV-12 ("config that looks wired
is actually wired") exists to catch: `LOOP_STELLAR_USDC_ISSUER` is
referenced throughout the codebase, has a preflight check, and has a
boot-time warning path — so it reads as enforced — but the one thing that
actually matters (does the watcher reject a payment from an unpinned
issuer) is unguarded.

**Scenario:** an attacker mints a free self-issued Stellar asset with code
`USDC`, pays a real order's deposit address with it, the watcher matches
it as a legitimate USDC deposit, `markOrderPaid` fires, and Loop procures a
real gift card — paying real operator XLM/USDC to CTX — against worthless
self-issued tokens.

**Fix direction:** two independent layers, don't rely on either alone.
(1) `env.ts` production boot-fail when `LOOP_STELLAR_USDC_ISSUER` is unset
and the USDC payment method is reachable — same pattern as the existing
`LOOP_ADMIN_STEP_UP_SIGNING_KEY` production cross-field guard at
`env.ts:293-297`. (2) Default to Circle's canonical mainnet issuer
(`CANONICAL_MAINNET_USDC_ISSUER`, already defined in `env.ts` for the
mismatch-warning check) when the passphrase is mainnet and the var is
unset, rather than falling through to "accept anything."

**Operator action required:** confirm whether `LOOP_STELLAR_USDC_ISSUER`
is actually set in the production Fly secrets today. If it is set, this is
a P1 hardening gap (defense-in-depth missing, no live exposure). If it is
unset, USDC orders are live-exploitable right now and this is a P0
requiring an out-of-band fix ahead of the next normal PR cycle.

**Maps to:** existing `docs/go-live-plan.md` T1-C ("USDC-issuer secret
re-set") operator action, plus a new engineering item below.

---

### B. `loop_asset` payment method has no server-side Phase-1 gate (LIVE-RISK)

**Severity:** P1, LIVE-RISK (matches `docs/readiness-backlog-2026-07-03.md`
Tier 12 verbatim — this sweep confirms and scopes it, does not newly
discover it).

`orders/loop-handler.ts` has no `LOOP_PHASE_1_ONLY` check anywhere in the
order-create path. Contrast the `credit` payment method, which is
correctly gated at ~404-420 (`CREDIT_METHOD_RETIRED` once a wallet is
activated) — `loop_asset` gets no equivalent phase gate at all.
`orders/redeem.ts` gates `loop_asset` redemption only on
`getWalletProvider() !== null` and `user.walletProvisioning === 'activated'`
(lines ~233-276) — never on `LOOP_PHASE_1_ONLY`. `orders/transitions.ts:73-211`
(`markOrderPaid`'s `loop_asset` debit branch) has no phase check either —
it extinguishes the off-chain mirror liability against on-chain LOOP-asset
funding unconditionally. `credits/emissions.ts:342-347` (admin emission
insert) mints real on-chain LOOP independent of the flag as well.

`fly.toml` confirms `LOOP_WORKERS_ENABLED = "true"` and
`LOOP_PHASE_1_ONLY = "true"` coexist in production today. So the flag that
is supposed to hide every Phase 2+ surface (per its `AGENTS.md`
description: "hides cashback links, /settings/wallet, /settings/cashback,
/cashback, onboarding currency picker + wallet-intro, 'you've earned X'
copy") does not gate the `loop_asset` payment/redemption code paths at
all — it is UI-only for this specific method.

**What's actually holding the line today is incidental, not structural:**
zero users have a provisioned wallet with a nonzero on-chain LOOP balance
(the wallet-provisioning flow itself is Phase 2 UI, hidden client-side),
and the client never renders a `loop_asset` order-create affordance. Any
direct API caller who already has (or acquires) wallet provisioning and a
LOOP balance can create and redeem a `loop_asset` order today, in
production, with `LOOP_PHASE_1_ONLY=true`.

**Fix direction:** add a structural `LOOP_PHASE_1_ONLY` check at
`loop_asset` order-create (`loop-handler.ts`, same shape as the
`credit`/`CREDIT_METHOD_RETIRED` gate) and at redemption
(`orders/redeem.ts`), returning a clear `PHASE_1_ONLY` rejection rather
than relying on absence-of-provisioned-users.

**Maps to:** `docs/readiness-backlog-2026-07-03.md` Tier 12 LIVE-RISK item
— this sweep narrows it to four concrete call sites and confirms the
`fly.toml` coexistence that makes it live, not theoretical.

---

### C. Deposit watcher silently drops `no_match`/`no_memo` payments

**Severity:** P1.

`watcher.ts`'s outcome switch (~430-441) has bare `break;` for both the
`no_match` and `no_memo` cases (~438-441 shown; `no_match` at 192 returns
before ever hitting a case that calls `recordSkip`). Neither case
increments a counter that reaches an operator-visible surface, and neither
calls `recordSkip` — so `/admin/skips` never learns these payments
existed. The Horizon cursor still advances past them (the watcher processes
strictly forward), so there is no automatic re-scan.

Root cause is in the match logic itself, `horizon.ts:199` (`p.type !==
'payment'` excludes path payments — `path_payment_strict_send` /
`path_payment_strict_receive` operations, which are a normal way for a
real user's wallet to fund a deposit when it auto-routes through the DEX)
and `:203-204` (`p.transaction?.memo_type !== 'text'` folded directly into
the asset-matching boolean, so a real payment with no memo or a non-text
memo type is indistinguishable from "wrong asset" — both just return
`false` and the caller can't tell which reason applied).

The **path-payment** case was previously flagged in
`docs/audit-2026-06-30-cold/raw/v-payments.md` (that finding's evidence:
`horizon.ts:199`, `watcher.ts:141-167`, and the observation that
`__tests__/horizon.test.ts` tests `create_account`/`account_merge`
exclusion explicitly but has no equivalent test for path payments) and is
**still open** — this sweep independently re-confirms it, unchanged. The
**memo-less / wrong-memo-type direct-payment** case (a real `type ===
'payment'` operation that fails only the memo check) is a new observation
from this sweep: it shares the same "silently dropped, no skip row" defect
but is a structurally distinct code path from the path-payment gap.

**Impact:** real value lands at Loop's custody Stellar account, gets no
database row of any kind, the cursor moves past it, and the user's order
expires in 24h with no recovery trail. `R3-1` (operator XLM/USDC float
reconciliation) is only partially wired in production per
`docs/money-auth-worklist.md` — so today there is no independent backstop
that would surface this class of stranded deposit either.

**Fix direction:** route any Horizon payment-op whose `to === depositAddress`
but that fails every rail-matching check into `recordSkip` with a new skip
reason (e.g. `unsupported_operation_type` for path payments,
`missing_or_wrong_memo_type` for the memo case) so both surface on
`/admin/skips` instead of vanishing. Extending the matcher to actually
accept path payments (per the 06-30 finding's "better fix") is a larger,
separate change; the skip-visibility fix is the minimum bar and should
land regardless.

---

### D. `interest-mint.ts` idempotency-skip catch never matches the real driver

**Severity:** P1 (reliability/observability, not money-safety — see below).

`credits/interest-mint.ts:324-337` classifies a caught error as "already
processed, skip" by string-matching `err.message`:

```ts
const message = err instanceof Error ? err.message : String(err);
if (
  message.includes('interest_mint_snapshots_user_asset_period_unique') ||
  message.includes('credit_transactions_interest_period_unique') ||
  message.includes('duplicate key value violates unique constraint')
) {
  return { outcome: 'skipped_already', mintedMinor: 0n };
}
throw err;
```

The same pattern exists in `credits/accrue-interest.ts:183-201` (P2 —
legacy, gated off under `LOOP_INTEREST_ONCHAIN_ENABLED`, listed here for
completeness).

This never matches in practice. Drizzle wraps the raw Postgres error in a
`DrizzleQueryError`, whose top-level `.message` is a fixed string —
`"Failed query: ..."` — not the underlying constraint-violation text. The
real Postgres error (code `23505`, `constraint_name` populated) lives on
`err.cause`, not on the top-level `err`. `credits/refunds.ts:502-515` and
`credits/emissions.ts:378-388` both document this exact wrapping behavior
in their own comments and correctly walk `err.cause` to extract
`code`/`constraint_name` — this is a known, already-solved problem
elsewhere in the same package that the interest-mint path didn't pick up.

**Effect:** after any crash or redeploy mid-sweep, re-processing users who
were already minted this period throws a real unique-violation that gets
misclassified as a fatal error (falls through to `throw err`) instead of
`skipped_already`. `writeMintCursor` is gated on `errors === 0`
(confirmed in the surrounding tick logic), so the cursor never advances —
the sweep re-scans and re-errors on the same already-minted users on every
retry until the period rolls over at midnight UTC. This is hours of
error-spam and a stalled cursor, not silent — Discord paging (ADR-038 D2)
will fire — but it burns the on-call's attention on a false-positive and
masks whether _new_ work is actually failing underneath the noise.

**Not a double-mint.** The DB unique constraint forces the transaction to
roll back before the catch block ever runs, so no money is actually
double-issued — this is a broken reliability/observability guarantee, not
a ledger-safety bug. The existing test suite gives false confidence here:
it mocks a plain `Error` with the matching substring at the top level,
never the `DrizzleQueryError`-wrapping shape that real Postgres unique
violations actually produce.

**Fix direction:** extract the `err.cause`-walking logic already correct
in `refunds.ts`/`emissions.ts` into a shared `isUniqueViolation(err,
constraintName?)` helper that checks `code === '23505'` (and optionally
`constraint_name`) on the cause chain, and use it in both
`interest-mint.ts` and `accrue-interest.ts`. Add a test that constructs
the real wrapped-error shape, not a flat `Error`.

---

### E. `/__test__/mint-loop-token` has no defense-in-depth beyond `NODE_ENV`

**Severity:** P1 (not reachable in production today, hence not P0 — see
below).

`apps/backend/src/test-endpoints.ts`, mounted from `app.ts:127-129` only
when `env.NODE_ENV === 'test'`, issues a full admin token pair for any
allowlisted email with **zero credential check** — no password, no OTP, no
shared secret. It exists to let the e2e/integration suites mint a session
without driving the real OTP flow, which is a reasonable test convenience,
but the only thing standing between "unauthenticated caller" and
"admin-session token pair" is a single environment-variable comparison.

This is not reachable in production today: `Dockerfile` and `fly.toml`
both hardcode `NODE_ENV=production`, so the route never mounts on the
deployed image. That's why this is P1, not P0. But it is a single
misconfiguration away from a real hole — a staging or preview deployment
that (deliberately or accidentally) runs with `NODE_ENV=test` to unlock
the test-only surface would expose unauthenticated admin-session minting
to anyone who can reach the app, with no second factor.

**Fix direction:** require a second, independent control even under
`NODE_ENV=test` — e.g. a shared secret header sourced from an env var
that's never set outside test infrastructure, or bind the test-endpoints
router to loopback only. Either is cheap and removes the single-flag
failure mode.

---

## P2 findings (noted, not detailed to the same depth)

- **orders:** `sweepStuckProcurement` is not S4-8 single-flighted the way
  the other periodic workers are — harmless in practice because the work
  itself is row-lock-partitioned (`UPDATE ... WHERE state = ...` semantics
  mean concurrent runs can't double-act on the same row), so this is an
  efficiency note, not a correctness gap. The **R3-10** order-create
  idempotency-window residual (a legitimate, accepted narrow race — see
  `docs/money-auth-worklist.md` R3-10) is not currently listed in
  `docs/threat-model.md`'s accepted-risk register; it should be, so a
  future reviewer doesn't mistake a known/accepted residual for an
  undiscovered gap. `orders/loop-create-response.ts:160-169`'s "Fail-open:
  if the oracle is down at create time..." comment is mislabeled — the
  code returns a placeholder zero display amount when the FX oracle is
  down, but the comment itself notes "watcher's amount validation will
  still hold," meaning the real money check is unaffected. This is
  fail-safe (degrades the SEP-7 URI's cosmetic amount only) mislabeled as
  fail-open (which would imply a security/money check being skipped). Fix
  the comment.
- **credits:** the emission-conservation DB trigger (migration `0044`) is
  integration-tested only for `kind='emission'`; the same trigger also
  gates `order_cashback` and `interest_mint` rows (per its `WHEN` clause)
  but those paths lack equivalent direct integration coverage. The
  advisory-lock acquisition order in `emissions.ts` is a documented,
  fragile-by-convention landmine (a future writer that acquires locks in
  a different order across two code paths could deadlock) — no live
  deadlock observed, but it depends on every future writer following the
  same undocumented-in-code convention.
- **wallet:** `enqueueWalletProvisioning`'s fire-and-forget call races the
  sweeper's advisory lock (S4-2), but is self-healing — a lost race just
  means the sweeper's next tick picks up the same provisioning work, no
  value is at risk and no duplicate provisioning results.

---

## Clean areas (verified solid, not just assumed)

The following were adversarially probed and held up:

- **Orders state machine** — double-procurement, double-CTX-pay,
  refund-vs-fulfillment races, and expiry-vs-late-payment interleavings
  are all CAS/DB-pinned (`UPDATE ... WHERE state = <expected> RETURNING`),
  not convention-gated.
- **Redemption-secret encryption** (CF-25) — `redeem_code`/`redeem_pin`
  AES-256-GCM envelope encryption at rest, tamper-rejecting, holds.
- **LOOP-asset issuer pinning** (INV-10) — enforced at both boot
  (`payout-asset.ts`) and runtime (`configuredLoopPayableAssets()`
  skipping unpinned issuers) — this is the exact guard finding A shows is
  missing for USDC.
- **Payout/refund double-issue guards** (INV-8/INV-9) — single-issue-per-
  order and one-outbound-payment-per-intent both hold under review.
- **ADR-038 D2 at-least-once drift paging** — confirmed wired and firing
  correctly on the interest-mint error path in finding D (which is why D
  is a reliability bug, not a silent one).
- **Auth alg-confusion resistance** — HS256 and RS256 verification key
  sources are disjoint; no cross-algorithm confusion surface found.
- **Refresh-token rotation** — CAS-guarded, no replay window found.
- **OTP lockout** — enforced on every verify path, not just the primary
  one.
- **Step-up scope binding** — grep-verified per admin mount; no mount
  found accepting an unscoped or wrong-scoped step-up token.
- **Staff 404-masking** — non-staff and wrong-tier staff both get 404, not
  403, on `/api/admin/*` as required by `AGENTS.md`.
- **Session revocation** — both self ("sign out everywhere") and admin
  incident-response revocation paths work as documented.
- **Privy webhook** — not implemented at all, so there is no spoofable
  webhook surface (a null attack surface, verified rather than assumed).
- **Secrets in logs** — pino redaction confirmed covering the sensitive
  fields reviewed (`PRIVY_APP_SECRET` et al.).

---

## Remediation Mapping

New/updated items filed in `docs/money-auth-worklist.md` (Phase 0 AUDIT-2
checkbox ticked, pointing here):

| Finding | Disposition                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | New Phase 1 item (💰) + operator action item: confirm `LOOP_STELLAR_USDC_ISSUER` is set in production (escalates P1→P0 if not), then boot-fail on unset + default-to-canonical-issuer fix. Cross-references existing `docs/go-live-plan.md` T1-C.                                                                                                                           |
| B       | Scoped and confirmed against `docs/readiness-backlog-2026-07-03.md` Tier 12 LIVE-RISK; added as an explicit Phase 1 LIVE-RISK item in the worklist with the four call sites.                                                                                                                                                                                                |
| C       | New Phase 1 item (💰); supersedes/reconfirms the open path-payment note in `docs/audit-2026-06-30-cold/raw/v-payments.md` and adds the memo-type sibling gap under the same fix.                                                                                                                                                                                            |
| D       | New Phase 1 item (💰); shared `isUniqueViolation` helper + test-shape fix.                                                                                                                                                                                                                                                                                                  |
| E       | New Phase 2 auth item (🔐); second control on the test-only token-mint endpoint.                                                                                                                                                                                                                                                                                            |
| P2s     | Recorded in this document only, not filed as standalone worklist checkboxes given their severity (efficiency notes, a documentation gap, a misleading comment, self-healing races). Whoever next touches `docs/threat-model.md`'s accepted-risk register, `orders/loop-create-response.ts`'s oracle-down comment, or migration `0044`'s test coverage should fold these in. |

No code changes were made as part of this sweep — this is a read-only
findings report per the AUDIT-2 scope in
`docs/money-auth-worklist.md`.
