# Vertical Shared package — raw findings

Files examined: 36/36 (33 source modules barreled by `index.ts` + `index.ts`
itself + `proto/clustering_pb.ts` + 3 colocated test files: `merchant-groups.test.ts`,
`money-format.test.ts`, `slugs.test.ts`). `packages/shared/AGENTS.md` and
`packages/shared/package.json` also read for cross-checks. Per the delta
manifest's explicit ask, several `apps/web` / `apps/backend` consumer files
were additionally inspected to verify the CF-23 "duplicate formatMinor
consolidation" claim end-to-end (listed in Coverage confirmation, flagged as
out-of-package where relevant).

This is a cold, independent pass; the prior 06-15 raw findings
(`docs/audit-2026-06-15-cold/raw/v-shared.md`) were only consulted **after**
forming the findings below, to check which prior items are still open. Carry-
overs are marked explicitly.

## Findings

### SHARED-01 [P1 · LIVE] CF-23 consolidation incomplete — CashbackRealizationCard still has its own partially-lossy `formatMinor` with a float intermediate

- File: `apps/web/app/components/features/admin/CashbackRealizationCard.tsx:109-140` (outside `packages/shared/src/`, but this is the load-bearing evidence for the CF-23 delta-reverification the prompt asked for)
- Description: CF-23 (`3df0e386`, PR #1445) fixed `packages/shared/src/money-format.ts#formatMinorCurrency` to be bigint-exact past 2^53 minor units, and migrated five web call sites (`AssetCirculationCard`, `MonthlyCashbackChart`, `CashbackStatsBand`, `MobileHome`, plus `OrdersSummaryHeader`/`LoopOrdersList` via the i18n seam) to delegate to it. `CashbackRealizationCard.tsx`'s own `formatMinor` (admin `/admin` landing page, renders the same kind of "lifetime earned/spent" fleet aggregate that `admin-cashback-realization.ts` documents — exactly the class of value CF-23 exists to protect) was **not** migrated. It still does its own bigint split, then casts the bigint _quotient_ through `Number()` and recombines as a JS float: `const major = Number(abs / 100n); const frac = Number(abs % 100n) / 100; const total = (neg?-1:1)*(major+frac);` before handing `total` to `Intl.NumberFormat.format()`.
- Impact: This is a structurally different (and narrower) bug than the original P2-SHARED-01/CF-23 bug — precision loss here requires the **major-unit (dollar) value itself** to exceed 2^53 (~$9.007 quadrillion), not just the minor-unit (cents) value exceeding 2^53 (~$90 trillion), so it is not realistically triggerable at Loop's current or near-term scale. But it directly contradicts (a) the explicit verification target in this audit's brief — "does money-format.ts now correctly handle bigint amounts at scale with no float intermediate step anywhere in the call chain" — the call chain is _not_ float-free system-wide; and (b) the stated purpose of the consolidation itself (one shared, tested, exact formatter so every fleet-aggregate surface agrees). A future increase to `fractionDigits`-style chart precision or a per-currency total compounding over the company's lifetime is exactly the kind of slow-creeping magnitude these dashboards are built to survive.
- Evidence: Read in full above; confirmed via `grep` that this file is the only one of the six `formatMinor`-named functions in `apps/web` that both (a) operates on a fleet/lifetime aggregate (the others are per-order or already delegate) and (b) still constructs a JS `number` from the bigint split before formatting. No test in `CashbackRealizationCard.test.tsx` exercises a value anywhere near 2^53.
- Minimal fix: Delete the local `formatMinor` in `CashbackRealizationCard.tsx` and import `formatMinorCurrency` from `@loop/shared` (or the web's `i18n/format.ts` seam) with `{ fractionDigits: 0 }`, matching how `MonthlyCashbackChart.tsx` was migrated under the same CF-23 PR.
- Better fix (if different): Same as minimal — there's no reason for a sixth bespoke implementation when the shared helper already supports locale + 0-decimal mode. Add a lint rule or a `grep`-based CI check (similar to `check-shared-type-parity.mjs`) that flags any new `function formatMinor` / `Number(\w+ \/ 100n?)` pattern in `apps/web` or `apps/backend` outside `packages/shared/src/money-format.ts`, so the next ad-hoc reimplementation fails CI instead of surviving a full audit cycle undetected.

### SHARED-02 [P2 · LIVE] Two more un-consolidated, byte-identical `formatMinor` duplicates (LoopPaymentStep.tsx / LoopOrdersList.tsx)

- File: `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:398-405`, `apps/web/app/components/features/orders/LoopOrdersList.tsx:292-299` (outside `packages/shared/src/`)
- Description: Both files independently define the _exact same_ function body (string-slice based bigint-minor → grouped-major formatter), neither delegating to `@loop/shared#formatMinorCurrency` despite the shared helper already supporting a `locale` positional arg via the `i18n/format.ts` seam these files could use instead:
  ```ts
  function formatMinor(minor: string, locale: string): string {
    const negative = minor.startsWith('-');
    const digits = negative ? minor.slice(1) : minor;
    const padded = digits.padStart(3, '0');
    const whole = padded.slice(0, -2);
    const fraction = padded.slice(-2);
    return `${negative ? '-' : ''}${Number(whole).toLocaleString(locale)}.${fraction}`;
  }
  ```
- Impact: (a) DRY violation — identical logic duplicated verbatim across two files instead of one shared/imported function; (b) the same precision-loss _class_ as SHARED-01 (`Number(whole)` loses precision once the major-unit string exceeds 2^53), though bounded here by the legacy/loop-native order cap (`CreateOrderRequest.amount` ≤ 10,000; loop-native orders are gift-card face values, realistically capped well under the danger threshold), so practical risk is low. The real cost is architectural: CF-22's commit message calls this "one format seam," but there are now at least four parallel minor-unit formatters in `apps/web` plus the canonical one in `packages/shared`.
- Evidence: Identical function bodies confirmed via direct `Read` of both files at the cited line ranges.
- Minimal fix: Replace both with a single shared helper (either `@loop/shared#formatMinorCurrency` or a thin `i18n/format.ts` wrapper) and delete the duplicate.
- Better fix (if different): Same as minimal, plus the CI lint/grep guard proposed in SHARED-01 would catch both at once since they share the offending pattern.

### SHARED-03 [P3 · LIVE] Backend `discord/shared.ts#formatMinorAmount` is a fourth/fifth parallel reimplementation

- File: `apps/backend/src/discord/shared.ts:160-181`
- Description: `formatMinorAmount` re-implements the same `padStart(3,'0')` / slice / `Number(whole).toLocaleString('en-US')` pattern as SHARED-02, purely for Discord notification text. This is backend-internal (doesn't cross the web↔backend boundary) so it correctly fails ADR 019's three-part test for _shared placement_ — but it has no architectural reason to hand-roll the split again rather than calling the already-exact, already-tested `formatMinorCurrency(minor, currency, { locale: 'en-US' })` from `@loop/shared`, which the backend already depends on.
- Impact: Low — Discord messages are operational, not user-facing financial records, and the precision-loss threshold here is the same unrealistic ~$9 quadrillion bound. Pure DRY/maintenance cost: a fifth place that would need fixing if the bigint-split formatting convention ever changes.
- Evidence: Read in full; compared against `money-format.ts`'s algorithm.
- Minimal fix: Leave as-is (not a contract violation, not exploitable).
- Better fix (if different): Replace with a call to `formatMinorCurrency` from `@loop/shared` for consistency and to shrink the number of places that need to agree on currency-formatting edge cases (unknown ISO codes, negative amounts).

### SHARED-04 [P3 · LIVE · CARRY-OVER, still open] `orders.ts` docstring describes a Loop-native state machine that doesn't exist

- File: `packages/shared/src/orders.ts:11`
- Description: The `OrderStatus` JSDoc (contrasting the legacy CTX-proxy flow against Loop-native) states the Loop-native flow goes `created → paid → fulfilled → settled`. The actual canonical machine, `ORDER_STATES` in `packages/shared/src/order-state.ts:15-22` (mirrored 1:1 by the `orders_state_known` Postgres CHECK), is `pending_payment → paid → procuring → fulfilled` with `failed` / `expired` as terminal branches. There is no `created` state and no `settled` state anywhere in the codebase.
- Impact: A reader of `orders.ts` who trusts this comment forms a wrong mental model of the order lifecycle the rest of the package (`loop-orders.ts`, `users-me.ts`) and the backend actually implement. Pure doc-truthfulness violation (checklist §5); no runtime impact.
- Evidence: Direct comparison of `orders.ts:8-15` against `order-state.ts:1-23`; this was independently re-derived before consulting the prior audit, which flagged the identical issue as P3-SHARED-03 on 2026-06-15 (`04c3fae0` baseline) and it has not been fixed in any of the 22 commits in this delta.
- Minimal fix: Edit the comment to read `pending_payment → paid → procuring → fulfilled (failed/expired)`, cross-referencing `order-state.ts` as the source of truth — a one-line change.
- Better fix (if different): Same; this is purely a documentation fix with no design alternative.

### SHARED-05 [P3 · LIVE] Eurozone country list hand-duplicated within the same package (`regions.ts` vs `countries.ts`)

- File: `packages/shared/src/regions.ts:21-42` (`EUROZONE_COUNTRIES`, 20 ISO codes), `packages/shared/src/countries.ts:66-87` (local `EUROZONE` const, same 20 codes + labels/flags)
- Description: Both lists enumerate the identical 20 Eurozone member country codes (FR, DE, IT, ES, NL, IE, BE, AT, FI, PT, GR, LU, SK, SI, LT, LV, EE, CY, MT, HR), maintained as two separate literal arrays in two separate files **within the same package**. `countries.ts`'s comment even says "Mirrors `EUROZONE_COUNTRIES` in `regions.ts`; kept local..." — acknowledging the duplication rather than importing it. Both are live: `regions.ts#regionForCountry`/`EUROZONE_COUNTRIES` still compute the `region` field of `GET /api/public/geo` (`apps/backend/src/public/geo.ts`), consumed by `apps/web/app/components/features/onboarding/screen-currency.tsx`; `countries.ts#COUNTRIES` drives the live ADR 034 path-based routing and merchant-country filtering.
- Impact: This is precisely the "drift would be a bug, not a type error" scenario ADR 019's three-part test is designed to prevent — except here it's _intra_-package, so there's no cross-package-coupling excuse for not just importing one list from the other. If a future Eurozone accession (or removal) is applied to one file and not the other, `/api/public/geo`'s `region` field and the ADR 034 country/currency routing would silently disagree about which countries are "EUR" — e.g. a newly-added Eurozone country would route correctly under `countries.ts` but its `GeoResponse.region` would still report something other than `'EUR'`.
- Evidence: Both arrays read in full and diffed by eye — identical 20-code sets in identical order.
- Minimal fix: In `countries.ts`, derive the Eurozone code list from `regions.ts`'s `EUROZONE_COUNTRIES` (`import { EUROZONE_COUNTRIES } from './regions.js'`) instead of re-listing it, keeping the per-country label/flag metadata local but sourcing the membership list from one place.
- Better fix (if different): Since `regions.ts` is documented as superseded and slated for ADR 034 Phase 5 retirement, invert the dependency instead — move the canonical Eurozone membership list into `countries.ts` (the live model) and have `regions.ts#EUROZONE_COUNTRIES` re-export/derive from it, so the eventual deletion of `regions.ts` doesn't require re-deriving the list a third time.

### SHARED-06 [P3 · LIVE] Four narrowing-helper exports have zero callers anywhere in the monorepo

- File: `packages/shared/src/credit-transaction-type.ts:35` (`isCreditTransactionType`), `packages/shared/src/order-state.ts:25` (`isOrderState`) and `:49` (`isOrderPaymentMethod`), `packages/shared/src/payout-state.ts:21` (`isPayoutState`)
- Description: Each of the four follows the ADR 019 "module conventions" triad (tuple + type + narrowing helper) but has **zero** consumers — verified via `grep` across `apps/backend/src`, `apps/web/app`, and `packages/shared/src` itself (the only matches are each function's own definition line). This is the exact situation the codebase has an established precedent for removing: `stellar.ts`'s header explicitly documents that `isStellarPublicKey` was deleted under A2-820/A2-821 for having "zero callers," to avoid "one less near-duplicate API to keep in sync." That precedent was not applied to these four.
- Impact: Pure dead-code / maintenance-surface — each is a public, frozen-shape API contributors might assume is load-bearing (and therefore avoid touching) when it isn't; each also has to be kept correct (e.g. re-verified against its tuple) on every edit to the underlying union for no actual benefit, since nothing calls it. Not a correctness bug.
- Evidence: `grep -rln "isCreditTransactionType" apps/backend/src apps/web/app packages/shared/src` (and the equivalent for the other three) each return only the definition file.
- Minimal fix: Leave them — they're harmless and cheap to keep "just in case" if the team prefers optionality.
- Better fix (if different): Apply the package's own established precedent (A2-820/A2-821) and delete the four zero-caller helpers, same as was done for `isStellarPublicKey`, for consistency. If a future consumer needs the check, re-add it then (it's a one-line function).

### SHARED-07 [P3 · GATED] `merchantSlug`/`brandSlug` degrade to a near-empty or bare-country-code slug for fully non-Latin-script merchant names

- File: `packages/shared/src/slugs.ts:18-23` (`brandSlug`), `:60-82` (`merchantSlug`)
- Description: `brandSlug` strips every character outside `[a-z0-9-]` after lowercasing. For a merchant name composed entirely of non-Latin-script characters (CJK, Arabic, Cyrillic, Devanagari, etc.) with no internal whitespace, `brandSlug(name)` returns the **empty string** (no character survives the strip, and there's no space to become a hyphen). `merchantSlug`'s step 2 (`base === '' ? cc : ...`) then falls back to **the bare country code** (e.g. `"ae"`, `"sa"`) as the entire slug. Any second merchant with a _different_ fully non-Latin name tagged to the _same_ country collides on the identical slug. For a multi-word non-Latin name, the spaces survive as `-` (the only ASCII char in the source), so `brandSlug` instead returns a low-entropy string of bare hyphens (e.g. two words → `"-"`), which is marginally better but still extremely collision-prone.
- Impact: Loop's catalogue is currently US/CA/UK/Eurozone-centric where merchant brand names are Latin-script (already well-tested, including accented Latin via `brandSlug('Café') → 'caf'`). ADR 035's extended markets (AE, SA in particular) make native-script merchant names a real, near-term possibility (Arabic-script brand names in the UAE/Saudi catalogue). If/when that data lands, two unrelated merchants could silently collide on `/brand/ae` or `/brand/sa`, with the later-synced one's catalogue tile/SEO page overwriting or 404-shadowing the other depending on how the web's `merchantsBySlug` index resolves duplicate keys (a question for the catalog/web verticals, but the root cause — slug generation collapsing distinct names to the same short token — lives here). No test in `slugs.test.ts` exercises a fully-non-Latin merchant name.
- Evidence: Traced `brandSlug`/`merchantSlug` step-by-step for a hypothetical single-word and multi-word non-Latin name against the actual regex `\s+/g → '-'` then `[^a-z0-9-]/g → ''`; cross-checked `slugs.test.ts` for existing non-ASCII coverage (only the partial-Latin `Café`/`Pokémon` cases are tested, not full-non-Latin).
- Minimal fix: In `merchantSlug`, when the derived `base` is empty (or collapses to only hyphens) AND no usable CTX `slug` was provided, fall back to including a stable per-merchant disambiguator (e.g. a short hash of `merchant.id`) appended to the country code, rather than colliding on the bare country code.
- Better fix (if different): Replace the brute-force ASCII-strip in `brandSlug` with a proper transliteration pass (e.g. a small Unicode-to-ASCII table or a transliteration library) so non-Latin brand names produce a meaningful, unique-ish slug instead of an empty string — matching how most international e-commerce platforms slugify titles. This is a larger change (the docstring notes `brandSlug` intentionally "matches the Go reference on upstream CTX," so changing behavior here would diverge from that upstream reference — worth a short ADR note if pursued) so the minimal per-merchant-id fallback is the safer near-term fix.

### SHARED-08 [P3 · LIVE] `formatMinorCurrency` hardcodes a 2-decimal minor-unit assumption with no validation against the currency's real ISO 4217 exponent

- File: `packages/shared/src/money-format.ts:59-115`
- Description: The function always splits `minor` as `major = abs / 100n` and `frac = abs % 100n` — i.e. it assumes every currency uses exactly 2 decimal digits of minor-unit precision (cents). This is correct for every currency currently in use across the package (`HOME_CURRENCIES`: USD/GBP/EUR; `EXTENDED_ORDER_CURRENCIES`: AED/INR/SAR/AUD/MXN — all 2-decimal under ISO 4217), but there's no guard, no currency-to-decimal-exponent lookup, and no type-level restriction preventing a caller from passing a 0-decimal currency (e.g. JPY) or a 3-decimal currency (e.g. KWD, BHD) — both real ISO 4217 currencies a future market expansion could plausibly add. Passing either today would silently render a wrong amount (e.g. ¥125 would render as "¥1.25" if minor units were actually whole yen, or a 3-decimal dinar would lose its third digit).
- Impact: No live bug today (every supported currency happens to be 2-decimal), but it's an undocumented landmine for whoever adds the next currency, in exactly the category of "drift would be a bug, not a type error" ADR 019 exists to flag — except here the danger isn't a TypeScript union, it's a silent arithmetic assumption baked into the formatter's body.
- Evidence: Code reading of lines 70-73 (`const major = abs / 100n; const fracStr = (abs % 100n).toString()...`) plus cross-reference against `HOME_CURRENCIES`/`EXTENDED_ORDER_CURRENCIES`/`SUPPORTED_CURRENCIES`, none of which include a non-2-decimal currency today.
- Minimal fix: Add a one-line comment making the 2-decimal assumption explicit as a documented precondition/limitation (it's implied but not stated as a hard constraint), so the next currency addition is a deliberate decision rather than a silent landmine.
- Better fix (if different): Derive the decimal-digit count per currency from `Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits` (or a small static ISO 4217 exponent table) and split the bigint accordingly instead of hardcoding `100n`/`10n` everywhere it would need to change.

### SHARED-09 [P3 · LIVE] `formatMinorCurrency` docstring says "floored," implementation uses `Math.trunc` (differ for negative non-integers)

- File: `packages/shared/src/money-format.ts:44-46` (docstring), `:119-122` (`coerceMinor`)
- Description: The docstring states "Non-integer numbers are floored (drops to minor-unit precision)," but `coerceMinor` implements `BigInt(Math.trunc(minor))`. `Math.trunc` rounds toward zero; `Math.floor` rounds toward negative infinity. They agree for positive inputs but diverge for negative non-integers: `Math.trunc(-1500.9) === -1500` (→ `-$15.00`) while `Math.floor(-1500.9) === -1501` (→ `-$15.01`).
- Impact: Low — this only affects the documented "legacy/tolerated" `number` input path (bigint and string inputs, the precision-critical ones, are unaffected), and no test exercises a negative non-integer number to pin which behavior is actually intended, so it's unclear whether the doc or the code reflects the intended product behavior. Either way one of the two is wrong.
- Evidence: `money-format.test.ts:30-32` only tests a positive non-integer (`1500.9` → `$15.00`); no negative non-integer-number test exists.
- Minimal fix: Correct the docstring to say "truncated toward zero" instead of "floored," since `Math.trunc` is almost certainly the intended behavior for money (truncation-toward-zero is the conventional choice, matching how the bigint/string paths behave when given an already-integer minor-unit count).
- Better fix (if different): Same fix, plus add a test for a negative non-integer number input to pin the behavior going forward.

### SHARED-10 [P3 · LIVE] `cashback-realization.ts#recycledBps` has non-trivial branching but no dedicated `packages/shared` test, inconsistent with the package's own stated policy

- File: `packages/shared/src/cashback-realization.ts`
- Description: ADR 019's "Test placement" section states shared-module tests live at consumers _unless_ the symbol "gains non-trivial branching... the test moves with the logic at that point" — and gives `formatMinorCurrency` (now tested in `money-format.test.ts`) as exactly this category. `recycledBps` has three distinct branches (zero/negative-earned guard, negative-spent clamp, overflow clamp to 10,000) — the same shape of "non-trivial branching" that justified `money-format.ts`, `merchant-groups.ts`, and `slugs.ts` getting colocated tests — yet its only test coverage is duplicated across two backend consumer files (`apps/backend/src/admin/__tests__/cashback-realization.test.ts` and `cashback-realization-daily.test.ts`), not in `packages/shared`.
- Impact: Very low — the function _is_ tested (good case coverage: zero, normal, 100%, overflow clamp, negative clamp), just not in the location the package's own ADR implies it should be once branching exists. Pure process-consistency nit; flagged because the inconsistency suggests the "move the test" trigger isn't being applied uniformly across extractions.
- Evidence: `grep` confirmed zero `recycledBps`-specific test file under `packages/shared/`; the two backend test files duplicate near-identical assertions on the same pure function.
- Minimal fix: None required — leave as-is; the duplication across two backend test files is itself slightly wasteful but not wrong.
- Better fix (if different): Add `packages/shared/src/cashback-realization.test.ts` with the existing assertions (consolidating the two backend duplicates into a single canonical test, with the backend tests trimmed to just "the route plumbs `earned`/`spent` into `recycledBps` correctly" rather than re-deriving all of `recycledBps`'s branch logic), matching the precedent already set for the other three branchy shared functions.

### SHARED-11 [P3 · LIVE · CARRY-OVER, still open] Proto generator version skew (cosmetic)

- File: `packages/shared/src/proto/clustering_pb.ts:1` (`@generated by protoc-gen-es v2.11.0`), `packages/shared/package.json:18` (`@bufbuild/protobuf: 2.12.0`)
- Description: The generated header still pins generator v2.11.0 while the runtime dependency across all three packages (`shared`, `web`, `backend`) is 2.12.0. Re-verified the field-by-field descriptor against `apps/backend/proto/clustering.proto` — still in sync (no actual schema drift), this is purely a stale generator-version stamp.
- Impact: None today; flagged because the next `npm run proto:generate` will rewrite the header and could land an unrelated-looking diff mixed into a real proto change, making review harder.
- Evidence: Identical to the prior audit's P3-SHARED-04 (2026-06-15); not touched by any of the 22 commits in this delta.
- Minimal fix: Run `npm run proto:generate` once, standalone, to resync the generator stamp with a clean no-op diff (no schema fields changed).
- Better fix (if different): Same; optionally pin the `protoc-gen-es` generator version in the buf/codegen config so it can't silently drift from the runtime `@bufbuild/protobuf` dependency again.

### SHARED-12 [P3 · LIVE · CARRY-OVER, presumed still open — not independently re-verified in depth] No field-level shared↔OpenAPI parity gate

- File: `scripts/check-openapi-parity.mjs`, `scripts/check-shared-type-parity.mjs` (not in this vertical's file scope; flagged for continuity only)
- Description: The 2026-06-15 audit found that neither parity script compares response **field sets** between `packages/shared` types and the hand-rolled zod schemas in `apps/backend/src/openapi/**` — only route/status-code existence (openapi-parity) and cross-package type-name collisions (shared-type-parity) are checked. I did not re-run or re-read these scripts in this pass (they live outside `packages/shared/src/`), so I cannot confirm whether this gap has been closed since 06-15; none of the 22 delta commits mention it. Carried forward as presumed-still-open rather than independently re-verified — flag for the vertical (or audit lead) that owns `scripts/**` to confirm.
- Impact: Unchanged from prior assessment — a field added to a shared response type without a matching openapi zod field would not fail any existing gate.
- Evidence: Prior audit's P2-SHARED-02; not re-investigated here.
- Minimal fix: (carried from prior audit) Add a check that diffs each openapi response schema's top-level keys against the corresponding shared interface's keys, with an allowlist for intentional subsets.
- Better fix (if different): (carried from prior audit) Derive openapi schemas from shared types via `z.infer`/shared zod schemas instead of independent hand-rolled literals.

## Delta re-verification

**CF-23 verdict: PARTIALLY CLOSED.**

`packages/shared/src/money-format.ts#formatMinorCurrency` itself — the file
this audit was specifically asked to scrutinize — is now genuinely bigint-exact
at every magnitude tested, including past 2^53 minor units and at the
~$90-trillion / ~19-digit-minor-unit scale the prior P2-SHARED-01 finding
called out. Verified by:

1. Manual trace of the algorithm: `major = abs / 100n` and `fracStr = (abs %
100n).toString().padStart(2,'0')` are both exact bigint operations; the
   _only_ place a `Number` ever appears in the 2-decimal rendering path is
   inside `Intl.NumberFormat`'s internal handling of the **bigint** `major`
   argument passed directly to `nf.format(major)` / `nf.formatToParts(major)`
   — `Intl.NumberFormat` accepts `bigint` natively per spec and does not
   round-trip it through `Number`. No JS `number` is ever constructed from
   the magnitude-bearing parts of the value.
2. `money-format.test.ts`'s dedicated `describe('formatMinorCurrency —
bigint precision past 2^53 ...')` block (6 tests) — re-derived each
   expected value by hand from the bigint inputs and confirmed the assertions
   are correct, not tautological (e.g. `'900719925474099301'` vs
   `'900719925474099302'` differing only in the trailing minor digit, proving
   no rounding collapsed neighboring values).
3. The `pctBigint` companion helper is also exact end-to-end: although its
   intermediate `numerator * 10_000n` can be an arbitrarily large bigint, the
   bigint division is exact, and the **post-division** quotient — which is
   what gets cast through `Number()` — is bounded by the basis-point _ratio_
   scale (0–~very large but realistically small), not by the absolute
   magnitude of the inputs, so the cast is safe regardless of how large
   `numerator`/`denominator` are.

However, the broader claim implicit in CF-23's commit message — "Route every
ad-hoc currency render through the bigint-safe shared formatter" — is **not**
fully realized. SHARED-01 found a live, un-migrated consumer
(`CashbackRealizationCard.tsx`, an admin fleet/lifetime-aggregate card — the
exact risk class CF-23 targets) that still builds a float intermediate from
the bigint split before formatting, and SHARED-02/03 found three more
parallel, un-consolidated reimplementations of the same minor-unit-split
logic (two in `apps/web`, one in `apps/backend`) that never call the now-fixed
shared helper at all. None of these four are realistically exploitable at
Loop's current or near-term transaction volumes (the thresholds range from
~$9 quadrillion to bounded-by-the-$10k-order-cap), so this is not a P0/P1
money-loss bug — but it means "no float intermediate step anywhere in the
call chain" is false as a system-wide statement, only true for the canonical
helper itself.

## Coverage confirmation

All `packages/shared/src/**` files in scope, read in full:

- `admin-assets.ts`
- `admin-cashback-realization.ts`
- `admin-operator-mixes.ts`
- `admin-operator-stats.ts`
- `admin-settlement-lag.ts`
- `admin-supplier-spend.ts`
- `admin-treasury.ts`
- `api.ts`
- `assert-never.ts`
- `cashback-realization.ts`
- `countries.ts`
- `credit-transaction-type.ts`
- `index.ts`
- `loop-asset.ts`
- `loop-orders.ts`
- `merchant-groups.ts` + `merchant-groups.test.ts`
- `merchants.ts`
- `money-format.ts` + `money-format.test.ts`
- `order-state.ts`
- `orders.ts`
- `payout-state.ts`
- `proto/clustering_pb.ts` (+ cross-checked against `apps/backend/proto/clustering.proto`)
- `public-cashback-preview.ts`
- `public-cashback-stats.ts`
- `public-flywheel-stats.ts`
- `public-loop-assets.ts`
- `public-merchant.ts`
- `public-top-cashback-merchants.ts`
- `regions.ts`
- `search.ts`
- `slugs.ts` + `slugs.test.ts`
- `stellar.ts`
- `user-favorites.ts`
- `user-recently-purchased.ts`
- `users-me.ts`

Also read: `packages/shared/AGENTS.md`, `packages/shared/package.json`,
`docs/adr/019-shared-package-policy.md`, `docs/adr/035-extended-supplier-currency-markets.md`
(CAD/extended-currency orderability cross-check — confirmed intentional, not a
bug), `apps/backend/proto/clustering.proto`.

Cross-checked outside the package (for the CF-23 delta-reverification and the
ApiErrorCode parity spot-check, not claimed as full coverage of those
verticals): `apps/web/app/components/features/admin/CashbackRealizationCard.tsx`
(+ its test), `apps/web/app/components/features/admin/AssetCirculationCard.tsx`,
`apps/web/app/components/features/cashback/MonthlyCashbackChart.tsx`,
`apps/web/app/components/features/purchase/LoopPaymentStep.tsx`,
`apps/web/app/components/features/orders/LoopOrdersList.tsx`,
`apps/web/app/components/features/orders/OrdersSummaryHeader.tsx`,
`apps/web/app/i18n/format.ts`, `apps/backend/src/discord/shared.ts`,
`apps/backend/src/orders/procure-one.ts`, `apps/backend/src/orders/handler.ts`,
`apps/backend/src/orders/loop-handler.ts`, `apps/backend/src/payments/price-feed-fx.ts`,
`apps/backend/src/public/geo.ts`.

## Summary

- P0: 0
- P1: 1 (SHARED-01 — CF-23 consolidation incomplete; bounded severity but a genuine contradiction of the stated fix)
- P2: 1 (SHARED-02 — duplicate un-consolidated formatters)
- P3: 10 (SHARED-03 through SHARED-12, including two re-flagged carry-overs from the 06-15 audit that remain open: SHARED-04/orders.ts doc lie, SHARED-11/proto version skew, plus SHARED-12 presumed-open and not independently re-verified)

Top items for the human reviewer: SHARED-01 (delta-specific, directly answers
the audit's CF-23 ask), SHARED-05 (intra-package Eurozone list duplication —
cheap one-line fix), SHARED-06 (dead-code cleanup, cheap, consistent with
existing team precedent).
