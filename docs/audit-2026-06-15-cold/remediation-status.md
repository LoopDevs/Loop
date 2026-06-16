# Cold Audit 2026-06-15 — Remediation Status

Tracks each canonical finding in `findings.md` to its remediation PR. **All 10
numbered waves of `remediation-plan.md` are complete and merged to `main`.** The
separate gated cashback-mode / wallet-branch track is Tranche-2 scope and partly
external-dependency-blocked (see bottom).

## Merged

| Finding                                                          | Wave  | PR           | Notes                                                                                             |
| ---------------------------------------------------------------- | ----- | ------------ | ------------------------------------------------------------------------------------------------- |
| CF-04 audit gate (+ robustness)                                  | 0     | #1434, #1437 | critical hard-fail; high gated + warn-on-flap; moderate advisory pre-launch                       |
| CF-02 RedeemFlow postMessage + script caps                       | 1     | #1442        | full signature-scheme noted as follow-up                                                          |
| CF-03 operator-tooling lockdown                                  | 1     | #1453        | loopback bind + token, SSRF allowlist, demo-seed prod guard, XSS                                  |
| CF-25 redeem codes encrypted at rest                             | 1     | #1446        | AES-GCM, ships dark until `LOOP_REDEEM_ENCRYPTION_KEY` set                                        |
| CF-24 / CF-31 web auth-gating + brand country scope              | 1     | #1441        | + CF-30 native admin grant in #1450                                                               |
| CF-30 native-auth admin grant                                    | 1     | #1450        | `ADMIN_EMAILS` allowlist on native users                                                          |
| CF-06 / CF-07 / CF-08 admin money-write safety                   | 2     | #1443        | refund step-up+cap+validation, compensate gate, step-up purpose scope                             |
| CF-09 / CF-10 web step-up + audit tripwire                       | 2     | #1451        | modal on payouts, stable idempotency key, JSON bulk-read audit                                    |
| CF-11 step-up handler tests                                      | 2     | #1443        | covered with the step-up scope work                                                               |
| CF-12 / CF-13 CTX 429 + expired-bearer failover                  | 3     | #1444        | 429 defers (not fails); 401 → unhealthy + failover + alert                                        |
| CF-15 / CF-16 / CF-20 / CF-21 order/withdrawal/payout resilience | 3     | #1454        | post-pay-ctx auto-refund, withdrawal compensation, peg-break durable row, kill-switch in worker   |
| CF-23 bigint-exact currency display                              | 4     | #1445        |                                                                                                   |
| CF-22 route-locale formatting + one format seam                  | 4     | #1455        | string-translation seam documented as Phase-2 (one locale today)                                  |
| CF-33 / CF-34 runbook/env/error-code drift                       | 5     | #1448        |                                                                                                   |
| CF-28 procureOne pay-ctx regression guard                        | 5     | #1438, #1450 |                                                                                                   |
| CF-29 perf indexes + Sentry split + stats cache                  | 6     | #1439, #1456 | migration 0036                                                                                    |
| CF-35 money-path accessibility                                   | 7     | #1447        | aria-live, focus traps, countdown, memo-strand fix, radiogroups, skip-link                        |
| CF-19 extended-market order path                                 | 8     | #1459        | migration 0037; FX-ready, fails closed (`CURRENCY_NOT_AVAILABLE`) until rates serves the currency |
| CF-26 DSR UI + auth-row purge + CSV guard                        | 9     | #1452        | legal items (terms/age, sanctions, e-money) noted as non-code follow-ups                          |
| CF-27 / CF-36 Apple Sign-In + ADR-027 trigger decision           | 10    | #1449        |                                                                                                   |
| CF-14 worker row-claim (`FOR UPDATE SKIP LOCKED`)                | gated | #1457        |                                                                                                   |
| CF-18 authoritative tx-hash payout idempotency                   | gated | #1458        |                                                                                                   |
| pay-ctx amount/asset + SEP-7 memo-type hardening                 | —     | #1438        | the stranded-order namesake                                                                       |
| CSV numeric-literal escape regression (from CF-26)               | —     | #1460        | negative amounts no longer corrupted to text                                                      |

## Residual — gated cashback-mode / wallet track (Tranche-2, NOT a numbered wave)

These are explicitly scoped "before Tranche-2, not before Tranche-1" in
`remediation-plan.md`, are inert in Phase-1 discount mode, and require the
wallet feature-branch merge train + human review of money/Stellar/on-chain code:

- **CF-01** — merge `fix/adr036-emission-burn` (issuer-return burn) and verify it
  closes the drift-term gap (CF-17). Needs migration renumber (its 0035–0039
  now collide with merged 0035/0036/0037) + a rebase onto current `main`.
- **CF-05** — `feat/wallet-phase-d-interest` `interest-mint.ts` mints unbacked
  LOOPUSD/LOOPEUR + uses retired asset codes; fix before merge.
- **CF-32** — Privy `raw_sign` auth-key, Privy webhook handler, DeFindex vault.
  **External blocker:** Privy business DD / account (task #21).

These require Ash's review of the wallet integration and the Privy DD before
they can land; tracking them here keeps the audit loop closed.

## Operator follow-ups surfaced by the remediation (set/deploy, no code)

- `flyctl secrets set LOOP_REDEEM_ENCRYPTION_KEY=$(openssl rand -base64 32) -a loopfinance-api` to activate CF-25 encryption.
- `ADMIN_EMAILS` secret to grant native admins (CF-30).
- Rates service (`~/code/rates`) must serve AED/INR/SAR/AUD/MXN to flip extended-market ordering live (CF-19).
- Legal/compliance: terms-acceptance + 18+ capture, sanctions/OFAC screening, e-money/custody + APY disclaimers (CF-26 deferred set).
- `tsx` non-major bump to drop one accepted high advisory (CF-04 follow-up).
