# ADR 035: Extended supplier-currency display markets

## Status

Accepted (extends ADR 034's per-country model)

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
- **No backend change** — CTX already creates and prices these merchants.
