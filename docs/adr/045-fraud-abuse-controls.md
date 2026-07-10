# ADR 045: Fraud / abuse controls (Phase 1)

Status: Accepted (design) — Phase-1 subset implemented
Date: 2026-07-10
Related: ADR 009 (credits ledger), ADR 010 (principal switch), ADR 015
(stablecoins), ADR 017 (admin write primitives), ADR 036 (cashback token
lifecycle), `docs/invariants.md`, `docs/threat-model.md`

## Context

`docs/readiness-backlog-2026-07-03.md` item **B-3** and
`docs/go-live-plan.md` §T1-H flag that Loop has **no user-level
fraud/abuse controls today**. The only pre-write check on the
order-create path is `orders/loop-create-checks.ts`'s
`hasSufficientCredit` — a balance check, not an abuse control — plus
the generic per-IP rate limiter (`middleware/rate-limit.ts`, 10/min on
`POST /api/orders/loop`).

That per-IP limiter is the wrong tool for the threat this ADR is
about. It bounds request _volume_ from one network vantage point; an
attacker with a compromised or intentionally-abusive account can
rotate source IPs (residential proxies, mobile networks, a botnet)
and never touch it, while placing an unbounded number of orders
against **one Loop account**. The blast radius that actually matters
— how much value one compromised or bad-faith identity can move
before a human notices — is currently unbounded.

Three sub-problems, at different levels of readiness for a Phase-1
build:

1. **Velocity limits** — nothing bounds how many orders, or how much
   value, one user can create per unit time. This is the highest-value
   gap: it bounds the blast radius of a single compromised account or
   a single bad-faith signup, independent of network-level tricks.
2. **Duplicate-account detection** — nothing flags when the signals
   that would normally distinguish two people (funding source, device,
   signup IP) point at the same actor operating multiple Loop
   accounts. This matters because a per-user velocity limit is only as
   strong as the assumption that "user" corresponds to "person" — an
   attacker who can cheaply mint fresh accounts routes around a
   per-user cap entirely.
3. **Chargeback handling** — Phase 1 funding is XLM / USDC / a
   Loop-asset redemption / an off-chain credit debit. None of these
   are card rails; there is no chargeback network, no dispute API, no
   issuing bank clawing funds back weeks later. "Chargeback handling"
   as classically scoped (dispute intake, provisional credit, evidence
   submission, network deadlines) **does not exist as a threat yet**.
   It becomes real the day Plaid/ACH or card rails land (readiness
   backlog tranche T3 / `docs/adr/030-integrated-wallet-via-privy.md`'s
   funding-source roadmap).

## Decision

### 1. Velocity limits (built, Phase 1)

A per-user, per-rolling-window cap on order creation, checked in
`orders/loop-handler.ts` **before** `createOrder` is called — i.e.
before any row is written and before a credit-funded order's balance
is touched. Two independent dimensions, each separately configurable
and separately disable-able:

- **Count**: at most `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW` orders per
  user within `LOOP_ORDER_VELOCITY_WINDOW_HOURS` hours (true rolling
  window, computed as `now − windowHours`, not a fixed calendar
  bucket — so "resets after the window" falls out for free as old
  orders age past the cutoff on the next check).
- **Value**: at most `LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR` summed
  `charge_minor` per user, **per charge currency**, within the same
  window.

**Why per-currency, same-magnitude comparison instead of FX-converting
to one unit:** `orders.charge_currency` is always one of USD/GBP/EUR
(the home-currency set — see `orders/schema.ts`'s
`orders_charge_currency_known` CHECK). Comparing raw minor-unit sums
across these three currencies without conversion is imprecise (£1 ≠
$1), but the three currencies are within ~30% of each other in value,
and this is a **rate-limiting heuristic**, not a monetary
calculation — no value is computed or moved from this number, it only
gates whether an order attempt proceeds. Pulling in the FX feed
(`payments/price-feed.ts`) to convert every window-sum to a common
unit would add an upstream dependency (and its own failure mode) to a
check whose entire job is to fail fast and cheap, for a precision gain
that doesn't change the enforcement decision at the threshold sizes
below. This mirrors the existing precedent: `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`
/ `ADMIN_DAILY_WITHDRAWAL_CAP_MINOR` (A2-1610 / ADM-01) are also
per-currency minor-unit caps with no cross-currency conversion.

**Bounded, indexed query (S4-6 lesson).** The check must not become
the next unbounded admin-scan-on-the-hot-path finding
(`docs/readiness-backlog-2026-07-03.md` S4-6, PERF-005). It reuses the
existing `orders_user_created` index on `(user_id, created_at)`
(`db/schema/orders.ts`) with a query shaped as:

```sql
SELECT charge_minor, charge_currency FROM orders
WHERE user_id = $1 AND created_at >= $2
ORDER BY created_at DESC
LIMIT <rowCap>
```

`rowCap` is `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW` when the count
dimension is enabled (0 disables it), or a fixed internal defensive
ceiling (200 rows) when only the value dimension is active. Either
way the scan is a **bounded backward index scan** — Postgres stops
after `rowCap` rows regardless of how many orders the user actually
has in the window — so neither a legitimate heavy user nor an
attacker who got past this check before it existed can turn a single
order-create request into an unbounded table scan. If the returned
row count hits the count cap, the count dimension has already failed
and the request is rejected without needing an exact total. **When
the count dimension is enabled** (`countMax > 0`), a row count under
the cap means the fetched rows ARE the complete window (nothing was
truncated), so summing them for the value dimension is exact, not an
approximation. **When the count dimension is disabled**
(`countMax = 0`, value-only mode) `rowCap` falls back to the fixed
200-row ceiling above — a user with ≥200 orders in the window has
the value sum computed over only the most recent 200, silently
excluding older in-window orders. This is a real, accepted residual
of running the value dimension without its usual count-dimension
backstop, not a hidden approximation: it only manifests when an
operator has deliberately zeroed `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW`
while leaving the value cap on, an unusual configuration (the shipped
defaults have both dimensions on, so the count check — a much
smaller cap in practice — always fires first and this path is never
reached). See `docs/threat-model.md`'s ADR-045 accepted-risk rows for
this and the sibling concurrency residual below.

**Accepted residual: no cross-request serialization.** This is a
plain `SELECT`, not a `SELECT ... FOR UPDATE` or an advisory-locked
critical section spanning the check-then-create window. A burst of
concurrent `POST /api/orders/loop` requests from the same account can
each read roughly the same "existing count/sum" snapshot before any
of their own `createOrder` writes land, so up to (burst size) orders
can pass the gate together before the next request correctly sees
the updated total — a classic TOCTOU race, not a hard, atomic
ceiling. This does not break any money invariant: `credit`-method
orders still can't overspend (the separate `FOR UPDATE`-guarded
balance check inside `createOrder`, INV-2, is unaffected), and
on-chain-funded orders create nothing financially real until an
actual deposit lands, so a burst produces excess unpaid
`pending_payment` rows (an operational/spam concern bounded by how
many concurrent requests one attacker can fire in a single
round-trip) rather than a value loss. Accepted for Phase 1 given the
threat this control is sized against (a scripted/automated abuser
running many requests over time, not a single perfectly-timed burst);
revisit with a per-user `pg_advisory_xact_lock` around the
check-then-create window if production data shows burst-driven
over-limit clusters.

**Placement in the request path.** The check runs on `auth.userId`
alone — no merchant lookup, no FX call, no denomination check needed
— so it's placed early in `loopCreateOrderHandler`, after the
idempotency-replay short-circuit (a replay of an existing order must
not count as a new attempt or be blocked by this check — it creates
nothing new) and before the per-merchant/FX/currency work, so a
user already over budget doesn't pay for that wasted work.

**Enforcement tier: runtime, hard limit per request — not atomic
across concurrent requests.** A rejection returns 429
`ORDER_VELOCITY_EXCEEDED` before any DB write — this is a hard block
on the count/value dimensions, not a soft flag, because it's a purely
_quantitative_ signal computed from the account's own authenticated
history (no ambiguity, no false-positive risk beyond "this account is
transacting a lot," which is why the defaults below are set
generously). "Hard" here means every individual request that
observes an over-budget account is rejected — it does NOT mean the
check-then-create sequence is serialized against concurrent requests
from the same account; see the accepted concurrency residual below
for the precise TOCTOU shape and why it doesn't break a money
invariant.

**Fail-closed on query error.** If the bounded SELECT throws (DB
blip, pool exhaustion), the handler does **not** fall through to
"assume under budget" — it returns 503
`ORDER_VELOCITY_CHECK_UNAVAILABLE` and creates nothing. A legitimate
user retries a transient 503; an attacker cannot use a DB hiccup to
smuggle an order past the gate. This mirrors the A5-3
`OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE` precedent
(`docs/threat-model.md` B5 row) — the established shape in this
codebase for "the safety check itself failed."

**Defaults.** `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW=20` orders per
`LOOP_ORDER_VELOCITY_WINDOW_HOURS=24` hours,
`LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR=500000` minor units ($5,000 /
£5,000 / €5,000) per currency per window. Reasoning: the existing
global per-order face-value ceiling (`ORDER_MAX_FACE_VALUE_MINOR`,
`orders/loop-handler.ts`) is $50,000 — a single legitimate large
gift-card order should never come close to tripping the _daily_
cap, and the count default (20/day) comfortably covers even an
enthusiastic real user buying several cards a day for personal use
or a small household, while bounding a compromised/bad-faith
account's daily blast radius to a fraction of what unlimited access
would allow. Each dimension is independently disabled by setting its
threshold to `0` (mirrors `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`'s "0
disables" convention) — the escape hatch for dev/test/an operator
decision to loosen one dimension without redeploying code.

**What this does NOT change.** No existing invariant in
`docs/invariants.md` is touched — this is a new pre-write gate, not a
change to how `createOrder`, the credit debit, or any ledger write
behaves once it proceeds. It composes with, not replaces, the
per-IP rate limiter (an attacker who both floods one account AND
distributes across IPs still hits this; the per-IP limiter still
catches raw request floods regardless of account).

### 2. Duplicate-account detection (built, Phase 1 — flag only)

**Signal implemented: shared on-chain funding source across distinct
userIds.** Every on-chain-funded order (`xlm` / `usdc` / `loop_asset`)
captures the paying Horizon payment's source account in
`orders.payment_received_payment` (the `HorizonPayment.from` field,
already persisted by `markOrderPaid` — see `orders/transitions.ts`
and R3-2's payment-snapshot rationale). When a payment watcher tick
transitions an order to `paid`, a fire-and-forget check
(`fraud/duplicate-account-signals.ts`, called from
`payments/watcher.ts` **after** the state transition commits, never
inside it) looks for any OTHER user's paid+ order funded from the
same source account. A hit means the same Stellar wallet funded
orders for two different Loop accounts — a real, cheap, high-signal
indicator of one actor operating multiple accounts (e.g. to farm
multiple per-account cashback/discount allowances, or to route around
the velocity cap in §1 by spreading orders across sock-puppet
accounts funded from one wallet).

A hit writes one row to the new `fraud_signals` table (migration 0059) — `signal_type='shared_funding_source'`, the two user ids, and
a `detail` JSON blob (`{ sourceAccount, orderId, relatedOrderId }`) —
guarded by a DB unique index on `(signal_type, user_id,
related_user_id)` so a pair that repeatedly co-occurs (the same two
accounts buying from the same wallet every week) writes exactly one
row, not one per order. A **freshly inserted** row also fires a
one-line Discord page to `#loop-monitoring`
(`notifyDuplicateAccountSignal`) — ops eyes on a real cross-account
match, not a query they have to remember to run.

**Why this signal first, and not device/IP-at-signup too.** Of the
four candidate signals the readiness-backlog item names (payment
source, device, deposit-address reuse, rapid multi-account creation
from one IP), funding-source-reuse is the only one whose data is
_already captured_ by the existing order-paid path — zero new capture
plumbing, uses an existing JSONB column plus one new expression index
(`orders_payment_source_account` on `payment_received_payment->>'from'`,
migration 0059), and is scoped to a single fire-and-forget call after
an existing transition. The other three all require **new capture**
that doesn't exist yet: signup-time IP/device fingerprinting isn't
wired into `auth/handler.ts` → `db/users.ts:findOrCreateUserByEmail`
today, and building that capture path, its own retention/PII posture
(these are exactly the identifiers `docs/log-policy.md` cares about),
and a defensible rapid-signup threshold is a materially larger, more
privacy-sensitive change than this Phase-1 slice should absorb
alongside the velocity-limit build. **Deferred, not abandoned** — see
Consequences below for the concrete follow-up shape.

**Enforcement tier: flag only, never auto-block.** Per the
readiness-backlog guidance, Phase 1 is detection + surfacing for ops
review, not automated account action. Two real accounts can
legitimately share a funding wallet (a couple, a family, a shared
business card funding two employees' separate Loop accounts) — the
false-positive cost of auto-blocking on this signal alone is real
user lockout, which is explicitly the failure mode this ADR is told
to avoid ("must not lock out legitimate users; err toward
flag-for-review over hard-block for the ambiguous signals"). The
signal is queryable directly (`fraud_signals` table) and pages
Discord on first occurrence; there is no dedicated admin list
endpoint in this Phase-1 slice — deliberately, to keep scope to "a
queryable signal + a Discord page," matching the readiness-backlog
item's own scoping language. A follow-up `GET
/api/admin/fraud-signals` (support-tier read, same shape as the A5-8
ledger browser) is the natural next step once ops wants an in-product
triage view instead of Discord + `psql`.

### 3. Chargeback handling (documented hook only, Phase 1)

**Phase 1 has no chargeback threat.** Every funding path today is
final-settlement crypto (XLM, USDC, a LOOP-asset redemption) or an
internal off-chain credit debit — none of these can be reversed by a
third-party network weeks after the fact the way a card chargeback
can. There is no "Phase 1 chargeback handling" to build because there
is no chargeback.

**The closest current analog: disputed/failed settlement.** The
system already has a real reversal path for the actual Phase-1 risk
— an order that took the user's money but didn't deliver a working
gift card. That's `INV-6` (`docs/invariants.md`): every paid order
reaches a user-whole terminal state, enforced by
`procureOne`'s auto-refund-on-failure paths, the crash-recovery
`sweepStuckProcurement` disambiguation, and (2026-07-10) the
operator-triggered `POST /api/admin/orders/:orderId/refund` (A5-4)
for support-mediated cases including the fulfilled-order
code-unused-attestation path. This ADR does not change any of that —
it's flagged here so a future reader doesn't go looking for a
separate "chargeback" system when the refund path already covers the
Phase-1-shaped version of the problem.

**The Phase-1.5/T3 hook.** When Plaid/ACH or card funding lands
(readiness-backlog tranche T3), a genuine chargeback/dispute
surface becomes necessary: an inbound webhook or poll from the
funding provider, a `disputed` order state (or a parallel
`payment_disputes` table keyed to the order/payment), a hold on
further orders from the disputing user pending resolution, and a
reversal path that — unlike the crypto refund above — must handle
the "money already spent on a gift card" case created by
`docs/adr/010-principal-switch-payment-rails.md`'s CTX-procurement
economics (Loop already paid CTX; a card-funded order that reverses
weeks later is a Loop loss, not a pass-through). Designing that state
machine now, before a card/Plaid funding provider is even chosen,
would be speculative — the right integration shape depends on
which provider's dispute API Loop ends up behind. This ADR's
job is to name the gap precisely so `docs/adr/030-integrated-wallet-via-privy.md`'s
Phase-2 funding-rail work (or its own ADR when a card/Plaid provider
is chosen) doesn't have to rediscover it.

## Fail-safe posture (applies to both built controls)

- **Fail closed on the check itself failing** (§1's `503
ORDER_VELOCITY_CHECK_UNAVAILABLE`). A DB blip must never silently
  grant unlimited velocity.
- **Fail open on the wrong side never happens for a hard limit**: the
  velocity gate is a pure read-then-reject ahead of any write — a
  rejected request creates nothing (no order row, no debit), so there
  is no partial-state cleanup question.
- **Ambiguous signals stay flags, never blocks.** Duplicate-account
  detection has real false-positive scenarios (shared household
  wallets); per the task's explicit instruction, it flags for human
  review rather than gating any user-facing action. Nothing in this
  ADR degrades a legitimate user's ability to transact based on the
  duplicate-account signal alone.
- **No new value-moving code.** Both checks are pure reads (velocity)
  or a detection write to a new, non-ledger table plus a Discord
  notification (duplicate-account) — neither touches
  `user_credits`, `credit_transactions`, `pending_payouts`, or any
  Stellar submit path. Every invariant in `docs/invariants.md` is
  unmodified by this ADR; see the PR description for the per-invariant
  confirmation.

## Configuration

| Var                                   | Default  | Meaning                                                                          |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `LOOP_ORDER_VELOCITY_MAX_PER_WINDOW`  | `20`     | Max orders per user per window. `0` disables the count dimension.                |
| `LOOP_ORDER_VELOCITY_WINDOW_HOURS`    | `24`     | Rolling window size, in hours, for both dimensions.                              |
| `LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR` | `500000` | Max summed `charge_minor` per user per charge-currency per window. `0` disables. |

All three are `parseEnv`-validated (non-negative integers /
bigint) and read live from `env` (no boot guard — a misconfiguration
here degrades a fraud control, not a launch-blocking money-safety
primitive, so it doesn't get the `env.ts` production-boot-fail
treatment that `LOOP_STELLAR_USDC_ISSUER` etc. get).

## Consequences

**Good.** The order-create path now bounds one account's daily blast
radius independent of network tricks, closing the single largest gap
B-3 named. The duplicate-account signal is essentially free (existing
data, one indexed query, one notify call) and gives ops a real,
actionable page instead of silence. Both build cleanly on existing
patterns (`orders_user_created` index, the A5-3
fail-closed-on-count-error shape, the ADR 018 Discord-notifier
catalog) rather than inventing new infrastructure.

**Cost.** One new table (`fraud_signals`) with two indexes and a
unique constraint; one new expression index on `orders`; three new
env vars; one new fire-and-forget call in the payment watcher's
happy path (bounded, does not block or affect the transition it
follows).

**What this ADR does NOT cover (explicitly deferred, tracked
separately).**

- **Auto-blocking** on any signal in this ADR. Both controls are
  designed to be safely promotable later (the velocity limit is
  already a hard block by design; the duplicate-account signal would
  need a second, higher-bar signal or an ops decision before any
  account action attaches to it).
- **Device fingerprinting and signup-IP capture** for duplicate-account
  detection. Named above as the concrete near-term follow-up; needs
  its own privacy/retention review (`docs/log-policy.md`) before
  landing, since it's new PII capture at signup, not a query over
  data already stored.
- **A real chargeback/dispute state machine.** Blocked on a Plaid/card
  funding provider decision (T3); this ADR is the placeholder that
  keeps the gap visible rather than silently assumed-covered.
- **An admin UI for `fraud_signals`.** Deliberately out of scope per
  the "don't over-build" guidance — the table is queryable and pages
  Discord; a list endpoint is a fast, low-risk follow-up whenever ops
  wants it.
