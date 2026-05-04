# ADR 026: Tax / regulatory reporting data model

Status: Accepted
Date: 2026-04-26
Resolves: A2-1923

## Context

ADR 010's principal switch made Loop the **merchant of record** for
every gift-card sale. Before that, gift cards moved CTX→customer with
Loop as a referral; tax / VAT / anti-money-laundering reporting was
CTX's responsibility under their licences. After: Loop sells the
gift card, Loop pays CTX wholesale, Loop owes the regulators.

The reporting surfaces this opens up:

- **UK FCA / HMRC** — Loop is GB-incorporated. Quarterly gift-card
  sales volume + per-customer totals over reporting thresholds; VAT
  treatment of gift-card sales (the gift card itself is generally
  outside the scope of VAT until redeemed for goods, but the cashback
  Loop pays is its own line).
- **US IRS** — for US-resident customers, 1099-MISC reporting on
  cashback paid out where the annual total per recipient exceeds the
  reporting threshold. (Cashback is, for tax purposes, generally a
  "rebate" rather than income — but Loop still needs the records to
  defend that classification.)
- **EU member states** — depends on customer residence; DAC8
  (crypto-asset reporting) brings the on-chain LOOP-asset payouts
  into per-customer reporting once Loop crosses the threshold.

A2-1923 was the audit's flag that the **data model can't currently
support any of this**: we record the orders, the cashback ledger,
and the on-chain payouts, but we don't tag rows with the
jurisdictional metadata that turns them into regulatory exports.

## Decision

**Phase 1 — adopt the conservative two-layer reporting model.**

1. **Layer 1 (data — implemented):** every reportable event is
   already in our DB, just denormalised across tables:
   - **Order facts** — `orders.face_value_minor`, `currency`,
     `charge_minor`, `charge_currency`, `created_at`, `fulfilled_at`,
     `failed_at`, `state`, `merchant_id`. Maps to "gift card sales
     volume" reports per jurisdiction.
   - **Cashback paid** — `credit_transactions.type='cashback'`
     rows with `amount_minor` + `currency`. Maps to "rebate paid"
     reports per recipient.
   - **On-chain settlement** — `pending_payouts.state='confirmed'`
     rows with `amount_stroops`, `asset_code`, `confirmed_at`,
     `tx_hash`. Maps to DAC8 / crypto-asset reporting.
   - **User jurisdiction proxy** — `users.home_currency` (USD / GBP
     / EUR). At Phase 1 home currency is a useful proxy for the
     tax jurisdiction (US for USD, UK for GBP, EU for EUR) but it
     **conflates** — a UK resident on a US holiday paying USD into
     a USD card has `home_currency='GBP'` (correct for ledger) but
     UK is the right reporting jurisdiction.

2. **Layer 2 (reports — implemented as CSV exports):**
   `scripts/reports/quarterly-tax.ts` emits one CSV per report
   shape, parameterised by quarter. Outputs:
   - `gift-card-sales-{YYYY-Q}.csv` — per-`(merchant_id,
catalog_currency)` order count, face value sum, wholesale
     paid to CTX, cashback paid to user, Loop margin
   - `cashback-rebates-{YYYY-Q}.csv` — per-`(user_id, currency)`
     cashback amount + count of qualifying credit_transactions
   - `crypto-payouts-{YYYY-Q}.csv` — per-`(user_id, asset_code)`
     on-chain payout amount + count of confirmed pending_payouts

   Each CSV is gated on the deployed-state spot-check (A2-1924) +
   the monthly reconciliation pass (A2-1914) — neither runs without
   confirmed-clean data inputs.

**Phase 2 — add explicit jurisdiction tagging.** Two columns:

- `users.tax_residence_country` (ISO 3166-1 alpha-2; nullable;
  populated at signup via the existing geolocation hint, confirmed
  by the user at first reportable threshold crossing)
- `orders.tax_jurisdiction` (the country whose VAT / sales tax law
  applies; pinned at order-creation time so a user moving country
  later doesn't retroactively reshape historical orders)

Phase-2 column adds are **migrations**, not data backfills. Rows
created before the columns land carry NULL; the report queries
treat NULL as "use home_currency proxy" until backfill is signed
off.

**Phase 3 — automated submission.** Connect to HMRC's MTD
(Making Tax Digital) endpoint + IRS e-file + DAC8 reporting
gateways. Out of scope for Phase 1. The CSV exports above are the
"manually upload" precursor.

## Why CSV first instead of an API integration

- CSV exports work for accountants tomorrow. HMRC / IRS API
  integrations are weeks of effort each, and they can't go live
  until Loop has registered with the relevant gateway as a
  reporter (paperwork process in their hands).
- CSV exports map cleanly to the audit-trail Discord post in
  A2-1914 (monthly reconciliation) — the same SQL queries underly
  both, so a discrepancy in the tax export is the same shape of
  discrepancy as the monthly reconciliation.
- A future-API integration can read the CSV files as a transition
  bridge — same column shape, just sent over a different transport.

## Why home_currency as a Phase-1 jurisdiction proxy

It's wrong in edge cases. A UK resident with `home_currency='USD'`
because they buy mostly US gift cards is mis-tagged as a US
taxpayer in the Phase-1 export. The Phase-1 mitigation:

1. The CSV is reviewed by a human accountant before submission.
   They catch the mis-tag during review.
2. The report headers include a note that home_currency is the
   proxy, not the source of truth.
3. Phase-2 `tax_residence_country` is explicitly the migration
   path; the Phase-1 proxy is documented as known-imprecise.

## Acceptance criteria

This ADR pins the **design** for Phase 1. The implementation
(actual CSV emitter, schema migrations) follows in subsequent PRs
each citing this ADR + its respective tracker ID.

- [x] Data model maps every reportable event to existing columns
      (orders / credit_transactions / pending_payouts) — confirmed
      by walking the schema in this ADR
- [x] Spot-check + reconciliation prerequisites pinned in
      `docs/runbooks/deployed-state-spotcheck.md` (A2-1924) +
      `docs/runbooks/monthly-reconciliation.md` (A2-1914)
- [x] Home-currency-as-jurisdiction-proxy limitation documented
      with the Phase-2 migration path
- [x] Phase 1: CSV export emitter at
      `apps/backend/src/scripts/quarterly-tax.ts` driven by
      `npm --workspace=@loop/backend run report:quarterly-tax -- --quarter=YYYY-Q`
      (A4-062, 2026-05-04). Three CSVs per quarter: `gift-card-sales`,
      `cashback-rebates`, `crypto-payouts`.
- [x] Phase 1: each CSV header lines (5 `#`-prefixed metadata rows)
      carry report id, quarter, window, generation timestamp, and the
      home_currency-as-proxy note.
- [x] Phase 1: output writes to `tmp/reports/<quarter>/` at the repo
      root (gitignored; operator uploads from there).
- [ ] Phase 2: schema migration adding `users.tax_residence_country` +
      `orders.tax_jurisdiction`
- [ ] Phase 2: backfill + UI prompt at first threshold crossing
- [ ] Phase 3: API submission

## Open questions for Phase 2

- **Threshold for IRS 1099-MISC.** Currently $600 / year per
  recipient (post-2026 schedule); needs accountant sign-off before
  the cashback report fires.
- **VAT on cashback.** UK / EU treatment depends on whether
  cashback is a price reduction (no VAT effect) or a discrete
  rebate (potentially VAT-recoverable). Open question; defer to
  Phase 2 with accountant input.
- **DAC8 reporting threshold.** EU-side; activates once Loop has
  a registered EU customer base of any size. Until then this
  layer is informational only.

## References

- ADR 010 — principal switch (the change that created the
  reporting obligation)
- ADR 015 — stablecoin topology (defines what "on-chain payout"
  means for DAC8)
- A2-1914 — monthly reconciliation runbook (the input-validation
  step the tax export runs after)
- A2-1924 — deployed-state spot-check (the gating check before
  any of these reports go to a regulator)
- `docs/runbooks/monthly-reconciliation.md` §"Cross-references" —
  same call-tree but for the CTX-invoice ⇄ ledger pass
