# Cross-Cutting Sweep 12 — Code Quality / Dead-Code / DRY — Cold Audit (2026-06-15)

Sweep owner: whole tree (`apps/backend/src`, `apps/web/app`, `packages/shared/src`,
tracked `tools/` + `scripts/`). Checklist refs: §14 (Code quality, DRY &
maintainability) + Part 5 cross-cutting passes #2 (`any`/type-escape) and #12
(dead-code/unused-export).

Applied dimensions: `any`/type-escapes vs the allowed proto-bridge carve-out;
dead code / orphaned modules / unused exports; DRY (money formatting, slug, FX,
cashback math, CSV, stroops conversion, redaction regex); TODO/FIXME/HACK/XXX
hygiene; magic numbers/strings; oversized files; module-boundary / layering
(web↔native↔backend); lint + format cleanliness on tracked source.

## Coverage

- **`any`/type-escape sweep (whole tracked tree):** grepped all `*.ts`/`*.tsx`
  for `: any`, `as any`, `@ts-expect-error`, `@ts-ignore`, `eslint-disable …
no-explicit-any`. Every site read in context. Result: **8 `as any`, 1
  `@ts-expect-error`, 0 `@ts-ignore`, 0 `: any` annotations, 5 eslint-disable
  pragmas** — all accounted for (see §any sweep). The proto-bridge carve-out is
  the only production `any`, and it carries the documented `eslint-disable`.
- **Lint:** `npx eslint apps/backend/src apps/web/app packages/shared/src
--ext .ts,.tsx` → exit 0, **zero output** (clean, max-warnings honored).
- **Format:** `npx prettier --check` over all 1,032 tracked `.ts/.tsx` source
  files → "All matched files use Prettier code style!" (clean).
- **TODO/FIXME/HACK/XXX inventory:** grepped tracked `apps/`, `packages/`,
  `tools/`, `scripts/` (`.ts/.tsx/.mjs/.js/.sh`). Full inventory below.
- **Dead-code / unused-export sweep:** import/usage graphs built by grep across
  backend + web + shared; every candidate orphan read to confirm zero
  production importers. Two sub-agent scouts ran the backend and web graphs;
  every high-value claim independently re-verified here by grep (apy-snapshot,
  hmac-verify, geo.ts, FixedSearchButton, formatStroops, STELLAR_NETWORKS,
  csvRow, STROOPS_PER_MINOR all confirmed).
- **DRY clusters:** money formatting, slug, FX, cashback math, stroops, CSV,
  redaction regex, currency-symbol tables — each cluster's canonical home and
  every duplicate site enumerated and read. Full cluster list below.
- **File size:** largest tracked source files enumerated (top = `schema.ts` 964
  lines — expected for a Drizzle schema; no runaway component/handler files).
- **Untracked tooling excluded** per brief (0 untracked `.ts/.tsx` in
  apps/packages; the untracked `scripts/*.mjs` are the known operator one-shots).

### `any` / type-escape sweep — full enumeration (all benign)

| Site                                                                                | Kind                                     | Verdict                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/services/clusters.ts:76-102`                                          | proto-bridge `any` ×5 + 4 eslint-disable | **Allowed** — the documented dynamic-import proto bridge (AGENTS.md rule #6); carries `eslint-disable @typescript-eslint/no-explicit-any` |
| `apps/backend/src/clustering/handler.ts:117-125`                                    | proto-bridge `any` ×2 + eslint-disable   | **Allowed** — same proto-bridge carve-out, backend side                                                                                   |
| `apps/web/app/components/features/admin/__tests__/MerchantResyncButton.test.tsx:49` | `HTMLDialogElement.prototype as any`     | Test-only jsdom shim — fine                                                                                                               |
| `apps/web/app/components/features/admin/__tests__/StepUpModal.test.tsx:32`          | `HTMLDialogElement.prototype as any`     | Test-only jsdom shim — fine                                                                                                               |
| `apps/web/app/routes/__tests__/not-found.test.ts:17`                                | `@ts-expect-error`                       | Test-only; deliberate bad-args throw — fine                                                                                               |

No stray `any`, no `@ts-ignore`, no `: any` annotations anywhere in tracked
source. The codebase's "no `any` except the proto bridge" rule (AGENTS.md
critical rule #6) holds exactly.

## Findings

### P3-QUAL-01 — Web money-formatting duplicated across 15 components (3 helpers named `formatMinor`, all identical)

- **Severity:** P3 (quality / maintainability) — no correctness bug today, but a
  rounding/locale change must be made in ~15 places, and the bigint-overflow
  class flagged in `v-shared.md` P2-SHARED-01 silently bypasses the safe helper
  everywhere this pattern is used.
- **Files:** 15 non-test web files each inline
  `new Intl.NumberFormat(locale, { style:'currency', currency }).format(n/100)`
  with a `try/catch` fallback, wrapped in ~11 differently-named local helpers:
  - 3 literally named `formatMinor` (identical body):
    `components/features/admin/CashbackRealizationCard.tsx:118`,
    `components/features/cashback/MonthlyCashbackChart.tsx:220`,
    `components/features/orders/OrdersSummaryHeader.tsx:90`
    (+ bigint variant `components/features/admin/AssetCirculationCard.tsx:50`)
  - `fmtCashback` (`admin/UserCashbackByMerchantTable.tsx:17`,
    `cashback/CashbackByMerchantCard.tsx:15`), `fmtBalance`
    (`cashback/CashbackBalanceCard.tsx:14`), `fmtEarnings`
    (`cashback/CashbackEarningsHeadline.tsx:12`), `formatCashbackMinor`
    (`cashback/CashbackCalculator.tsx:44`), `fmtPositiveMinor`
    (`admin/TopUsersTable.tsx:22`), `fmtPerCurrency`
    (`home/CashbackStatsBand.tsx:10`), plus inline in
    `admin/CreditTransactionsTable.tsx:32`, `home/CashbackStatsBand.tsx:14`,
    `cashback/PendingCashbackChip.tsx:50`, `routes/auth.tsx:167,226`,
    `routes/settings.cashback.tsx:63`.
- **Impact:** `@loop/shared` already has the bigint-safe `formatMinorCurrency`,
  and web already has `i18n/format.ts#formatCurrency` (currently dead — see
  P2-QUAL-02). All 15 sites should converge on one helper.
- **Fix:** finish the ADR 034 Phase 3 migration (P2-QUAL-02): export one
  `formatMinorCurrency(minor, currency, locale)` from `i18n/format.ts` and route
  all 15 sites through it. Kills this cluster and the orphaned exports below in
  one move.
- **Req ref:** ADR 019 (shared/DRY), checklist §14, §23 (i18n money-format).

### P2-QUAL-02 — ADR 034 money-formatter migration stalled: `i18n/format.ts` formatters are dead, `utils/money.ts` lives on (two parallel currency helpers)

- **Severity:** P2 (medium) — dead shipped code + a parallel-implementation trap.
  ADR 034 Phase 5 ("retire the region store") **merged** (commit `f29cc39c`),
  but the Phase-3 step it documents — migrating consumers to `i18n/format.ts`
  and deleting `utils/money.ts` in Phase 5 — never happened.
- **Files:**
  - `apps/web/app/i18n/format.ts:37,53,67` — `formatCurrency`,
    `currencySymbol`, `formatNumber` have **zero production importers** (only
    `i18n/__tests__/locale.test.ts`). Only `localeTag` (l.26) is live (used by
    `i18n/seo.ts`). The file header (l.15-16) explicitly claims it "supersedes
    the ad-hoc helpers in `utils/money.ts`; … `utils/money.ts` is removed in
    Phase 5."
  - `apps/web/app/utils/money.ts` — still the live helper: `formatMoney` /
    `currencySymbol` imported by `MerchantCard.tsx`, `home/MobileHome.tsx`,
    `purchase/AmountSelection.tsx`, `purchase/EarnedCashbackCard.tsx`,
    `routes/gift-card.$name.tsx`, `routes/orders.tsx`, `routes/orders.$id.tsx`.
- **Impact:** the locale-aware seam (the whole point of ADR 034: render £/€ with
  correct separators driven by the URL's country segment) is shipped but unused;
  real money still flows through the locale-agnostic legacy helper. Two
  same-named `currencySymbol` exports invite import-the-wrong-one bugs. Stale
  docstring lies about the migration state.
- **Fix:** either complete Phase 3 (migrate the 7 `utils/money.ts` importers +
  the 15 inline sites in P3-QUAL-01 to `i18n/format.ts`, then delete
  `utils/money.ts`) or, if the migration is deliberately parked, correct the
  `format.ts` header and either delete the unused formatters or document them as
  pending. Either way, don't ship two live currency formatters.
- **Req ref:** ADR 034, checklist §5 (doc↔code drift), §14, §23.

### P3-QUAL-03 — `csvRow` re-implemented as 17 byte-identical private copies despite a shared export

- **Severity:** P3.
- **Files:** `apps/backend/src/admin/csv-escape.ts:57` **already exports**
  `csvRow(fields)`. 20 local `csvRow` declarations exist across the admin CSV
  exporters; **17 are byte-identical** to the export
  (`values.map((v) => csvEscape(v ?? null)).join(',')`) and ignore it —
  e.g. `audit-tail-csv.ts:44`, `cashback-activity-csv.ts:37`, `orders-csv.ts:65`,
  `payouts-csv.ts:56`, `merchants-catalog-csv.ts:51`, `treasury-snapshot-csv.ts:38`
  (full list in the DRY cluster table). The `csv-escape.ts` docstring (l.49-56)
  claims callers keep their own `csvRow` "to coerce" — but these 17 do no
  coercion; only `user-credits-csv.ts:29` and `scripts/quarterly-tax.ts:75`
  (Date/bigint coercion) actually justify a local wrapper.
- **Fix:** import `csvRow` from `./csv-escape.js` in the 17 identical files,
  delete the copies; standardize the 2 coercing variants. Update the docstring.
- **Req ref:** ADR 019, ADR 018 (CSV exports), checklist §14.

### P3-QUAL-04 — Stellar decimal↔stroops conversion duplicated 5× + `STROOPS_PER_MINOR` constant 5× (money-correctness risk class)

- **Severity:** P3 (quality), but money-correctness-adjacent: a wrong copy
  mis-prices a mint or payout.
- **Files:** `apps/backend/src/payments/stroops.ts:27` was created as the
  canonical `parseStroops` (its own docstring: "Centralising prevents drift"),
  yet:
  - **Byte-identical private `parseStroops` copies:**
    `payments/horizon-trustlines.ts:79`, `payments/horizon-asset-balance.ts:65`.
  - **Same job, regex/null variants:** `payments/horizon-circulation.ts:86`
    (`amountToStroops`), `orders/pay-ctx.ts:99` (`decimalToStroops`, nullable).
  - **stroops→string format duplicated:** `payments/sep7.ts:28` (`formatStroops`,
    exported but only used in-file — confirmed zero external importers),
    `payments/payout-submit.ts:96` (`stroopsToAmount`, private, no sign branch).
  - **`STROOPS_PER_MINOR = 100_000n` redeclared** in `asset-drift-watcher.ts:47`,
    `interest-pool-watcher.ts:41`, `admin/interest-mint-forecast.ts:39`,
    `admin/asset-circulation.ts:51`, and as `LOOP_ASSET_STROOPS_PER_MINOR` in
    `credits/payout-builder.ts:112`; plus `10_000_000n` (stroops-per-XLM) inline
    in 6 parse/format sites.
- **Fix:** make `payments/stroops.ts` own both directions + export
  `STROOPS_PER_MINOR` / `STROOPS_PER_XLM`; point all sites at it (nullable option
  for pay-ctx's fail-closed contract). Could later graduate to `@loop/shared`.
- **Req ref:** ADR 019, ADR 016 (payout submit), checklist §14, §25.

### P3-QUAL-05 — Orphaned / dead modules + unused exports (backend + web)

- **Severity:** P3.
- **Backend — modules dead in production (test-only importers, no route mount):**
  - `apps/backend/src/credits/apy-snapshot.ts` — both exports
    (`computeAnnualisedRate`, `computePast30DayApy`) referenced only by their
    test. Built ahead of ADR 031 yield work, never wired.
  - `apps/backend/src/webhooks/hmac-verify.ts` — `verifyHmacWebhook` test-only;
    no route mounts it (the Privy webhook handler gap noted elsewhere).
  - `apps/backend/src/auth/identities.ts:140` `listLinkedIdentities` — test-only.
  - `apps/backend/src/auth/id-token.ts:172` `jwkFingerprint` — zero importers.
  - `apps/backend/src/payments/payout-submit.ts:334`
    `export const STELLAR_NETWORKS` — SDK re-export, zero importers (verified).
  - `apps/backend/src/uuid.ts:21` `isUuid` — zero importers (companion `UUID_RE`
    is heavily used; only the thin wrapper is dead).
  - `payments/sep7.ts:28` `formatStroops` — `export`ed but used only in-file.
  - Test-reset seams with **zero references even in tests**:
    `health.ts:137` `__resetDbProbeCacheForTests`, `auth/jwks.ts:62`
    `__resetJwksInvalidateDebounceForTests`, `kill-switches.ts:107`
    `__resetKillSwitchWarnsForTests`, `payments/payout-worker.ts:191`
    `__resetPayoutWorkerForTests`.
- **Web — fully orphaned (zero importers anywhere):**
  - `apps/web/app/services/geo.ts` (`fetchGeo`) — superseded by
    `routes/home-geo-redirect.tsx` (ADR 034); dead ADR-033 leftover.
  - `apps/web/app/components/features/FixedSearchButton.tsx` — rendered nowhere.
  - `apps/web/app/components/ui/index.ts` — UI barrel; every consumer imports
    the individual files, nothing imports `~/components/ui`.
- **Web — production-orphaned (test-only importers):**
  - `apps/web/app/i18n/t.ts` (`t()` translation seam) — no runtime caller.
  - `apps/web/app/utils/admin-cache.ts` (`invalidateAllAdminQueries`).
  - `apps/web/app/components/features/home/CashbackStatsBand.tsx` and
    `home/FlywheelStatsBand.tsx` — neither rendered by any route/home.
- **Web — unused exports (file not whole-dead):**
  - `stores/auth.store.ts:19` `wasAuthedLastSession` (zero refs),
    `i18n/locale.ts:89` `useLocalizedHref` (zero refs),
    `utils/locale.ts:23` `USER_LOCALE` (zero refs),
    `i18n/format.ts` formatters (P2-QUAL-02), plus dead `services/admin.ts`
    barrel re-exports (`StuckOrdersResponse`/`StuckPayoutsResponse`/
    `AdminUserCreditsResponse`/`TreasuryHolding`).
- **Keep (intentional placeholder, do NOT remove):**
  `apps/web/app/services/stellar-wallet.ts` (self-declared throwing stub pending
  the Stellar Wallets Kit ADR — paired with TODO-01 below).
- **Fix:** delete the genuinely-dead modules/exports; for the test-only feature
  modules (apy-snapshot, hmac-verify, t.ts) decide wire-or-cut and add a ticket.

### P3-QUAL-06 — Smaller DRY clusters + magic-string tables

- **Severity:** P3.
- **Hardcoded currency-symbol tables** (instead of `currencySymbol()`):
  `components/features/admin/CreditFlowChart.tsx:28`
  (`{ USD:'$', GBP:'£', EUR:'€' }`),
  `admin/SupplierSpendActivityChart.tsx:26`,
  `onboarding/screen-wallet-intro.tsx:43`.
- **`marginBps` (`admin/supplier-spend.ts:76`) clones shared `recycledBps`**
  (`packages/shared/src/cashback-realization.ts:27`) — same clamped-bps math;
  docstring admits "a second consumer would earn a lift" — it now exists.
  Extract `clampedBps(num, denom)` in `@loop/shared`.
- **Cashback "minor × rate / 10_000n"** computed 3 ways with different rate
  encodings: `orders/cashback-split.ts:71` (`applyPct`, NUMERIC string),
  `public/cashback-preview.ts:110` (`previewCashbackMinor`, bps),
  `cashback-preview.ts:96` (`cashbackPctToBps` bridge). Should share one
  `applyBps` core so order-creation and the public preview can't disagree on
  rounding.
- **Email-redaction regex `EMAIL_RE`** defined twice:
  `apps/backend/src/upstream-body-scrub.ts:35` and
  `apps/backend/src/sentry-scrubber.ts:48` (plus the Discord-webhook regex).
  Extract one `redaction-patterns.ts`.
- **Admin date / relative-time formatting** hand-rolled under many names
  (`formatRelative`/`fmtRelative`/`formatAgo`/`formatOldestAgo` across
  `UsersRecyclingActivityCard.tsx:120`, `AdminAuditTail.tsx:37`,
  `ConfigsHistoryCard.tsx:101`, `AssetDriftWatcherCard.tsx:86`,
  `PendingCashbackChip.tsx:61`) plus ~55 inline `toLocaleDateString` sites — no
  shared web date util exists.
- **`ORDER_MAX_FACE_VALUE_MINOR = 50_000_00n`** (`orders/loop-handler.ts:60`) is
  a local const while peer minor-unit caps (`ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`)
  live in `env.ts` — inconsistent home for an operationally-tunable cap.

### Verified NOT violations (transparency)

- **FX conversion is properly centralized** — single `convertMinorUnits` +
  `usdcStroopsPerCent` + `requiredStroopsForCharge` in
  `payments/price-feed-fx.ts`, re-exported via the `price-feed.ts` barrel. No
  copies.
- **Slug generation is clean** — backend + web use `@loop/shared`
  `merchantSlug`/`brandSlug` exclusively. The one stray `.toLowerCase().replace`
  in shared (`merchant-groups.ts:38 normalizeKey`) is a whitespace normalizer,
  not a slug. (One cosmetic web slugify at
  `purchase/PurchaseComplete.tsx:66` builds a download _filename_, not a route
  slug — acceptable.)
- **Discord notifier boilerplate** — single `sendWebhook` in `discord/shared.ts`;
  no inline webhook fetches.
- **`csvEscape`** itself correctly shared (20 importers); only the `csvRow`
  wrapper is duplicated (P3-QUAL-03).
- **Module boundaries clean** — no `@capacitor/*` outside `app/native/`; the only
  raw `fetch()` in routes are the two documented loader exceptions
  (`sitemap.tsx`, `home-geo-redirect.tsx`); no backend/CTX imports from web.
- **No commented-out code blocks** anywhere (web + backend triaged; all
  `//`/`/* */` hits are genuine prose/JSDoc/eslint pragmas).
- **No oversized runaway files** — largest source is `db/schema.ts` (964, a
  Drizzle schema, expected); largest component `MobileHome.tsx` (717), largest
  handler `payments/watcher.ts` (444) — all within reason.

## DRY cluster list (consolidated)

| #   | Cluster                           | Canonical home (existing or proposed)                                         | Duplicate sites                                                                                                       | Sev |
| --- | --------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | Web minor→currency string         | `i18n/format.ts#formatCurrency` (exists, dead) / shared `formatMinorCurrency` | 15 components, ~11 local helpers incl. 3× `formatMinor` (P3-QUAL-01)                                                  | P3  |
| 2   | Two parallel web currency helpers | `i18n/format.ts` (intended) vs `utils/money.ts` (live)                        | migration stalled (P2-QUAL-02)                                                                                        | P2  |
| 3   | `csvRow`                          | `admin/csv-escape.ts:57` (exported)                                           | 17 byte-identical private copies                                                                                      | P3  |
| 4   | decimal↔stroops conversion        | `payments/stroops.ts:27`                                                      | horizon-trustlines:79, horizon-asset-balance:65, horizon-circulation:86, pay-ctx:99, sep7:28, payout-submit:96        | P3  |
| 5   | `STROOPS_PER_MINOR = 100_000n`    | (proposed) `payments/stroops.ts` const                                        | asset-drift-watcher:47, interest-pool-watcher:41, interest-mint-forecast:39, asset-circulation:51, payout-builder:112 | P3  |
| 6   | clamped-bps math                  | shared `recycledBps` / proposed `clampedBps`                                  | `admin/supplier-spend.ts:76` `marginBps`                                                                              | P3  |
| 7   | cashback `× rate / 10_000n`       | proposed shared `applyBps`                                                    | cashback-split:71, cashback-preview:110                                                                               | P3  |
| 8   | email/discord redaction regex     | proposed `redaction-patterns.ts`                                              | upstream-body-scrub:35,48, sentry-scrubber:48                                                                         | P3  |
| 9   | currency-symbol literal tables    | `currencySymbol()` helper                                                     | CreditFlowChart:28, SupplierSpendActivityChart:26, screen-wallet-intro:43                                             | P3  |
| 10  | web date / relative-time          | proposed shared date util                                                     | ~55 inline + 5 named relative-time helpers                                                                            | P3  |
| 11  | `ADMIN_LOCALE` Intl rendering     | proposed `formatAdminCurrency`/`Date`                                         | ~39 admin files inline                                                                                                | P3  |

## TODO / FIXME / HACK / XXX inventory (full, tracked source)

| File:line                                                           | Marker                                                | Ticket+date?           | Verdict                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:240` | `TODO(adr-pending): integrate Stellar Wallets Kit v2` | **No ticket, no date** | **Orphan TODO** — has an `(adr-pending)` tag but no JIRA-style ref or date; paired with the `services/stellar-wallet.ts` throwing stub. Should carry a ticket per AGENTS.md "no TODO without a ticket reference or date." |
| `apps/backend/src/images/ssrf-guard.ts:15,145`                      | `XXXX:YYYY`                                           | n/a                    | **Not a marker** — IPv6 address placeholders in a doc comment                                                                                                                                                             |
| `apps/backend/src/payments/sep7.ts:5`                               | `X.XXXXXXX`                                           | n/a                    | **Not a marker** — sample amount string in a doc comment                                                                                                                                                                  |
| `apps/web/app/components/features/home/CashbackStatsBand.tsx:26`    | `£X,XXX`                                              | n/a                    | **Not a marker** — sample headline in a doc comment                                                                                                                                                                       |

- **Real markers:** 1 (`LoopPaymentStep.tsx:240`), and it lacks a ticket/date.
- **No `FIXME`, `HACK`, or genuine `XXX` markers** anywhere in tracked source
  (`apps/`, `packages/`, tracked `tools/`/`scripts/`). The other "XXX" hits are
  documentation placeholders, not hygiene markers.
- TODO hygiene is otherwise excellent across the tree.

## Summary

Code quality is **high** and the result is overwhelmingly P2/P3, as predicted.

- **`any`-count:** 8 `as any` + 1 `@ts-expect-error` + 5 eslint-disable pragmas,
  **0** `@ts-ignore`, **0** `: any` annotations. Every production `any` is the
  documented proto-bridge carve-out; the rest are test shims. The "no `any`
  except proto bridge" rule holds exactly.
- **Lint + format:** both clean on all 1,032 tracked source files (eslint exit 0
  zero output; prettier all-pass).
- **TODO-count:** 1 real, orphaned (no ticket/date) — `LoopPaymentStep.tsx:240`.
  No FIXME/HACK/genuine XXX anywhere.
- **Findings:** 6 (1× P2, 5× P3). The P2 is the stalled ADR 034 money-formatter
  migration (dead `i18n/format.ts` formatters + parallel live `utils/money.ts` +
  stale docstring). The P3s are the DRY clusters (money formatting ×15, `csvRow`
  ×17, stroops ×5, `STROOPS_PER_MINOR` ×5, smaller clusters) and the orphaned
  modules/exports (apy-snapshot, hmac-verify, geo.ts, FixedSearchButton, ui
  barrel, several dead test-reset seams).
- **No P0/P1** in this sweep. Highest-ROI consolidations: finish the ADR 034
  money-formatter migration (closes P2 + the 15-site cluster + the orphaned
  exports in one move), then `csvRow` (17 mechanical edits) and the stroops
  module + `STROOPS_PER_MINOR` constant (money-correctness-adjacent).
