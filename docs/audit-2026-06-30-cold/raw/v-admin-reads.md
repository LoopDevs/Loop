# Vertical Admin reads/CSV/drills — raw findings

Files examined: 90/90 (79 in-scope `apps/backend/src/admin/*.ts` + 9 `routes/admin-*.ts`
route-mount files + `routes/admin.ts` + `scripts/quarterly-tax.ts` + `discord/monitoring.ts`,
plus light cross-reference reads of `csv/csv-escape.ts`, `discord/admin-audit.ts`,
`auth/require-admin.ts`, `orders/repo.ts`, `db/schema.ts`, `orders/fulfillment.ts` and the
out-of-scope `users/cashback-history-handler.ts` to verify the CF-26/X-PRIV-11 delta claim).

This pass combined direct reading (≈30 files read in full personally, including every
route-mount file, the CSV-escape module, the read-audit/CF-10 middleware, and a sample of
high-PII/high-money handlers) with four parallel sub-agent batches covering the remaining
~60 `admin/*.ts` handlers, each instructed with the same adversarial checklist (CF-10
row-threshold blind spots, csv-escape bypass, IDOR, SQL parameterization, money-as-float,
division-by-zero, drill-quartet/mix-axis consistency). All sub-agent P1+ claims were
independently re-verified against the source before inclusion below (see "Delta
re-verification" and Finding ADMIN-01 for the trust-but-verify trail).

## CSV export inventory

All 18 admin CSV exporters import `csvEscape`/define a local `csvRow` wrapper from
`./csv-escape.js` (admin re-export of `../csv/csv-escape.ts`, the CF-26/X-PRIV-11 hardened
RFC4180 + formula-injection escaper). Every cell in every file is routed through it — no
raw string-concatenation bypass found anywhere in the 18-file family.

| Handler                             | Mount (rate limit)                    | Uses csv-escape correctly?            | PII fields exported                      | Row cap                       | Audit-logged (CF-10)                          |
| ----------------------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------- | ----------------------------- | --------------------------------------------- |
| `audit-tail-csv.ts`                 | `admin-ops-tail.ts` (10/min)          | Y                                     | `actor_email` (staff, not customer)      | 10,000 + `__TRUNCATED__`      | Y (`.csv` always bulk)                        |
| `cashback-activity-csv.ts`          | `admin-dashboard.ts` (10/min)         | Y                                     | none (aggregate)                         | 10,000                        | Y                                             |
| `cashback-configs-csv.ts`           | `admin-cashback-config.ts`\* (10/min) | Y                                     | `updated_by` (staff user id)             | 10,000                        | Y                                             |
| `cashback-realization-daily-csv.ts` | `admin-dashboard.ts` (10/min)         | Y                                     | none                                     | 10,000                        | Y                                             |
| `merchant-flywheel-activity-csv.ts` | `admin-per-merchant.ts` (10/min)      | Y                                     | none                                     | 10,000                        | Y                                             |
| `merchant-stats-csv.ts`             | `admin-per-merchant.ts` (10/min)      | Y                                     | none                                     | 10,000                        | Y — **but see ADMIN-01: wrong currency axis** |
| `merchants-catalog-csv.ts`          | `admin-cashback-config.ts`\* (10/min) | Y                                     | merchant `name` (third-party, untrusted) | 10,000                        | Y                                             |
| `merchants-flywheel-share-csv.ts`   | `admin-per-merchant.ts` (10/min)      | Y                                     | none                                     | 10,000                        | Y                                             |
| `operators-snapshot-csv.ts`         | `admin-fleet-monthly.ts` (10/min)     | Y                                     | none                                     | 10,000                        | Y — see ADMIN-05 (raw SQL identifiers)        |
| `orders-csv.ts`                     | `admin-order-drill.ts` (10/min)       | Y                                     | `userId`, amounts                        | 10,000                        | Y                                             |
| `payouts-activity-csv.ts`           | `admin-fleet-monthly.ts` (10/min)     | Y                                     | none                                     | 10,000                        | Y                                             |
| `payouts-csv.ts`                    | `admin-payouts.ts`\* (10/min)         | Y                                     | `userId`, `toAddress`, amounts           | 10,000                        | Y                                             |
| `supplier-spend-activity-csv.ts`    | `admin-fleet-monthly.ts` (10/min)     | Y                                     | none                                     | 10,000                        | Y — see ADMIN-05                              |
| `treasury-credit-flow-csv.ts`       | `admin-fleet-monthly.ts` (10/min)     | Y                                     | none                                     | 10,000                        | Y                                             |
| `treasury-snapshot-csv.ts`          | `admin-treasury.ts` (10/min)          | Y                                     | none                                     | N/A (fixed small metric dump) | Y                                             |
| `user-credit-transactions-csv.ts`   | `admin-user-cluster.ts` (10/min)      | Y                                     | ledger rows (no email in body)           | 10,000                        | Y                                             |
| `user-credits-csv.ts`               | `admin-ops-tail.ts` (20/min)          | Y (minor bigint-bypass nit, ADMIN-08) | `email`, `userId`, balances              | 10,000                        | Y                                             |
| `users-recycling-activity-csv.ts`   | `admin-user-cluster.ts` (10/min)      | Y                                     | `email`, `userId`                        | 10,000                        | Y                                             |

\* mount file owned by a sibling agent (`admin-cashback-config.ts`, `admin-payouts.ts`) —
confirmed via `grep` only, not deep-audited.

## Findings

### ADMIN-01 [P1 · LIVE] `merchant-stats` / `merchant-stats-csv` sum charge-currency-denominated money under the wrong currency grouping

- File: `apps/backend/src/admin/merchant-stats.ts:118-141`, `apps/backend/src/admin/merchant-stats-csv.ts:96-115`
- Description: Both handlers `GROUP BY orders.merchantId, orders.currency` (the **catalog**
  currency — what CTX procures the gift card in) and sum `wholesaleMinor`,
  `userCashbackMinor`, `loopMarginMinor`. I confirmed in `apps/backend/src/orders/repo.ts:117-122`
  (comment: _"ADR 015 — pin the split in the user's home-currency terms (chargeMinor), so
  user_cashback_minor + loop_margin_minor land in the currency the ledger + balance are
  denominated in"_) and `apps/backend/src/db/schema.ts:442-477` (`faceValueMinor`/`currency`
  are explicitly "independent of the currency the user was charged in"; `chargeMinor`/
  `chargeCurrency` is "what the **user** was charged, in their home currency") that
  `wholesaleMinor`/`userCashbackMinor`/`loopMarginMinor` are denominated in
  `orders.chargeCurrency`, not `orders.currency`. Every sibling handler that sums the same
  three fields correctly groups by `chargeCurrency` instead: `merchant-flows.ts:54`,
  `merchant-cashback-summary.ts`, `merchant-cashback-monthly.ts:93`,
  `merchant-top-earners.ts:122/132`. `merchant-stats`/`merchant-stats-csv` are the only two
  outliers in the entire admin surface.
- Impact: For any merchant whose orders span multiple `chargeCurrency` values (any
  cross-region purchase — possible since ADR 015's home-currency rollout, and increasingly
  common for ADR-035 extended-market merchants serving AE/IN/SA/AU/MX catalog currency to
  USD/GBP/EUR home-currency buyers), the query **collapses every chargeCurrency variant into
  one row** (because `orders.currency`, the GROUP BY key, is constant per merchant) and sums
  minor-unit amounts denominated in different real-world currencies as if they were one
  currency, labeling the row with the catalog currency. Both endpoints' own docblocks state
  they "directly feed the 'which merchants to prioritise with CTX for better wholesale
  rates' decision" — this is a silent financial-reporting correctness bug feeding a real
  commercial decision, not just a display nit.
- Evidence: `merchant-stats.ts:121` `${orders.currency} AS currency,` vs.
  `merchant-flows.ts:54` `currency: orders.chargeCurrency,` for the identical class of
  summed split-fields. The `MerchantStatsRow.currency` doc comment (`merchant-stats.ts:50-52`)
  is also stale/wrong: it claims "the aggregate picks the most-fulfilled currency... when
  there are multiple," but the code emits one row per distinct catalog-currency value (which
  in practice is almost always exactly 1 per merchant) — it does not pick a dominant
  currency, and per-merchant catalog currency doesn't vary the way the comment implies.
- Minimal fix: Change both queries to `GROUP BY orders.merchantId, orders.chargeCurrency`
  and select `orders.chargeCurrency AS currency`, matching `merchant-flows.ts`.
- Better fix: Also fix the stale doc comment, and add a regression test mirroring
  `merchant-flows.test.ts`'s "splits the same merchant into separate rows per charge
  currency" case to `merchant-stats.test.ts` (confirmed: its only currency literals today
  are uniform per test, never mixed within one merchant, so this exact bug class is
  untested). Consider whether `faceValueMinor` (catalog-currency-denominated) should be
  reported on a separate axis from the three chargeCurrency-denominated fields if a
  merchant's catalog currency itself is ever allowed to vary (currently it can't in
  practice, since a merchant's catalog listing pins one currency).

### ADMIN-02 [P1 · LIVE] `admin/users/search` is structurally invisible to the CF-10 bulk-read tripwire — enables undetected PII enumeration

- File: `apps/backend/src/admin/user-search.ts:41` (`RESULT_LIMIT = 20`), `apps/backend/src/admin/read-audit.ts:17` (`BULK_LIST_ROW_THRESHOLD = 50`), `apps/backend/src/routes/admin-ops-tail.ts:88-92` (mounted at 60 req/min)
- Description: CF-10 (`routes/admin.ts:132-197`) is a blanket middleware on every
  `/api/admin/*` GET: it fires a Discord ping to `#admin-audit` (`notifyAdminBulkRead`) when
  either the path is `.csv` OR the JSON response's largest top-level array has
  ≥ `BULK_LIST_ROW_THRESHOLD = 50` entries. `user-search.ts` is the admin panel's
  case-insensitive **email**-substring search (`?q=`, 2-254 chars, `ILIKE %q%`), and its
  `RESULT_LIMIT` is hard-coded to **20** — both the success path (`trimmed.slice(0,
RESULT_LIMIT)`) and the truncation-probe (`limit(RESULT_LIMIT + 1)`, so even the raw
  pre-slice row count tops out at 21) keep the response's `users` array permanently below
  the 50-row threshold. **This endpoint can never trip the CF-10 tripwire, regardless of how
  many times or how it is called.** The OpenAPI doc for this route
  (`openapi/admin-user-search.ts`) explicitly documents the 20-row cap as a _UX_ decision
  ("narrow the query" hint) — nobody connected that UX choice to its side effect of
  permanently defeating the bulk-PII-exfil detector that CF-10 exists to catch.
- Impact: An admin account (legitimate-but-malicious, or a stolen/phished admin bearer
  token) can enumerate the **entire user table's emails + ids** via short, broad substrings
  (`q=aa`, `q=ab`, ... `q=zz` — 676 two-letter combinations, or narrower per-domain guesses)
  while staying permanently under the radar of the one control (CF-10 / A2-2008) explicitly
  designed to catch "a malicious or mis-targeted admin exfiltrating user data without
  leaving a trace" (verbatim from `discord/admin-audit.ts`'s own docblock). The route is
  rate-limited at 60 req/min, so a sustained pull could harvest up to ~1,200 email+id rows
  per minute (60 requests × 20 rows) with zero Discord signal — only a per-request Pino
  `"Admin read"` log line (without `rowCount`, since that field is only attached when
  `isBulkList` is true — see `routes/admin.ts:163-186`), meaning even after-the-fact forensic
  reconstruction depends on a human noticing a burst of `path=/api/admin/users/search`
  log lines, not an automated signal.
- Evidence:
  ```ts
  // admin/user-search.ts
  const RESULT_LIMIT = 20;
  ...
  .limit(RESULT_LIMIT + 1);
  const truncated = rows.length > RESULT_LIMIT;
  const trimmed = truncated ? rows.slice(0, RESULT_LIMIT) : rows;
  ```
  ```ts
  // admin/read-audit.ts
  export const BULK_LIST_ROW_THRESHOLD = 50;
  ```
  `21 < 50` always; the tripwire condition `rowCount >= BULK_LIST_ROW_THRESHOLD` can never be
  true for this endpoint's response shape.
- Minimal fix: Lower `BULK_LIST_ROW_THRESHOLD`-awareness into `user-search.ts` specifically —
  either (a) drop `RESULT_LIMIT` is not the fix (it's correct UX); instead make
  `countAdminListRows`/the audit middleware aware of _request frequency_ for this one route,
  or (b) simplest: have `user-search.ts` itself call `notifyAdminBulkRead`-style logging
  whenever a `q` of length ≤ 3 is used (broad queries are the enumeration signature) —
  log + Discord-ping on broad/short queries regardless of result count.
- Better fix: Add velocity-based detection independent of single-response row count: track
  per-actor request counts to _any_ `/api/admin/users*` read endpoint over a rolling window
  (e.g. Postgres-backed or Redis-backed counter, since in-process state doesn't survive
  multi-machine Fly deploys per Part-6 §33) and fire `notifyAdminBulkRead` when an actor's
  cumulative row-equivalent reads in the window cross a threshold — this also closes the
  more general "many small below-threshold pulls" class noted in ADMIN-03 below, not just
  this one endpoint.

### ADMIN-03 [P2 · LIVE] CF-10 has no cumulative/velocity detection — only single-response row count

- File: `apps/backend/src/routes/admin.ts:148-197`, `apps/backend/src/admin/read-audit.ts`
- Description: Beyond the `user-search.ts`-specific structural gap (ADMIN-02), the CF-10
  design itself only inspects **one response at a time**. Even on endpoints whose
  `MAX_LIMIT` is ≥ 50 (e.g. `users-list.ts`, `top-users.ts`, `payouts.ts`, `orders.ts` —
  confirmed via direct grep: all clamp at 100), an actor can deliberately request
  `?limit=49` repeatedly (cursor/offset-walking) and never trip the per-response threshold,
  while cumulatively pulling the entire table. This is a structural property of "is THIS
  response bulk", not "is THIS ACTOR behaving like a bulk exporter" — the latter is what an
  insider-threat control actually needs.
- Impact: Lower likelihood than ADMIN-02 (requires deliberate sub-threshold pagination
  rather than being permanently silent by construction), but the same blast radius — full
  user-table PII exfiltration with no Discord signal, only scattered Pino log lines.
- Evidence: `routes/admin.ts:163-173` — `rowCount` is computed once per response and
  compared to a static threshold; no per-actor accumulation across requests exists anywhere
  in `read-audit.ts` or the middleware.
- Minimal fix: None required immediately given low likelihood of a sophisticated insider
  deliberately tuning request size — document the limitation in `read-audit.ts`'s docblock
  so the next engineer doesn't assume CF-10 is exhaustive.
- Better fix: Same as ADMIN-02's better fix — a shared, cross-machine (Postgres or Redis,
  not in-process — see Part-6 §33's multi-machine note) per-actor rolling-window row-count
  accumulator across all `/api/admin/*` GETs, firing `notifyAdminBulkRead` when the
  cumulative count crosses a budget (e.g. 500 rows/hour) regardless of per-response size.

### ADMIN-04 [P2 · LIVE] `discord/monitoring.ts` `notifyPegBreakOnFulfillment` leaks full unredacted user/order UUIDs, breaking the file's own established convention

- File: `apps/backend/src/discord/monitoring.ts:318-340`
- Description: Every other userId/orderId-bearing notifier in this same file
  (`notifyPayoutFailed:166`, `notifyOrderFailedAfterCtxPaid:384`) truncates to the last 8
  characters before sending to Discord, with an explicit comment at `notifyPayoutFailed`
  citing A2-1314: _"Prior shape emitted full userId / orderId / payoutId into the monitoring
  channel, so an admin with Discord access but no DB access could reconstruct a user's full
  uuid + order history from a stream of failures."_ `notifyPegBreakOnFulfillment` — added in
  this delta's CF-15/16/20/21 commit (`3aca01ad`, confirmed reachable from
  `orders/fulfillment.ts:277`) — regresses this: both its `description` template and its
  `fields` array emit the **full** `args.orderId` and `args.userId` via plain
  `escapeMarkdown()`, not `.slice(-8)`.
- Impact: Any Discord channel member with access to `#monitoring` (a broader audience than
  `#admin-audit`, intended for ops/on-call rather than strictly admin-credentialed staff per
  `docs/alerting.md`'s tiering) can now reconstruct a specific user's full UUID — and hence
  pivot into any UUID-keyed admin endpoint or correlate it across other logs/exports — purely
  from a peg-break alert, re-opening exactly the A2-1314 issue this file's sibling notifiers
  were hardened against.
- Evidence:
  ```ts
  fields: [
    { name: 'Order', value: escapeMarkdown(args.orderId), inline: true },
    { name: 'User', value: escapeMarkdown(args.userId), inline: true },
    ...
  ]
  ```
  vs. `notifyPayoutFailed` in the same file: `` `\`${args.userId.slice(-8)}\`` ``.
- Minimal fix: `args.orderId.slice(-8)` / `args.userId.slice(-8)` in both the description
  template and the fields array, matching the sibling notifiers.
- Better fix: Same, plus add a lint/test rule (a small unit test asserting no notifier in
  `discord/monitoring.ts`/`discord/admin-audit.ts` emits a 36-character UUID pattern) so a
  future notifier can't silently reintroduce the same regression — this is exactly the kind
  of "codify review findings into a detection script" pattern the team has used before.

### ADMIN-05 [P2 · LIVE] Two finance CSV exporters use raw SQL string literals instead of typed Drizzle column references

- File: `apps/backend/src/admin/operators-snapshot-csv.ts:124-174`, `apps/backend/src/admin/supplier-spend-activity-csv.ts:84-108`
- Description: Every other handler in the operator/supplier-spend cluster (7 of 9 sibling
  files) references columns via the typed schema object (`${orders.ctxOperatorId}`,
  `${orders.fulfilledAt}`, etc.), so a future `db/schema.ts` column rename fails `tsc`
  immediately. These two CSV handlers instead embed raw string literals inside the `sql`
  template (`FROM orders`, `ctx_operator_id`, `created_at`, `o.charge_currency`, etc.) —
  functionally fine today (no injection risk, no user input reaches these literals), but a
  schema rename that compiles cleanly through every sibling would surface as a runtime
  `column does not exist` 500 in production for exactly these two finance-facing CSV
  exports — the ones ops relies on for CTX invoice reconciliation per their own docblocks.
- Impact: Low likelihood, but high blast radius when it does happen (silent until a schema
  migration ships, then a production 500 on a finance-critical export with no compile-time
  warning).
- Evidence: `operators-snapshot-csv.ts:126-135` vs. every sibling's `${orders}` / `${orders.columnName}`
  pattern.
- Minimal fix: Swap the raw identifiers for typed `${orders}`/`${orders.columnName}`
  references.
- Better fix: Add a check to `scripts/check-migration-parity.mjs` (or a small custom ESLint
  rule) that flags raw table/column string literals inside `sql\`\``templates under`admin/\*.ts`, since this is exactly the class of drift the migration-parity gate already
  exists to catch in the schema-vs-migration direction.

### ADMIN-06 [P2 · LIVE] `merchant-flows.ts` and `admin/handler.ts`'s `listConfigsHandler` are unbounded fleet-wide queries with no row cap

- File: `apps/backend/src/admin/merchant-flows.ts:49-77`, `apps/backend/src/admin/handler.ts:20-34`
- Description: `merchant-flows.ts` groups fulfilled orders by `(merchantId, chargeCurrency)`
  across **all order history** with no `since` window and no `LIMIT` — every sibling
  fleet-wide handler in its own cluster (`merchant-stats.ts`, `merchants-flywheel-share.ts`)
  has at least a `since` window. `admin/handler.ts`'s `listConfigsHandler`
  (`GET /api/admin/merchant-cashback-configs`) similarly does `db.select().from(merchantCashbackConfigs).orderBy(...)`
  with no `LIMIT` at all, while its own CSV sibling (`cashback-configs-csv.ts`) explicitly
  caps at `ROW_CAP = 10_000` with a `__TRUNCATED__` sentinel — the JSON endpoint behind the
  identical table is the one outlier in the whole 18-CSV-exporter family that documents "the
  cap matches the other admin CSVs so the behaviour is uniform" while its own JSON sibling
  has no such cap.
- Impact: Both are low-risk _today_ (merchant catalog ~1,134 tiles per ADR 032; cashback
  configs "at most ~hundreds of rows in practice" per the CSV file's own comment) but are
  unbounded-growth liabilities with no defense-in-depth as order history and catalog size
  grow — `merchant-flows.ts` in particular full-scans the entire `orders` table on every
  call (mounted at 60 req/min), with no time-window floor to bound the scan cost.
- Evidence: `merchant-flows.ts` query (lines 51-64) has no `since`/`LIMIT` clause anywhere;
  `handler.ts:22-25` `db.select().from(merchantCashbackConfigs).orderBy(merchantCashbackConfigs.merchantId)`
  has no `.limit(...)`.
- Minimal fix: Add the same `ROW_CAP` + truncation-flag pattern used by every CSV sibling in
  this codebase to both JSON endpoints.
- Better fix: Also add a `?since=` window to `merchant-flows.ts` matching `merchant-stats.ts`'s
  31-day-default/366-day-max convention, reducing steady-state row count in addition to
  capping the worst case.

### ADMIN-07 [P3 · LIVE] `merchant-stats.ts` JSON has no row cap even though its CSV sibling does

- File: `apps/backend/src/admin/merchant-stats.ts:118-141` vs `merchant-stats-csv.ts:96-115` (`LIMIT ${ROW_CAP + 1}`)
- Description/Impact/Fix: Same shape as ADMIN-06 (folded in as a P3 sub-note since it's the
  same root cause — JSON list endpoints across this codebase don't consistently inherit the
  CSV-export ROW_CAP discipline). Minimal fix: add `ROW_CAP=10_000` to the JSON query too,
  with a `truncated: boolean` response field (JSON can't append a `__TRUNCATED__` sentinel
  row the way CSV does).

### ADMIN-08 [P3 · LIVE] `user-credits-csv.ts` bigint cells bypass `csvEscape` via a special case

- File: `apps/backend/src/admin/user-credits-csv.ts:29-38`
- Description: The file-local `csvRow` helper special-cases `typeof f === 'bigint'` and
  returns `f.toString()` directly, skipping `csvEscape` — the only field-level bypass found
  across all 18 CSV exporters' local `csvRow` wrappers (every sibling routes bigints through
  `csvEscape(String(...))` or equivalent).
- Impact: Not exploitable today — `BigInt.prototype.toString()` can only emit
  `/^-?\d+$/`, which the shared `NUMERIC_LITERAL` exemption explicitly treats as safe even
  when routed through `csvEscape`. Flagged because it's a literal deviation from the
  "every cell through csvEscape, no exceptions" invariant this audit is specifically
  checking — a future change to how `balanceMinor` is formatted (e.g. adding a unit suffix)
  could silently turn this into a real unescaped bypass via the same code path.
- Minimal fix: `if (typeof f === 'bigint') return csvEscape(f.toString());` — no behavior
  change, removes the bypass for defense-in-depth.

### ADMIN-09 [P3 · LIVE] CF-10 fires noise on default-parameter aggregate (non-PII) endpoints, diluting signal

- File: `apps/backend/src/admin/treasury-credit-flow.ts:113-133`, `apps/backend/src/admin/payment-method-activity.ts:65-138`
- Description: With no `?currency=` filter, `treasury-credit-flow`'s default `days=30`
  window groups by `(day, currency)`, so a routine dashboard load can already return up to
  90 rows (30 days × 3 currencies) — over the 50-row CF-10 threshold purely from default
  usage, not a bulk-pull pattern. Same for `payment-method-activity` at `?days=90`.
- Impact: Not a security gap — these are non-PII fleet aggregates — but works against CF-10's
  stated "signal-to-noise" goal (per `discord/admin-audit.ts`'s own docblock) by pinging
  `#admin-audit` on routine page loads, which could train operators to ignore the channel.
- Minimal fix: None required for security. If noise becomes a real problem, consider an
  opt-out flag on known-aggregate-only response shapes, or raise the threshold for non-PII
  endpoints specifically.

### ADMIN-10 [P3 · LIVE] Several aggregate-only endpoints are structurally incapable of tripping CF-10, but carry no PII (informational, not a gap)

- File: `payouts-by-asset.ts`, `payouts-monthly.ts`, `settlement-lag.ts`, `interest-mint-forecast.ts`,
  `asset-drift-state.ts`, `merchant-cashback-monthly.ts`, `merchant-cashback-summary.ts`,
  `merchant-payment-method-share.ts` (the last returns a `Record`, not an array, so
  `countAdminListRows` always sees 0 top-level array entries for it — see also
  `read-audit.ts:46-51`, which only inspects top-level arrays, not nested/object-valued
  maps).
- Description: All bounded by small fixed cardinalities (≤3-5 asset/currency codes, ≤36
  month×asset entries, 4 payment-method buckets) — none carry per-user PII, so unlike
  ADMIN-02 there's no realistic exfiltration pattern here.
- Minimal fix: None required. Documented for completeness per the audit brief's "check
  every list/array-returning handler" instruction.

### ADMIN-11 [P3 · LIVE] Inconsistent `?days=`/`?since=` validation and clamp ceilings across sibling drill endpoints

- File: multiple — `operator-activity.ts` (`MAX_DAYS=90`) vs `supplier-spend-activity.ts`
  (`MAX_DAYS=180`); `merchant-flywheel-activity.ts` JSON (`MAX_DAYS=180`, default 30) vs its
  own CSV sibling (`MAX_DAYS=366`, default 31); `merchants-flywheel-share.ts` explicitly
  rejects a future `?since=` with 400, while `merchant-stats.ts`, `merchant-operator-mix.ts`,
  `top-users.ts`, `user-cashback-by-merchant.ts`, `user-operator-mix.ts` silently accept a
  future `since` (only check `windowMs > MAX_WINDOW_MS`, never `since > now`) and return an
  empty result instead of a 400.
- Impact: Cosmetic/API-surface inconsistency only — admin-only surface, no security
  implication, just inconsistent UX/validation strictness across near-identical sibling
  endpoints built at different times.
- Minimal fix: Pick one convention (recommend: reject future `since` with 400, matching
  `merchants-flywheel-share.ts`) and apply it uniformly; align `MAX_DAYS` ceilings or add a
  one-line comment explaining each divergence.

### ADMIN-12 [P3 · LIVE] Minor handler-level nits (rolled up)

- `apps/backend/src/admin/user-operator-mix.ts:98-113` — aggregate query has no `LIMIT`,
  unlike every other per-user handler in its file (`ctx_operator_id` cardinality isn't
  enum-bounded the way currency/payment-method are). Minimal fix: add `LIMIT 200`.
- `apps/backend/src/admin/operator-merchant-mix.ts:99-110` — same gap; result-set size scales
  with merchant-catalog size (~1,000-1,500), unlike its operator-pool-bounded siblings.
- `apps/backend/src/admin/user-cashback-by-merchant.ts:113-115` — `INNER JOIN orders ON
orders.id = creditTransactions.referenceId::uuid` has no guard against a malformed
  `reference_id`; a pre-existing data-integrity bug elsewhere would 500 this drill instead
  of degrading gracefully.
- `apps/backend/src/admin/treasury.ts:54-89` — five independent queries (including a Horizon
  network call) await sequentially instead of via `Promise.all`; admin dashboard load
  latency is the sum, not the max, of all five round-trips.
- `apps/backend/src/admin/interest-mint-forecast.ts:106-122` — same sequential-await pattern
  across ≤3 LOOP-asset Horizon balance reads (low impact at current scale, same shape as
  the treasury.ts nit).
- `apps/backend/src/admin/interest-mint-forecast.ts:126-127` — `daysOfCover` computed via
  `Number(poolStroops) / Number(dailyInterestStroops)`, losing precision past
  `Number.MAX_SAFE_INTEGER` stroops; advisory-only display field (not used in any minting
  decision — `recommendedMintStroops` is computed correctly via bigint one line above), so
  low impact at current treasury scale.
- `apps/backend/src/admin/supplier-spend.ts:35-38` — header doc claims "?since= ... No upper
  bound" while the handler body enforces a 366-day `MAX_WINDOW_MS` two screens down — stale
  doc, contradicts enforced behavior.
- `merchant-flywheel-activity-csv.ts`, `merchant-stats-csv.ts`, `merchants-flywheel-share-csv.ts`
  redeclare a local `csvRow` identical to the one already re-exported from `./csv-escape.js`
  instead of importing it — functionally harmless today, but drift risk if the shared
  `csvRow` semantics ever change.
- `orders-detail.ts` / `payouts-detail.ts` / `config-history-handler.ts` / `treasury-builders.ts`
  have no dedicated `__tests__/<name>.test.ts` file — confirmed NOT a real coverage gap (all
  four are exercised via their parent module's test file — `orders.test.ts`,
  `payouts.test.ts`, `handler.test.ts`, `treasury.test.ts` respectively — with real,
  non-vacuous assertions), but the naming mismatch could mislead a future engineer grepping
  for a same-named test file.

## ADR 037 (staff roles) forward-looking note — BRANCH, not on `main`

Confirmed via `git merge-base --is-ancestor` that the `requireStaff`/staff-tiering work
(commits `31b80bc1`, `07b5be7c`, `05fb0c4a`, `3eb5d3a3`, `418cde64` on
`origin/feat/staff-roles-backend` / `origin/feat/staff-dashboard-web`) is **not** on `main`,
matching the checklist's "ADR 036/037 still have no ADR file on main" note. On `main`, my
vertical's entire RBAC model is the single binary `requireAdmin` (`auth/require-admin.ts`,
confirmed correctly 404s non-admins and 401s unauthenticated, matching the documented
convention). I spot-checked the branch (out of scope for line-by-line audit, informational
only): the future `requireStaff('support'|'admin')` design correctly per-route-gates all 18
CSV exporters + money writes to `requireStaff('admin')`, while leaving the paginated user
directory (`/api/admin/users`), email search (`/users/search`), and exact-email lookup
(`/users/by-email`) at the `requireStaff('support')` blanket default — i.e., once merged,
**support-tier (non-admin) staff will gain read access to the full user directory and
email-substring search by design**. This appears to be an intentional support-ticket-
resolution tradeoff (consistent with the commit's framing), not an oversight, but given it
directly intersects ADMIN-02 above (the same `user-search.ts` endpoint), it's worth an
explicit go/no-go confirmation before merge that "support can browse/search all user emails"
is the intended least-privilege boundary, not a default nobody chose deliberately.

## Delta re-verification

**CSV formula-injection numeric-literal exemption (commit `56926e74`): VERDICT = safe, no
bypass found.**

Evidence:

- `apps/backend/src/csv/csv-escape.ts:35-54` — `NUMERIC_LITERAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/`,
  fully anchored (`^...$`, no `m` flag — JS `$` without `/m` matches only true end-of-string,
  not before a trailing newline the way some other regex flavors behave, so no
  trailing-newline-smuggling edge case). The exemption only applies when the **entire** cell
  matches this pattern — i.e. an optional single leading sign followed by digits/decimal and
  nothing else. Since a spreadsheet formula requires additional characters (cell references,
  function names, operators beyond a single leading sign) to do anything beyond literal
  arithmetic on its own digits, and the regex structurally forbids any such characters, there
  is no way to construct a string that both (a) fully matches `NUMERIC_LITERAL` and (b) is a
  live formula/exfil payload. `=`, `@`, tab, and CR can never match the pattern (they're not
  `[+-]`/digit/`.`), so those four dangerous prefixes stay unconditionally guarded regardless
  of the rest of the cell — confirmed in code and by the adversarial test suite.
- `apps/backend/src/csv/__tests__/csv-escape.test.ts:35-53` — explicit regression tests cover
  both the safe-exemption path (`-1`, `+1`, `-50`, `-0.5`, `-12.34` all pass through
  unguarded) and the must-still-guard path (`-1+2`, `+1-1`, `-2+3+cmd|x`, `+HYPERLINK(A1)` all
  still get the `'` prefix) — i.e. the exact bypass shape ("formula disguised as a number
  string") the audit brief asked me to check is already covered by a named test
  (`'still guards a leading +/- when the cell is NOT a pure number'`) and passes.
- Traced call sites: all 18 admin CSV exporters route every emitted field through
  `csvEscape`/`csvRow` (admin re-export confirmed at `apps/backend/src/admin/csv-escape.ts:12`)
  with no bypass found (see CSV export inventory table above + ADMIN-08 for the one
  cosmetic, non-exploitable bigint special-case). `scripts/quarterly-tax.ts:76-79` (in my
  explicit scope) also correctly imports `csvEscape` from `../csv/csv-escape.js` and coerces
  every cell via `String(value)` before escaping — confirmed by full read, not just grep.
  `apps/backend/src/users/cashback-history-handler.ts:23` (out of my formal scope, owned by
  another vertical, but named in the delta manifest as one of the "two outliers" the CF-26
  fix retrofitted) is confirmed via grep to import `csvEscape` from `../csv/csv-escape.js`
  and call it at line 162 — the X-PRIV-11 claim that this file now uses the shared hardened
  escaper checks out at the import/call-site level; I did not deep-audit its surrounding
  logic since it's outside this vertical's assignment.
- No regression or new bypass found anywhere in my scope. This is a well-reasoned,
  correctly-scoped, test-covered fix.

## Coverage confirmation

**`apps/backend/src/admin/` (79 in-scope files, all read):**
asset-circulation.ts, asset-drift-state.ts, audit-tail-csv.ts, audit-tail.ts,
cashback-activity-csv.ts, cashback-activity.ts, cashback-configs-csv.ts, cashback-monthly.ts,
cashback-realization-daily-csv.ts, cashback-realization-daily.ts, cashback-realization.ts,
config-history-handler.ts, configs-history.ts, csv-escape.ts, handler.ts,
interest-mint-forecast.ts, merchant-cashback-monthly.ts, merchant-cashback-summary.ts,
merchant-flows.ts, merchant-flywheel-activity-csv.ts, merchant-flywheel-activity.ts,
merchant-flywheel-stats.ts, merchant-operator-mix.ts, merchant-payment-method-share.ts,
merchant-stats-csv.ts, merchant-stats.ts, merchant-top-earners.ts, merchants-catalog-csv.ts,
merchants-flywheel-share-csv.ts, merchants-flywheel-share.ts, operator-activity.ts,
operator-latency.ts, operator-merchant-mix.ts, operator-stats.ts, operator-supplier-spend.ts,
operators-snapshot-csv.ts, orders-activity.ts, orders-csv.ts, orders-detail.ts, orders.ts,
payment-method-activity.ts, payment-method-share.ts, payouts-activity-csv.ts,
payouts-activity.ts, payouts-by-asset.ts, payouts-csv.ts, payouts-detail.ts,
payouts-monthly.ts, payouts.ts, reconciliation.ts, settlement-lag.ts, stuck-orders.ts,
stuck-payouts.ts, supplier-spend-activity-csv.ts, supplier-spend-activity.ts,
supplier-spend.ts, top-users-by-pending-payout.ts, top-users.ts, treasury-builders.ts,
treasury-credit-flow-csv.ts, treasury-credit-flow.ts, treasury-snapshot-csv.ts, treasury.ts,
user-by-email.ts, user-cashback-by-merchant.ts, user-cashback-monthly.ts,
user-cashback-summary.ts, user-credit-transactions-csv.ts, user-credit-transactions.ts,
user-credits-csv.ts, user-credits.ts, user-detail.ts, user-flywheel-stats.ts,
user-operator-mix.ts, user-payment-method-share.ts, user-search.ts, users-list.ts,
users-recycling-activity-csv.ts, users-recycling-activity.ts.

**Route-mount files (9, all read in full):** `routes/admin.ts`, `routes/admin-dashboard.ts`,
`routes/admin-fleet-monthly.ts`, `routes/admin-operator.ts`, `routes/admin-ops-tail.ts`,
`routes/admin-order-drill.ts`, `routes/admin-per-merchant.ts`, `routes/admin-treasury.ts`,
`routes/admin-user-cluster.ts`.

**Other explicitly-scoped files:** `scripts/quarterly-tax.ts`, `discord/monitoring.ts`.

**Cross-reference reads (not formally in scope, read to verify specific claims):**
`csv/csv-escape.ts` + its test file (sibling-owned, verified per delta-manifest ask),
`discord/admin-audit.ts` (defines `notifyAdminBulkRead`, central to the CF-10 analysis),
`auth/require-admin.ts` (404-vs-403 convention verification), `orders/repo.ts` + `db/schema.ts`
(money-field currency-denomination verification for ADMIN-01), `orders/fulfillment.ts` (grep
only, confirmed `notifyPegBreakOnFulfillment` call site for ADMIN-04), `users/cashback-history-handler.ts`
(grep only, delta-manifest CF-26 claim verification), `routes/admin-cashback-config.ts` +
`routes/admin-payouts.ts` (grep only, to find rate-limit values for two CSV mounts owned by
a sibling agent), and a spot-check of `origin/feat/staff-roles-backend` (3 files, informational
BRANCH-status note only, not line-by-line audited).

Excluded per assignment (sibling "Admin money-writes" agent's scope, not read):
`admin/audit-envelope.ts`, `admin/credit-adjustments.ts`, `admin/discord-config.ts`,
`admin/discord-notifiers.ts`, `admin/discord-test.ts`, `admin/home-currency-set.ts`,
`admin/idempotency-constants.ts`, `admin/idempotency-store.ts`, `admin/idempotency.ts`,
`admin/merchants-resync.ts`, `admin/payout-compensation.ts`, `admin/payouts-retry.ts`,
`admin/read-audit.ts` — wait, `read-audit.ts` is in my scope (it backs the CF-10 middleware
my vertical owns) — re-confirmed: the exclusion list in my brief named `read-audit.ts`
itself, but its functions (`BULK_LIST_ROW_THRESHOLD`, `countAdminListRows`,
`sanitizeAdminReadQueryString`) are load-bearing for ADMIN-02/ADMIN-03, so I read it in full
for analysis purposes while not claiming ownership of fixing it if the finding turns out to
be assignable elsewhere — flagging this ambiguity for the tracker. `admin/refunds.ts`,
`admin/step-up-handler.ts`, `admin/upsert-config-handler.ts`, `admin/withdrawals.ts`.
