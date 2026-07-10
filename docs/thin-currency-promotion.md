# Thin-currency promotion cadence

> Closes the go-live-plan §P3 / readiness-backlog "Thin-currency promotion
> cadence" item (ADR 035). This doc is the process + the measurement; it does
> **not** promote any specific country — that stays a 🧭 operator decision made
> using the data this doc tells you how to pull.

## Background

The June 2026 CTX supplier-coverage program (ADR 035) synced ~1,140 merchants
priced in ~33 non-anchor currencies. Five crossed a **≥15 enabled-merchant**
threshold and were surfaced as display countries: AE/AED, IN/INR, SA/SAR,
AU/AUD, MX/MXN (`packages/shared/src/countries.ts`). ~20 more currencies
(NZD, TRY, KWD, OMR, CZK, DKK, SEK, CHF, BRL, …) sit below the threshold —
they're real, orderable-via-legacy-CTX-proxy merchants, but not routed as a
country page. ADR 035 explains why the threshold exists:

> Coverage is very uneven … a country page with a single gift card is poor
> UX, so "list every currency present" is the wrong rule.

Below 15 merchants a locale page (`/nz/en`, `/tr/en`, …) renders sparse and
hurts both UX and SEO (thin-content pages dilute the reciprocal-hreflang
sitemap ADR 034 built). The threshold is explicitly **"a judgement call,
revisited as the catalogue grows"** — this doc is that revisit mechanism.

## Review cadence

**Quarterly**, timed to land after a CTX supplier-coverage sweep
(`tools/ctx-catalog/`) rather than on a fixed calendar date — the count only
moves when the catalogue does, and the coverage program runs irregularly. A
maintainer (not necessarily the one running the sweep) runs the measurement
below, updates the tracking table in this doc, and opens a 🧭 decision thread
for anything that crossed the threshold. There's no watcher/worker for this —
deliberately: a currency crossing 15 merchants once, briefly, is not a signal
to promote (see the go/no-go checklist below).

## The measurement

**There is no `merchants` table in Postgres** — the catalog lives only in the
backend's in-memory store (`apps/backend/src/merchants/sync.ts`, refreshed
every `REFRESH_INTERVAL_HOURS`), so there's no SQL query to run. The lowest-
effort reuse is the **public catalog endpoint that already serves this exact
data** to the web app: `GET /api/merchants/all?fields=lite` — unauthenticated,
`Cache-Control: public, max-age=300`, 60/min rate limit
(`apps/backend/src/routes/merchants.ts`). In production, `sync-upstream.ts`
already drops disabled merchants before they reach the store
(`INCLUDE_DISABLED_MERCHANTS` is a dev-only override), so counting rows from
this endpoint against production **is** counting enabled merchants — no
extra filtering needed. Run it against production
(`https://api.loopfinance.io`); running it against a local/staging backend
with `INCLUDE_DISABLED_MERCHANTS=true` set would overcount.

Two equally-fine ways to run it — pick whichever tool you have on hand, don't
add a new script for this:

**`curl` + `jq`** (grouped counts by currency, then by country):

```bash
curl -s 'https://api.loopfinance.io/api/merchants/all?fields=lite' \
  | jq -r '.merchants[].denominations.currency // "UNKNOWN"' \
  | sort | uniq -c | sort -rn

curl -s 'https://api.loopfinance.io/api/merchants/all?fields=lite' \
  | jq -r '.merchants[].country // "UNKNOWN"' \
  | sort | uniq -c | sort -rn
```

**Plain Node** (no `jq` dependency — copy/paste into `node`, Node 18+ has
global `fetch`):

```js
const { merchants } = await fetch('https://api.loopfinance.io/api/merchants/all?fields=lite').then(
  (r) => r.json(),
);
const byCurrency = {};
for (const m of merchants) {
  const c = m.denominations?.currency ?? 'UNKNOWN';
  byCurrency[c] = (byCurrency[c] ?? 0) + 1;
}
console.table(byCurrency);
```

Cross-reference the output against `EXTENDED_ORDER_CURRENCIES` in
`packages/shared/src/loop-asset.ts` (the currencies already wired for
loop-native ordering) and `COUNTRIES` in `packages/shared/src/countries.ts`
(the currencies already displayed) to see which thin currencies are closing
the gap.

Why not the existing admin CSV export
(`GET /api/admin/merchants-catalog.csv`, `apps/backend/src/admin/merchants-catalog-csv.ts`)?
It's the closer-to-hand "admin metric" but its columns
(`merchant_id,name,enabled,user_cashback_pct,active,updated_by,updated_at`)
don't carry country/currency — it's built for the cashback-config finance
view, not catalog composition. Adding those columns would be a reasonable
future enhancement but is out of scope for this doc; the public endpoint
already carries exactly the two fields this measurement needs.

Don't use `tools/ctx-catalog/recount.mjs` (or similar operator scripts) for
this — those hit the raw CTX upstream admin API directly and reflect what
CTX has, not what's actually allocated + live in Loop's own catalog (ADR 021
eviction policy can make the two diverge). The `/api/merchants/all` count is
the one that matches what a real visitor to loopfinance.io would see.

## Promotion steps

Promotion is **two different sizes of change** depending on whether the
currency crossing the threshold is one of the five already wired for
loop-native ordering, or a genuinely new one. Today all five wired currencies
(AED/INR/SAR/AUD/MXN) are already displayed, so **the next promotion will
almost certainly be the larger, new-currency path** — don't assume "one-line
`countries.ts` diff" without checking which case you're in.

### Step 0 — 🧭 go/no-go decision (operator, not code)

Before touching any file:

- [ ] The currency has been **at or above 15 enabled merchants for at least
      one full review cycle**, not a one-time spike (a supplier sync that
      adds and then evicts a batch shouldn't trigger a promotion).
- [ ] The external rates service (`~/code/rates`, outside this repo) actually
      serves a fiat→crypto rate for the currency. If it doesn't, promoting
      the display country is safe (code fails closed to
      `CURRENCY_NOT_AVAILABLE` — see below) but pointless: visitors would see
      a country page where every order attempt says "coming soon."
- [ ] No sanctions/compliance flag on the jurisdiction (quick gut-check, not
      a formal review — Loop has no bank-transfer/KYC exposure in Phase 1;
      this is a lighter bar than a new home-currency/cashback market would be).
- [ ] The merchant mix is recognizable/international brands, not a thin pile
      of hyper-local single-location gift cards — the ADR 035 "single gift
      card is poor UX" concern generalizes past just the count.

If any box is unchecked, log it as "not yet" and revisit next cycle — don't
force a promotion to close this doc's checklist.

### Step A — 💰 money-review: wire the currency for ordering

**Skip this step entirely if the currency is already in
`EXTENDED_ORDER_CURRENCIES`** (today: AED/INR/SAR/AUD/MXN) — it's already
wired, go straight to Step B. Otherwise:

1. Add the ISO 4217 code to `EXTENDED_ORDER_CURRENCIES` in
   `packages/shared/src/loop-asset.ts`. This alone widens
   `ORDERABLE_CURRENCIES` (the loop-native order-handler's accepted set) and
   `FX_RATE_CURRENCIES` in `apps/backend/src/payments/price-feed-fx.ts`
   (`[...EXTENDED_ORDER_CURRENCIES]` derivation) — no separate edit needed in
   either place.
2. Widen the `orders_currency_known` CHECK constraint in
   `apps/backend/src/db/schema/orders.ts` (currently
   `IN ('USD','GBP','EUR','AED','INR','SAR','AUD','MXN')`) to include the new
   code, and write the matching Drizzle migration (follow the shape of
   `apps/backend/src/db/migrations/0037_orders_currency_extended_markets.sql`
   — widen this CHECK only). **Do not** touch
   `orders_charge_currency_known` / `user_credits_currency_known` /
   `credit_transactions_currency_known` / `users_home_currency_known` — those
   stay pinned to `USD`/`GBP`/`EUR` on purpose (ADR 035: extended-market
   currencies are catalog/display-only, never a cashback/ledger currency).
3. This diff touches a schema CHECK constraint, so it needs 💰 review under
   `docs/invariants.md` even though `orders_currency_known` is **not** one of
   the constraints `scripts/check-money-invariants.mjs`'s `REQUIRED_CHECKS`
   tracks today — CI will not catch a mistake here, a human has to.
4. Run `npm run check:migration-parity` (needs a disposable postgres) to
   confirm the migration and `schema.ts` agree.
5. Confirm the currency actually returns a rate from `price-feed-fx.ts` in a
   staging smoke test before flipping anything user-visible — until the
   external rates service serves it, orders for the market fail closed with
   `CURRENCY_NOT_AVAILABLE` (never a wrong charge), so there's no correctness
   risk in merging this step slightly ahead of Step B, but there's no upside
   either.

### Step B — 🟢 self-serve: wire the display country

Once the currency is orderable (either it already was, or Step A shipped),
this part really is close to "one line," and needs no money/auth review —
it's `packages/shared/src/countries.ts` plus one asset:

1. Add a `Country` row to `COUNTRIES` — `code` (ISO 3166-1 alpha-2), `label`,
   `flag` (emoji), `currency`.
2. Add the currency to `SUPPORTED_CURRENCIES` if it isn't already there.
3. Add a `MAP_VIEW_BY_COUNTRY` entry for the new code — **required**;
   `countries.test.ts` (`mapViewOf` — "every routable country has a map
   view") fails CI if you skip it, so there's no silent fallback to the US
   default map view.
4. Add a flag SVG at `apps/web/public/flags/<code>.svg` (lowercase, flag-icons
   4x3 format — match the existing 28 files in that directory).
5. Nothing else to touch for routing/SEO — `apps/web/app/routes/sitemap.tsx`
   and `apps/web/app/i18n/seo.ts` (reciprocal hreflang) both iterate
   `COUNTRIES` directly (ADR 034 Phase 4), so the new locale route, sitemap
   entries, and hreflang links appear automatically on next deploy.
6. Run `npm test -w @loop/shared` (`countries.test.ts`) — catches a missing
   map view or a currency that isn't in `SUPPORTED_CURRENCIES`.
7. No cashback-config change: extended-market countries are display-only, no
   LOOP cashback asset (ADR 035 point 1) — don't add a
   `merchant_cashback_configs` entry or touch the admin cashback UI for this.

### After merge

- The country page (`/xx/en`) goes live on next deploy; no feature flag
  gates it.
- Orders on the XLM rail work immediately if Step A was already done (or
  skipped because the currency was already wired); otherwise they 400/503
  `CURRENCY_NOT_AVAILABLE` until Step A ships and the rates feed confirms
  coverage — both safe, visible failure modes, not silent breakage.

## Cross-references

- `docs/adr/034-path-based-locale-routing.md` — the `/:country/:lang` model,
  the sitemap/hreflang derivation this doc's Step B relies on.
- `docs/adr/035-extended-supplier-currency-markets.md` — the ≥15 threshold,
  the original five-market table, why extended markets are display-only.
- `docs/invariants.md` — why widening `orders_currency_known` is a 💰-tier
  change even though it isn't in `check-money-invariants.mjs` today.
- `packages/shared/src/countries.ts` / `packages/shared/src/loop-asset.ts` —
  the two files every promotion touches.
- `apps/backend/src/payments/price-feed-fx.ts` — where a newly-wired currency
  starts requesting a rate.
