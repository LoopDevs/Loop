# Cross-cutting pass — Data handling / Privacy / Compliance (§16, §31)

> Cold audit 2026-06-15. Branch `fix/stranded-order-hardening`.
> Scope: PII inventory + flow, redaction (logs/Discord/Sentry), encryption
> (transit + rest), retention/erasure (GDPR), tax/regulatory model (ADR 026),
> legal posture (privacy/terms/consent/geo-sanctions/e-money), CSV-export
> compliance. Method: read the redaction config, schema, DSR code, Discord
> notifiers, email/OTP path, CSV exporters, legal routes, and ADR 026 in full;
> grep-swept the tree for plaintext http, retention deletes, age/consent/sanctions
> gating, and secret leaks into the three external sinks (Discord/Sentry/email).

---

## Coverage — PII inventory

| PII / sensitive field                                           | Stored where                                                                              | At rest                                                                                     | Read / exported / sent externally                                                                                                                                                                                                                                                   | Minimised?                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **email**                                                       | `users.email`, `otps.email`, `user_identities.email_at_link`, `credit_transactions`(none) | plaintext (Fly vol encryption)                                                              | logged in app logs **by design** (logger.ts:11, NOT redacted); admin CSV (`user-credits-csv`, `audit-tail-csv`); admin search query → redacted in admin-read-audit; Sentry → scrubbed by `EMAIL_RE`; Discord admin-audit → dropped (A2-511). Sent to Resend (user's own addr only). | Yes — operators need it for audit story; documented trade-off |
| **OTP code**                                                    | `otps.code_hash`                                                                          | **SHA-256 hash** (otps.ts:38)                                                               | plaintext only in user's email + verify-otp POST body; Pino redacts `otp`/`code`; never to Discord/Sentry                                                                                                                                                                           | Yes                                                           |
| **refresh token**                                               | `refresh_tokens.token_hash`                                                               | **SHA-256 hash** (refresh-tokens.ts:21)                                                     | redacted in logs/Sentry; memory(web sessionStorage)/Keychain(native) client-side                                                                                                                                                                                                    | Yes                                                           |
| **social id_token**                                             | `social_id_token_uses.token_hash`                                                         | **SHA-256 hash** (id-token-replay.ts:46)                                                    | replay guard only                                                                                                                                                                                                                                                                   | Yes                                                           |
| **access token (JWT)**                                          | not persisted (memory only)                                                               | n/a                                                                                         | `Bearer …` redacted in logs (authorization path) + Sentry `BEARER_RE`                                                                                                                                                                                                               | Yes                                                           |
| **redeem_code / redeem_pin / redeem_url** ("ARE the gift card") | `orders.redeem_*`                                                                         | **PLAINTEXT** (schema.ts:486-491) — only Fly vol at-rest enc; no app-level/per-row envelope | returned only to owner (`GET /api/orders/loop/:id`, owner-scoped); excluded from DSR export, admin CSV, Discord, Sentry; logged only-when-all-null                                                                                                                                  | Partial — see X-PRIV-03                                       |
| **Stellar address**                                             | `users.stellar_address`, `pending_payouts.to_address`                                     | plaintext                                                                                   | admin `payouts-csv` (full address + tx_hash); Discord truncated `first8…last4`; DSR delete scrubs terminal-row `to_address`                                                                                                                                                         | Yes                                                           |
| **user_id (UUID)**                                              | every ledger/order/payout/identity table                                                  | plaintext                                                                                   | admin CSVs; Discord (mostly last-8, two notifiers leak full — X-PRIV-02); DSR export                                                                                                                                                                                                | Mostly                                                        |
| **order_id (UUID)**                                             | `orders.id`                                                                               | plaintext                                                                                   | Discord (full in several `orders`/monitoring notifiers); admin CSV                                                                                                                                                                                                                  | Partial                                                       |
| **tx_hash, amounts, currency, home_currency**                   | `pending_payouts`, `orders`, `credit_transactions`, `users`                               | plaintext                                                                                   | admin/tax CSV; Discord; DSR export                                                                                                                                                                                                                                                  | Yes (financial records, retention-required)                   |
| **client IP**                                                   | access logs only (not DB)                                                                 | Fly logs 14d                                                                                | access-log line; Google Fonts + CARTO/OSM tiles leak IP to 3rd parties at page load (ADR 005 §10)                                                                                                                                                                                   | Partial — EU notice deferred                                  |
| **idempotency keys**                                            | `admin_idempotency_keys.key`                                                              | plaintext (24h TTL sweep)                                                                   | redacted in logs + Sentry (A4-039/40); Discord first-32                                                                                                                                                                                                                             | Yes                                                           |

External sinks audited: **Discord** (3 channels), **Sentry** (backend + web scrubbers), **Resend** (email), **upstream CTX** (auth/orders), **Postgres** (Fly). No redeem codes/PINs/OTP/tokens reach any sink.

---

## Findings

### X-PRIV-01 — P1 — No in-app UI for account deletion / data export (DSR last-mile + App Store blocker)

- **Vertical:** web client / legal (V9, §16, §31)
- **Evidence:** Backend DSR primitives EXIST and are solid — `apps/backend/src/users/dsr-delete.ts` (`POST /api/users/me/dsr/delete`, anonymisation + in-flight blocks + single txn + tested) and `dsr-export.ts` (`GET /api/users/me/dsr/export`, versioned JSON, redeem codes excluded). But there is **no web UI** wiring either: `apps/web/app/services/` has no DSR client; settings routes are only `settings.cashback.tsx` + `settings.wallet.tsx`. Users can only exercise GDPR rights by hand-crafting an authed API call or emailing `privacy@loopfinance.io`.
- **Impact:** GDPR Art. 15/17 friction; **Apple App Store Guideline 5.1.1(v) requires an in-app account-deletion path** → likely submission rejection (the memory tracker lists App Store submission as a pending Phase-1 item).
- **Fix:** add a settings → privacy screen wiring both endpoints with the 409-block UX the handler already returns.

### X-PRIV-02 — P1 — No DSR operator runbook; per-user log-export path undocumented

- **Vertical:** ops/legal (§30, §31)
- **Evidence:** `docs/runbooks/` (25 files) has no DSR runbook for A2-1905/A2-1906. `docs/log-policy.md:108` explicitly DEFERS "Per-user log-export flow tied to the DSR work (A2-1906)" to Phase 2, yet `dsr-export.ts` promises a `privacy@loopfinance.io` fallback for the data (logs/Sentry/Discord) it can't export — with no documented process behind it.
- **Impact:** a real DSR request arriving at launch has no operational answer for the off-DB data.
- **Fix:** add `docs/runbooks/dsr.md` covering delete/export invocation + the manual log/Sentry/Discord export, or pull A2-1906 forward.

### X-PRIV-03 — P1 — Gift-card redeem codes/PINs stored plaintext at rest (relies on Fly volume encryption only)

- **Vertical:** orders / data-at-rest (V2, §16)
- **Evidence:** `apps/backend/src/db/schema.ts:486-491` — "Sensitive: these fields ARE the gift card. Postgres-at-rest encryption on Fly volumes is the current defence; a future slice can wrap with a per-row envelope once we have KMS." `redeem_code` / `redeem_pin` / `redeem_url` are stored as plain `text`.
- **Impact:** a logical DB compromise (leaked `DATABASE_URL`, SQLi-equivalent, rogue `loop-readonly` SELECT role, backup exfiltration) yields spendable bearer instruments — these are cash-equivalent. Fly volume encryption protects only against physical-disk theft, not logical reads. The `loop-readonly` role (log-policy.md RBAC) has SELECT on this table.
- **Fix:** per-row envelope encryption (KMS/libsodium) for the three redeem columns before public order traffic; decrypt only in the owner-scoped read handler. Tracked-but-deferred in the schema comment — promote to a launch gate given the bearer-instrument value.

### X-PRIV-04 — P1 — No terms-acceptance or age (18+) capture at signup; both asserted in Terms

- **Vertical:** legal / onboarding (§31)
- **Evidence:** `apps/web/app/components/features/onboarding/signup-tail.tsx` — signup is email → OTP → welcome with **no terms checkbox, no agree link, no age/DOB capture**. `terms.tsx` §1 relies on implied/browsewrap acceptance and §2 asserts "must be at least 18". Repo grep for `date_of_birth|dob|age|over18` → zero capture fields anywhere.
- **Impact:** browsewrap acceptance is weak/unenforceable for a fintech; the 18+ eligibility claim is unbacked. Consent record is required for GDPR lawful-basis defensibility.
- **Fix:** explicit terms+privacy acceptance checkbox (timestamped, persisted) and an age attestation at signup before public launch.

### X-PRIV-05 — P1 — No sanctions / OFAC / geo-eligibility screening anywhere

- **Vertical:** compliance (§16 KYC/AML, §31)
- **Evidence:** MaxMind GeoLite2 is used **only** for locale routing (`apps/backend/src/public/geo.ts`, ADR 033/034). Repo grep for `sanction|ofac|embargo|restricted countr|geo-block` → hits only in audit checklists, never in app code. No screening of users or Stellar payout destinations. Terms §2 ("certain regions may be restricted") is aspirational.
- **Impact:** for a stablecoin-payout fintech, zero sanctions screening on accounts or payout addresses is a material AML/OFAC gap. Live exposure is limited while payouts are Phase-2-gated, but it blocks Phase-2/mainnet.
- **Fix:** payout-destination + user-jurisdiction sanctions screening before any on-chain payout ships; decide a restricted-country posture for orders.

### X-PRIV-06 — P1 — E-money / custody / yield licensing + mandatory "no guarantee" disclaimer entirely deferred (unscheduled counsel)

- **Vertical:** legal (§31, ADR 015/030/031)
- **Evidence:** ADRs candidly frame USDLOOP/GBPLOOP/EURLOOP as 1:1-backed fiat liabilities = e-money/MSB territory (ADR 015:36-40, 237-240); Privy = "custodial-adjacent, ADR 009's non-custodial framing partially abandoned" (ADR 030:89-92); LOOPUSD/EUR yield = MiCA/SEC/FCA investment-service territory, GBPLOOP 3% APY mint = EMI issuance (ADR 031:175-200). ADR 031 §144-153 mandates an always-visible "past performance doesn't guarantee future returns" disclaimer adjacent to APY — **not built**: `CashbackBalanceCard.tsx` shows raw balances, grep for "not a bank/not FDIC/no guarantee/APY" in `apps/web` → zero user-facing instances. Counsel engagement "unscheduled" per both ADRs.
- **Impact:** licensing (UK FCA EMI / EU MiCA / US MSB) and required risk disclaimers are absent. Held back from users only by the `LOOP_PHASE_1_ONLY` runtime flag (`Phase2Gate`). Phase-2/mainnet blocker.
- **Fix:** counsel review + the spec'd disclaimers wired before the phase flag flips. (Acknowledged in roadmap, surfaced here as a launch gate.)

### X-PRIV-07 — P2 — Expired/consumed OTP rows are never purged (unbounded PII growth)

- **Vertical:** retention (§16, §9)
- **Evidence:** `apps/backend/src/cleanup.ts` sweeps only rate-limit entries + admin idempotency keys. No `delete(otps)` exists anywhere. `otps` holds `email` + `code_hash`; rows are marked `consumed_at` but never deleted, so the table grows without bound.
- **Impact:** steadily accumulating PII store with no retention limit; contradicts the privacy policy's deletion claims.
- **Fix:** add an OTP sweep (delete `expires_at < now() - grace`) to `runCleanup`.

### X-PRIV-08 — P2 — `refresh_tokens` cleanup job documented in schema but does not exist (stale comment + missing sweep)

- **Vertical:** retention (§16, §5, §9)
- **Evidence:** `schema.ts:388-391` claims `refresh_tokens_expires` is "Used by a periodic cleanup job that trims fully-expired rows after the refresh horizon." No such job exists — `cleanup.ts` never touches `refresh_tokens`; no `delete(refreshTokens)` for expired rows. Revoked/expired tokens (with `token_hash`) accumulate forever.
- **Impact:** false documentation (doc↔code drift) + genuine missing retention sweep.
- **Fix:** implement the expired-refresh-token sweep the comment promises, or correct the comment.

### X-PRIV-09 — P2 — Privacy policy + Terms are non-binding placeholders; not linked at signup

- **Vertical:** legal (§31, §5)
- **Evidence:** `apps/web/app/routes/privacy.tsx:7-22,42,50` and `terms.tsx:7-22,44,52` are explicit scaffolds with a rendered yellow "placeholder pending final legal review" banner and "Don't use the placeholder text in any binding context." Linked only in the Footer, not at signup. Mailboxes (`privacy@`/`legal@`/`hello@`) referenced in copy may not be provisioned (roadmap:120).
- **Impact:** no legally binding privacy/terms at launch; DSR contact + 30-day deletion claim ride on unprovisioned mailboxes.
- **Fix:** legal-reviewed copy drop-in + mailbox provisioning before public submission. (Honestly self-flagged — quality of disclosure is good.)

### X-PRIV-10 — P2 — Two monitoring Discord notifiers emit full user_id + order_id (convention drift)

- **Vertical:** observability/redaction (V15, §6, §16)
- **Evidence:** `apps/backend/src/discord/monitoring.ts:328-334` (`notifyPegBreakOnFulfillment`) and `monitoring-stuck-sweepers.ts:61-62` (`notifyStuckProcurementSwept`) emit **full** `userId` + `orderId`, where every other notifier uses `slice(-8)` (the sibling `notifyRedemptionBackfillExhausted` in the same file is correctly truncated). `notifyStuckPayouts:191` emits a full `payoutId` (lower sensitivity). Discord webhooks bypass Pino redaction, so payloads are not auto-scrubbed.
- **Impact:** an actor with Discord-only access (support role per log-policy RBAC) can reconstruct full user/order UUIDs. Low likelihood (rare events) but a clear convention violation.
- **Fix:** mechanical `.slice(-8)` on both fields in the two notifiers + their description templates.

### X-PRIV-11 — P2 — User cashback-history CSV + tax-report script use RFC-4180-only escapers (no formula-injection guard)

- **Vertical:** exports (§17, §16)
- **Evidence:** `apps/backend/src/users/cashback-history-handler.ts:176-181` (`GET /api/users/me/cashback-history.csv`) and `scripts/quarterly-tax.ts:66-73` each define a local `csvField` that quotes per RFC 4180 but does **not** prefix `=`/`+`/`-`/`@` (the formula-injection guard). All 18 admin CSV exporters route through the hardened shared `admin/csv-escape.ts` `csvEscape`; these two bypass it. Real risk is low (fields are mostly enum/numeric/UUID; user export is self-scoped) but it's divergent and the tax CSV is opened by an accountant in Excel.
- **Fix:** route both through a shared, formula-injection-safe escaper (promote `csvEscape` out of `admin/`).

### X-PRIV-12 — P3 — TLS not enforced at the schema layer for some upstream URLs; no app-level HTTP→HTTPS redirect

- **Vertical:** transit (§7, §16)
- **Evidence:** all external calls use https in practice (CTX, Horizon, Resend, Discord, CoinGecko) and web rejects http redeem URLs in prod (`native/webview.ts:43`). But `env.ts` validates `GIFT_CARD_API_BASE_URL`, Discord webhooks, and `LOOP_STELLAR_HORIZON_URL` with `z.string().url()`, which accepts `http://`. HSTS = Hono default `max-age=15552000; includeSubDomains` (180d, no preload). HTTP→HTTPS upgrade handled at Fly edge, not in-app.
- **Fix:** tighten env validators to https-only outside dev; consider HSTS `preload` + longer max-age once apex is on HTTPS.

### X-PRIV-13 — P3 — No standalone data-retention policy doc; retention claims unenforced

- **Vertical:** docs/retention (§5, §16)
- **Evidence:** retention rules live only in the placeholder `privacy.tsx` (30-day deletion claim, unenforced) and `log-policy.md` (logs 14d / Sentry 30d / Discord unbounded). No `docs/data-retention.md`. Orders/`credit_transactions`/`users`/`user_credits` have no jurisdiction-aware retention sweep (intentional for ledger, but the policy claim has no automation).
- **Fix:** a retention policy doc reconciling the ledger-retention-vs-erasure tension and the actual sweeps.

---

## Summary

**Counts:** 13 findings — **0 P0**, **6 P1**, **5 P2**, **2 P3**.

**P1 one-liners:**

- X-PRIV-01 — DSR delete/export exist server-side but have **no in-app UI** → GDPR friction + Apple 5.1.1(v) submission blocker.
- X-PRIV-02 — **No DSR runbook**; the promised `privacy@` log-export fallback (A2-1906) is undocumented/deferred.
- X-PRIV-03 — Gift-card **redeem codes/PINs stored plaintext** at rest (Fly volume enc only; `loop-readonly` can SELECT) → cash-equivalent bearer leak on logical DB compromise.
- X-PRIV-04 — **No terms-acceptance or 18+ age capture at signup**, both asserted in Terms (browsewrap only).
- X-PRIV-05 — **Zero sanctions/OFAC/geo-eligibility screening** of users or payout destinations (geo is locale-display only).
- X-PRIV-06 — **E-money/custody/yield licensing + mandatory "no guarantee" disclaimers entirely deferred** (unscheduled counsel); held off users only by `LOOP_PHASE_1_ONLY`.

**Strengths (no finding warranted):** OTP/refresh/id-token all SHA-256-hashed at rest; Pino `REDACT_PATHS` + dual Sentry scrubbers (key-based + free-text email/Bearer/Stellar/hex) are thorough and unit-tested; Discord embeds no codes/PINs/OTP/tokens and the admin-audit channel drops email; redeem codes are owner-scoped on read and excluded from DSR/CSV/Discord/Sentry; admin CSVs are uniformly `requireAdmin`-gated, admin-read-audited, and formula-injection-safe; DSR delete is a sound anonymisation (append-ledger-aware, in-flight-blocked, single txn); ADR 026 tax data model maps every reportable event and the quarterly CSV emitter is implemented; ADRs are candid about the regulatory gaps.

**Scope note:** Branch is `fix/stranded-order-hardening`; the Privy wallet stack (ADR 030, PRs #1424-#1428) is NOT on this branch — custody-adjacent code is forward-looking comments only, so X-PRIV-06's custody half is design-stage. The six P1s are launch-gates, not live-traffic P0s: financial instruments are runtime-gated by `LOOP_PHASE_1_ONLY` and on-chain payouts by `LOOP_WORKERS_ENABLED`. The redeem-code at-rest gap (X-PRIV-03) is the closest to live exposure since Phase-1 orders capture real codes.
