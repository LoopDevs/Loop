# ADR 035: Extended supplier-currency display markets

## Status

Accepted (extends ADR 034's per-country model)

**Order-path update (CF-19, 2026-06):** the original decision below claimed
"No backend change" — accurate for the legacy CTX-proxy path but **wrong for the
loop-native path**, which hard-rejected any non-USD/GBP/EUR gift-card currency at
400 and whose FX feed + DB CHECKs were pinned to the three home currencies. So
the five display markets were geo-redirected and sitemap-indexed but structurally
**unbuyable** via loop-native (~286 SEO-promoted merchants). The Loop side is now
wired:

- `ORDERABLE_CURRENCIES` in `@loop/shared` (home + extended) is the order-path
  currency set; the loop-native handler validates against it (not `HOME_CURRENCIES`,
  which stays the cashback/ledger set — these markets remain display-only, no
  LOOP asset).
- The FX path (`price-feed-fx.ts`) requests the extended currencies from the rates
  feed and converts an extended-market card to the user's home charge currency.
- Migration `0037_orders_currency_extended_markets` widens the
  `orders_currency_known` CHECK to admit AED/INR/SAR/AUD/MXN. The
  charge/cashback CHECKs (`orders_charge_currency_known`,
  `user_credits_currency_known`, `credit_transactions_currency_known`,
  `users_home_currency_known`) deliberately stay USD/GBP/EUR.

**External dependency (not in Loop's repo):** a market only goes live end-to-end
once the external rates service actually serves a live rate for the currency.
Until then an extended-market order returns a clean `CURRENCY_NOT_AVAILABLE` 503
("ordering for this market is coming soon") — it never crashes, 500s, or
computes a wrong charge. This PR makes Loop _ready and safe_; flipping a market
live is purely a rates-service capability.

**Which "rates service", precisely (§P3, 2026-07-10):** the gate is the fiat FX
feed in `apps/backend/src/payments/price-feed-fx.ts` (Frankfurter,
`api.frankfurter.app` → ECB reference rates), NOT CTX's `rates.ctx.com`. The two
are different hops in the design: an extended-market order is FX-pinned
catalog-currency → home-currency (USD/GBP/EUR) via Frankfurter first, and only
the resulting **home-currency** charge is ever sized against `rates.ctx.com` for
the on-chain XLM/USDC payment — a currency `rates.ctx.com` already fully serves
for USD/GBP/EUR. So an extended currency going live end-to-end depends only on
Frankfurter carrying it, not on any CTX-side capability. (The original text
above referenced a separate `~/code/rates` service and an internal task #8 —
that was the pre-CF-19 assumption; CF-19 shipped the Frankfurter-hop design
instead, which is what's live today.)

**Confirmed live status (checked directly against the production Frankfurter
API, 2026-07-10):** Frankfurter serves **AUD, INR, and MXN** today — orders in
those three currencies work end-to-end right now. It does **not** serve **AED**
or **SAR** — both are USD-pegged Gulf currencies the ECB's reference-rate table
(which Frankfurter republishes) doesn't quote, so those two markets correctly
and repeatably 503 `CURRENCY_NOT_AVAILABLE` today. This is a real vendor gap,
not a Loop code gap: the check is a live per-request feed read (never a static
allowlist), so AED/SAR orders start working automatically, with no Loop
deploy, the moment Frankfurter (or a replacement feed) adds them. Closing that
gap for real (switching feeds, or sourcing AED/SAR from elsewhere) is a
👤/vendor decision, tracked outside this ADR.

## Context

The supplier-coverage program (June 2026) onboarded every SVS / Tillo / EzPin product
across every geography they cover into the CTX catalogue — ~1,140 new merchants priced in
their native currencies, taking the catalogue from US/GB/CA/EUR to 33 currencies (AED,
INR, SAR, AUD, MXN, NZD, TRY, KWD, OMR, …). CTX already supports these: the
`merchantCountryCurrency` map in `spend-api/internal/merchant_currencies.go` covers the
full supplier-currency set, with XLM/<fiat> rates in rates.ctx.com. So the merchants exist
and are orderable via the API.

But the web app's country model (ADR 034, `packages/shared/src/countries.ts`) only listed
US/GB/CA + the Eurozone, so the new merchants were **invisible on the marketing site** — no
locale route, no price-display currency, no merchant-filter match. ADR 034 explicitly
anticipated this ("long-tail currencies the supplier sync adds later get their countries
appended here").

Coverage is very uneven, though: AED has 203 enabled merchants (a real market) while
CZK/DKK/SEK/CHF/BRL/… have exactly one each. Surfacing a country page with a single gift
card is poor UX, so "list every currency present" is the wrong rule.

## Decision

Surface the **strong** extended markets only — currencies with **≥ 15 enabled merchants** —
as **display-only** countries in the ADR 034 model:

| Country                   | Currency | Enabled merchants |
| ------------------------- | -------- | ----------------- |
| AE (United Arab Emirates) | AED      | 203               |
| IN (India)                | INR      | 29                |
| SA (Saudi Arabia)         | SAR      | 21                |
| AU (Australia)            | AUD      | 17                |
| MX (Mexico)               | MXN      | 16                |

1. **Display-only, no cashback.** Like CAD (ADR 034), these are _display_ currencies for
   merchant prices, deliberately separate from a user's cashback home currency. There is no
   AEDLOOP/INRLOOP/… asset, so they get price display + ordering (the XLM rail) but no LOOP
   cashback band. Adding cashback for a region is a separate decision with KYC/licensing
   weight and would need its own ADR.
2. **≥ 15-merchant threshold.** Thinner currencies (NZD 8, TRY 6, KWD 4, … down to the
   1-merchant singletons) stay **catalogue-only** — the merchants exist and are orderable
   via the API, but the country isn't routed/surfaced until it has the depth to populate a
   page. The threshold is a judgement call, revisited as the catalogue grows; promoting one
   is a one-line `countries.ts` addition.
3. **Everything else propagates from `countries.ts`.** Adding the five `Country` rows + their
   currencies to `SUPPORTED_CURRENCIES` is the whole change: the locale layout,
   geo-redirect, per-country SEO/hreflang sitemap, merchant filter, and the `money.ts` price
   formatter (generic `Intl.NumberFormat`) all derive from the list. Flags are added as
   flag-icons SVGs to match the existing set.

## Consequences

- `/ae/en`, `/in/en`, `/sa/en`, `/au/en`, `/mx/en` become live locale routes; the country
  selector gains five markets; prices render in the local currency (AED 50.00, ₹500, …).
- These markets show discounts but **no cashback band** — the cashback UI keys off the
  home-currency / LOOP-asset model, which has no entry for them (reuses CAD's display-only
  precedent).
- The catalogue still holds ~20 thinner foreign currencies that remain API-orderable but
  unrouted. No data is lost; they're one threshold-crossing away from being surfaced.
  `docs/thin-currency-promotion.md` is the review cadence + measurement + promotion
  checklist for deciding when one of them crosses.
- ~~**No backend change** — CTX already creates and prices these merchants.~~ Superseded
  by the CF-19 order-path update above: the legacy CTX-proxy path needed none, but the
  loop-native path (handler currency gate, FX feed, and the `orders_currency_known` DB
  CHECK) all had to widen for these markets to be buyable. See the Status banner.
