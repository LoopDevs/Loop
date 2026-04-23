# ADR-024: Three-signal operator dashboard for stablecoin-side risk

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: Engineering
- **Supersedes**: —
- **Superseded by**: —

## Context

During the ADR-015 stablecoin pivot (#620–#732), `/admin` landing
accreted three distinct kinds of operator-health signal. Each got
built separately in response to different questions:

- "Is our on-chain mint matched to what we owe users?" — drift
  watcher + per-asset badge + state endpoint (#709–#719).
- "Is cashback hitting users fast enough that they don't notice a
  queue?" — settlement-lag endpoint + landing card (#720/#723).
- "Are users spending cashback back on Loop, or is it sitting as
  stagnant liability?" — realization rate endpoint + card +
  sparkline + CSV (#727/#730/#731/#733/#736).

Each piece shipped solo without a framing document. Reviewers
later noticed the cards read as a coherent triplet — **ledger
parity, SLA, flywheel** — but the template wasn't named. Future
observability work (e.g. per-operator supplier health, per-asset
mint velocity) would rediscover this by trial.

## Decision

Any new "is the stablecoin side healthy right now" signal on
`/admin` follows the **three-signal dashboard pattern**:

### Pattern

A signal belongs in this dashboard iff it is one of:

1. **Ledger parity** — on-chain state vs Postgres ledger state
   ("are the books balanced?"). Drift-detection shape.
2. **SLA** — user-visible latency of a settlement step
   ("is the queue fast?"). Percentile shape.
3. **Flywheel** — ratio of in-flow to recycling / out-flow
   ("is cashback staying in the ecosystem?"). Ratio shape.

Each signal ships as a **triad of surfaces**:

- **Backend point endpoint** (`GET /api/admin/<signal>`) —
  single-point answer for the current dashboard card. Fleet-wide
  - per-asset/currency rows in one response via
    `GROUPING SETS ((asset), ())` or equivalent.
- **Backend daily endpoint** (`GET /api/admin/<signal>/daily`) —
  time-series companion. Dense output via
  `generate_series LEFT JOIN` so sparklines don't compress on gap
  days. Clamped `?days` window (default 30, cap 180).
- **UI card + sparkline** on `/admin/_index.tsx`, mounted in the
  same grid row as the other signal cards. Self-hides on empty /
  error so a fresh deployment shows only the signals it has data
  for.

When appropriate, add a **Tier-3 CSV export**
(`GET /api/admin/<signal>/daily.csv`) for month-end finance
reconciliation, following ADR 018 (10/min rate, 10 000 row cap,
`__TRUNCATED__` sentinel, `Cache-Control: private, no-store`,
attachment disposition).

### Shared concerns across all three

- **Ratio math in `@loop/shared`** — helpers like `recycledBps`
  (ADR 019) so the point card, daily sparkline, CSV export, and
  any client-side re-aggregation (e.g. collapsing per-currency
  rows to fleet-wide) agree on rounding.
- **`currency: null` fleet-wide row** — every per-currency
  response carries a single additional row with `currency: null`
  that aggregates across all currencies. The landing card reads
  the fleet row; the per-currency breakdown table renders the
  rest. Single response, no second query.
- **Zero-state rendering** — distinguish "no data yet" (zero
  rows) from "rendering crashed" (no section). Muted zero states
  are fine; silent empties are a footgun during incident triage.
- **Watcher companion (optional)** — if the signal supports a
  threshold ("drift exceeds 100 000 stroops"), pair it with a
  background watcher + Discord notifier (see
  `asset-drift-watcher.ts`). In-memory dedupe on state transitions
  so the notifier fires once per incident, not once per tick.

### Admin landing layout

Dashboard grid on `/admin/_index.tsx`:

```
┌─────────────────────────────────────────────────────────────┐
│  Drift watcher    Settlement-lag     Realization            │
│  (ledger parity)  (SLA)              (flywheel)             │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Cashback sparkline                                         │
├─────────────────────────────────────────────────────────────┤
│  Payouts sparkline                                          │
├─────────────────────────────────────────────────────────────┤
│  Orders sparkline                                           │
├─────────────────────────────────────────────────────────────┤
│  Realization sparkline                                      │
└─────────────────────────────────────────────────────────────┘
```

Three point cards above the fold; four sparklines below them.
Each signal's card + sparkline share a TanStack Query key so
cross-surface polling deduplicates.

## Consequences

- **Signal coherence** — when a new admin ops card ships, it has
  an obvious home ("which of the three?") or it explicitly isn't
  a three-signal dashboard card.
- **Predictable reviewer asks** — PRs are expected to ship the
  point + daily + UI together, or note which follow-ups are
  deferred.
- **Shared math** — ratio computations default to
  `@loop/shared` so the point card and sparkline agree (ADR 019).
- **Tier-3 CSV is cheap** — pattern established, exports take
  under a day.

## Worked example — adding a fourth signal

Supplier margin per day: Loop buys gift cards from CTX operators;
spread between Loop's user-facing price and CTX's wholesale cost
is Loop's retained margin. Classifies as a **Commercial** signal —
a stock-ratio sibling to the flow-ratio **Flywheel** signal
(realization rate). Added to the dashboard as the fourth card.

Shipped as validation of the template (#738 / #740 / #743):

1. `GET /api/admin/supplier-margin` (#738) — per-currency +
   fleet-wide aggregate via `GROUPING SETS ((currency), ())`.
2. `GET /api/admin/supplier-margin/daily?days=30` (#740) — dense
   series via `generate_series LEFT JOIN orders` on
   `fulfilled_at::date`.
3. `SupplierMarginCard` (#740) on `/admin/_index.tsx` — landing
   grid widened from `md:grid-cols-3` to
   `md:grid-cols-2 lg:grid-cols-4` to fit the fourth card.
4. `GET /api/admin/supplier-margin/daily.csv` (#743) — Tier-3
   finance export following ADR 018.
5. Margin-ratio math (`marginBps`) kept local to
   `admin/supplier-margin.ts` until a second consumer adopts it —
   per ADR 019's "three-part test" for shared-package promotion.
   `recycledBps` (ADR 009/015 flywheel math) already has two
   consumers and lifted to `@loop/shared`.
6. `SupplierMarginSparkline` deferred — the three existing
   cashback / payouts / orders / realization sparklines cover
   the trend-over-time slot adequately for now. Ships when ops
   asks.
7. Per-operator threshold + Discord notifier: deferred. The
   `asset-drift-watcher.ts` template is ready to reuse when a
   margin-regression alerts use case lands.

**Observations from the validation**:

- Nothing in the ADR needed rewriting to accommodate a stock-
  ratio signal vs the ledger-parity / SLA / flow shapes.
- Zero-state handling ("0.00% / no fulfilled orders yet" vs
  "card crashed") transferred without modification.
- Per-currency + fleet-wide aggregate row (`currency: null`) is
  the most load-bearing convention — every downstream surface
  (card headline, CSV aggregate, per-currency table) reads off
  it rather than running a second query.

## References

- ADR 015 — stablecoin topology and payment rails
- ADR 018 — admin panel / CSV export architecture
- ADR 019 — shared package policy
- ADR 022 — admin drill-triplet pattern (fleet / merchant / user
  / self). Orthogonal to this ADR — that's about _which viewports_
  a metric ships on; this is about _which KPI families_ belong
  on the operator landing.
