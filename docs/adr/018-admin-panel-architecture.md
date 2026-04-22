# ADR 018: Admin panel architecture — drill-down, triage, compliance

Status: Accepted
Date: 2026-04-22
Related: ADR 009 (credits ledger), ADR 011 (admin panel), ADR 013 (CTX operator pool), ADR 015 (stablecoin topology), ADR 016 (Stellar SDK payouts), ADR 017 (admin credit primitives / write invariants)

## Context

ADR 011 introduced the admin panel as a per-merchant cashback-config
editor. ADR 015 widened its remit to include treasury + payouts. Since
then the panel has grown to a full ops surface — 20+ endpoints, 8
pages, a shared drill-down pattern, compliance exports. Individual
slices landed without a load-bearing doc for the pattern choices
holding them together.

This ADR captures the three architectural choices that every
subsequent admin slice either inherits or must explicitly break:

1. **Aggregate → detail drill-down** keyed on URL parameters.
2. **Read / triage / write separation** with distinct invariants per
   tier (ADR 017 covers writes; this one covers the other two).
3. **Compliance-grade CSV** as first-class, not an afterthought.

Each choice has been pattern-matched enough times across recent PRs
that codifying it is cheaper than re-deriving it per slice.

## Decision

### 1. Aggregate → detail drill-down

Every admin aggregate endpoint exposes a `?filter=<value>` on the
corresponding detail endpoint, and the aggregate's UI row links to
the filtered detail view. The filter list on the orders endpoint
alone reads: `state`, `userId`, `merchantId`, `chargeCurrency`,
`ctxOperatorId`. The drill-down URLs are **bookmarkable**: paste
into Slack, Linear, or a support ticket and the recipient lands on
the same filtered view.

Concretely:

- `/admin/cashback` MerchantStatsTable rows link to
  `/admin/orders?merchantId=<slug>`.
- `/admin/treasury` SupplierSpendCard currency cells link to
  `/admin/orders?chargeCurrency=<code>`.
- `/admin/treasury` OperatorStatsCard operator cells link to
  `/admin/orders?ctxOperatorId=<id>`; failed-count cells combine
  with `&state=failed`.
- `/admin/treasury` PayoutsByAssetTable asset cells link to
  `/admin/payouts?assetCode=<code>`; failed-count cells combine
  with `&state=failed&assetCode=<code>`.
- `/admin/users/:userId` UserCashbackByMerchantTable merchant cells
  link to `/admin/orders?merchantId=<slug>&userId=<id>` — stacked
  filters go as deep as the detail endpoint supports.

**Invariant:** when an aggregate row's value is queryable on a
detail endpoint, the row **must** be a link. When it isn't, the
aggregate is raising a question it can't answer on its own —
either teach the detail endpoint the filter or drop the cell.

**Shape of the filter banner:** each detail page with a URL filter
renders a dismissible banner ("Filtered to X: Clear") above the
table. The dismiss button deletes the param + resets any cursor
state. Users who land via a deep-link see the banner immediately
and know what to strip to return to the full view.

### 2. Read / triage / write separation

The admin surface has three tiers with distinct invariants:

| Tier   | Example endpoints                                 | Rate limit | Staleness     | Write invariants                             |
| ------ | ------------------------------------------------- | ---------- | ------------- | -------------------------------------------- |
| Read   | `/admin/treasury`, `/admin/merchant-stats`        | 60/min     | 15–60s        | none (read-only)                             |
| Triage | `/admin/stuck-orders`, `/admin/stuck-payouts`     | 120/min    | 15–30s + poll | none (read-only)                             |
| Write  | `/admin/payouts/:id/retry`, `/credit-adjustments` | 20/min     | n/a           | ADR 017 (actor, idempotency, audit, Discord) |

**Triage endpoints poll** — they have a `refetchInterval` in the
client so ops sees backlogs drain in real time. Their rate limit
is deliberately higher (120/min) so a tab left open on `/admin`
doesn't eat a user's budget.

**Read endpoints don't poll** — they refresh on focus / navigation.
60/min is enough for the refresh-on-focus case plus a cache
invalidation after a write.

**Write endpoints are ADR-017 gated**. This ADR doesn't redefine
them — it lists the three tiers so the invariants land on the right
one.

### 3. Compliance-grade CSV as first-class

Every admin surface that produces a list ops might hand to finance,
legal, or a user has a matching `.csv` sibling endpoint. Not an
afterthought: the list is built once and the CSV is built once,
against the same underlying aggregate.

Shared CSV invariants (enforced by pattern-matching to existing
exports, not a framework):

- **RFC 4180** — quote-wrap any field containing `,`, `"`, CR, or
  LF; double embedded quotes.
- **CRLF line terminators** — the spec says `\r\n`, not `\n`.
- **Header row always present** — even on an empty window, the
  client gets `header_row\r\n` not a bare newline.
- **Row cap 10 000** with `__TRUNCATED__` sentinel on overflow +
  backend log-warn of the real rowCount. Forces ops to narrow the
  window rather than time out the request.
- **366-day window cap** on every `?since=` — a scan-whole-table
  request would time out anyway; rejecting it at the edge gives a
  clean 400.
- **Tier-3 rate limit (10/min)** — CSVs run at ticket-resolution
  speed, not on-click polling. Polling-style endpoints belong at
  60/min or 120/min.
- **Attachment headers** — `Content-Type: text/csv; charset=utf-8`,
  `Cache-Control: private, no-store`, `Content-Disposition:
attachment; filename="<name>-<YYYY-MM-DD>.csv"`. The browser
  drops straight to disk.

Current CSV exports matching this pattern:
`/admin/payouts.csv`, `/admin/orders.csv`, `/admin/audit-tail.csv`,
`/admin/users/:userId/credit-transactions.csv`.

**Filename convention:** `<resource>-<since-date>.csv` for
fleet-wide exports; `<resource>-<id-prefix>-<since-date>.csv` for
per-user exports (`id-prefix` = first 8 chars of uuid, plenty to
distinguish without being a full pkid).

## Consequences

### Positive

- **Ops productivity.** The drill-down pattern means one click goes
  from any high-level signal to the rows behind it. Incident triage
  that used to require hand-crafted SQL now runs in the admin UI.
- **Compliance-ready.** Every per-user ledger surface has a CSV
  export, so a subject-access-request response is a 5-minute task,
  not a data-dump ticket to engineering.
- **Consistent mental model.** New admin pages know which tier
  they're on and inherit the right rate-limit + staleness defaults.
- **Deep-linkable for async collaboration.** A Slack message with
  `/admin/orders?state=failed&ctxOperatorId=op-b-02` is fully
  self-contained.

### Negative / accepted trade-offs

- **URL schema surface area** grows fast. Five filters on
  `/admin/orders` is already a lot; a sixth will want `q=` search.
  Accepted: filters are additive and independent, so the cost of
  one more is one more conditional in the handler + one more
  banner on the page.
- **CSV pattern is copy-paste.** Each new `.csv` endpoint
  re-implements `csvEscape`/`csvRow` rather than extracting a
  helper module. Deliberate — a utility module would need to
  handle RFC 4180 + bigint coercion + row-cap truncation, which
  is most of each endpoint's body anyway. Re-extract if a 6th
  CSV lands with drift.
- **No admin-route test harness.** Each page's render test stubs
  `~/services/admin` independently. Accepted until a 2nd
  admin-route test needs the same stubs — then extract a
  `test-utils/admin-mocks.ts`.

### Breaking this ADR

The three choices are self-reinforcing; breaking one usually
implies breaking others. Future slices that want a non-linkable
filter (e.g. time-window picker with auth-scoped defaults) or a
write endpoint on a triage surface (e.g. "reset stuck payout
from the triage table") should land with a follow-up ADR
explaining why the invariant doesn't apply.
