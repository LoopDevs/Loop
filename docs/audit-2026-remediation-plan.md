# Loop — Audit 2026 Remediation Plan

> Executes the fix queue against 467 findings captured by [`audit-2026-tracker.md`](./audit-2026-tracker.md). Plan is live; tracker is live. As findings resolve, this file's batch sections move from `pending` to `done`, and the tracker's finding entries move from `open` to `resolved` with the PR SHA.

## Operating rules

From [`audit-2026-adversarial-plan.md`](./audit-2026-adversarial-plan.md) §0.4 and §3.4:

- **Every finding gets fixed** — no severity is "not worth fixing" pre-launch. Severity only orders the queue: Critical → High → Medium → Low → Info (where action is implied).
- **`accepted` / `wontfix` / `deferred` require a written rationale + a second-reviewer sign-off.** Not defaults.
- **Small, surgical PRs preferred** so each fix has a clear commit SHA and isolates the change from others. Target: one PR per cluster of related findings, not one PR per finding nor one giant PR.
- **Test before claiming resolved.** Every code change lands with either a new test that would have caught the finding, or a documented reason why a test isn't feasible (e.g. org-level GitHub settings).
- **Update the tracker.** Each finding's entry gets `status: resolved`, `resolved-by: <PR#>`, and the PR number links both directions.
- **Re-audit on close.** For any Critical or High, a second reviewer independent of the code author confirms before marking resolved.

## Sequencing strategy

Pure Critical → High → Medium → Low is the default, but two refinements cluster work sensibly:

1. **Finding clusters** — several findings are alternate evidence of the same defect (e.g. A2-610 + A2-611 + A2-700 are all the same `accrue-interest.ts` bug). One PR closes the cluster.
2. **Surface clusters** — findings that touch the same files (e.g. the 5a admin handler batch) get bundled to avoid merge conflicts even if they span severities.

**Config changes** (GitHub org/repo settings, Fly env vars) can't be fixed via PR — they need a human in the GitHub UI / `fly` CLI. Called out explicitly below so nothing stalls the code queue.

---

## Batch 0 — User-action config changes (no PR)

These need to be changed in GitHub's / Fly's UI or CLI, not in code.

| Finding | Severity     | Action                                                                                                       | Who         |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------ | ----------- |
| A2-119  | **Critical** | Enable org-level 2FA requirement on `LoopDevs`. Both current admins must re-enroll their 2FA in the process. | org owner   |
| A2-105  | **High**     | Enable secret-scanning + dependabot-alerts + push-protection on repo and org                                 | org owner   |
| A2-101  | **High**     | Branch protection: remove admin-bypass; require ≥1 approving review                                          | org owner   |
| A2-114  | **High**     | Replace `superfly/flyctl-actions/setup-flyctl@master` with a SHA pin (code change — included in Batch 2/CI)  |
| A2-120  | Medium       | Upgrade org to a paid plan (or document acceptance) so audit log is retained                                 | org owner   |
| A2-121  | Medium       | Remove stale "stellarspendtest server" SSH key                                                               | org owner   |
| A2-122  | Low          | Add GPG keys for push-capable members                                                                        | each member |
| A2-123  | Low          | Disable merge commit + rebase merge; keep squash only                                                        | org owner   |
| A2-1406 | **High**     | Configure a `production` GitHub Environment; scope prod secrets to it                                        | org owner   |
| A2-1416 | Medium       | Move mainnet Stellar seed + `GH_SECRETS_PAT` to environment-scoped secrets                                   | org owner   |

**Until Batch 0 lands we still hold the audit-session posture.** Code Criticals can land on PRs because PRs don't require admin bypass and pre-push runs CI.

---

## Batch 1 — Critical code fixes

10 Critical findings collapse to 7 distinct code changes (some clusters). Each row = one PR.

| #   | Finding cluster                                                                                                   | PR scope                                                                                                                                                                                                               | Files                                                                                                      | Test plan                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **A2-550 + A2-551** (unverified CTX JWT + stellar-address write)                                                  | Add server-side verification to `requireAuth`: reject tokens whose `sub` doesn't match the bearer's actual holder. This is the root — A2-551 disappears once A2-550 is closed.                                         | `apps/backend/src/auth/handler.ts` + tests                                                                 | Integration: forged token with crafted `sub` claim → 401; legit token still → 200. Backed-up by Playwright replay of Phase 18 attack #1.               |
| 2   | **A2-720** (migration 0011 absent from `_journal.json`)                                                           | Add the 0011 entry to `apps/backend/src/db/migrations/meta/_journal.json`; validate `drizzle-kit migrate` picks it up; verify `admin_idempotency_keys` table creates on fresh DB.                                      | `apps/backend/src/db/migrations/meta/_journal.json`                                                        | Replay on ephemeral Postgres: `\d admin_idempotency_keys` must show the table.                                                                         |
| 3   | **A2-610 + A2-611 + A2-700** (accrue-interest: missing `currency` clause, lost-update race, missing `FOR UPDATE`) | Rewrite `accrue-interest.ts`: add `currency` to UPDATE predicate, wrap writer in `SELECT ... FOR UPDATE` inside a txn, add per-period idempotency (cursor table + unique constraint). Addresses A2-906 simultaneously. | `apps/backend/src/credits/accrue-interest.ts` + new migration for accrual cursor table + tests             | Concurrent-adjustment race reproduced from Phase 6.5 must now produce correct balance. Multi-currency user's two balance rows must remain independent. |
| 4   | **A2-601** (credit-funded orders stuck in `pending_payment`)                                                      | Implement the credit → order debit path; order transitions to `paid` when credit pulled.                                                                                                                               | `apps/backend/src/orders/procurement.ts` + `apps/backend/src/credits/adjustments.ts` + state-machine tests | New test: create credit-funded order → expect `paid` within procurement tick.                                                                          |
| 5   | **A2-602** (payout worker retry path unreachable)                                                                 | Expand `listPendingPayouts` to also select `state='submitted'` rows older than N minutes (watchdog). Closes A2-603 and amplifies A2-1512.                                                                              | `apps/backend/src/payments/payout-worker.ts` + tests                                                       | Test: force a payout into `submitted` + set timestamp >N min ago → next worker tick picks it up.                                                       |
| 6   | **A2-619** (cross-currency validation mismatch)                                                                   | Fix watcher validation: compare using same currency basis on both sides. Preferred: persist locked FX rate on order creation, always validate in `chargeCurrency`.                                                     | `apps/backend/src/orders/loop-handler.ts` + `apps/backend/src/payments/watcher.ts` + new order column      | New test: USD-charge GBP-card order → watcher accepts exact expected amount in USD.                                                                    |
| 7   | **A2-119**                                                                                                        | See Batch 0 — not a code fix.                                                                                                                                                                                          |

**Total Batch 1:** 6 code PRs + 1 user-action item.

**Order within batch:** PR 1 (auth bypass) is the most impactful and everything else that touches authed handlers should land after it — so every subsequent test can use a correctly-auth'd bearer. PR 2 (migration) is a one-line fix with no dependency; can land in parallel with PR 1. PR 3 is the accrue-interest cluster — can land in parallel with PR 1/2. PRs 4–6 touch order/payout state machines and should land sequentially to avoid merge conflicts in `orders/` and `payments/`.

---

## Batch 2 — High-severity fixes (79 findings, ~40 distinct PRs after clustering)

Batched by surface to minimize merge conflicts. Order: most-impactful surfaces first.

### 2A — Auth / token / session (8 findings)

A2-565 logout doesn't revoke Loop-native refresh · A2-566 social ID-tokens no nonce binding · A2-571 `EMAIL_PROVIDER=console` ships plaintext OTP in prod · A2-1608 refresh-token-reuse detected but family not revoked · A2-1600 Loop JWT missing `iss`/`aud` · A2-1150 session-restore wipes refresh on transient failures · A2-1151 logout doesn't reset `purchase.store` · A2-1152 logout doesn't `queryClient.clear()`.

→ Single PR on `apps/backend/src/auth/**` + `apps/web/app/hooks/use-auth.ts` + tests. Proper test coverage for replay, rotation, logout-completeness.

### 2B — Money flow (6 non-Critical Highs)

A2-605 memo collision risk · A2-613 ledger invariant unenforced · A2-614 no unique on `(type, ref_type, ref_id)` · A2-621 stuck-procurement sweeps CTX-fulfilled orders · A2-622 procurement txn gap · A2-626 cursor write outside txn loop · A2-900 reconciliation LEFT JOIN anchoring · A2-901 refund/spend/withdrawal writers absent · A2-902 no cashback idempotency constraint · A2-903 `user_credits.currency` no CHECK · A2-906 interest-accrual idempotency (covered by Batch 1 PR 3) · A2-2001 admin credit-adjustment idempotency race.

→ Multi-PR, clustered: (i) schema constraints migration (903 + 614 + 902), (ii) refund writer + reconciliation (900 + 901 + 908), (iii) procurement txn refactor (621 + 622 + 626), (iv) admin-write idempotency race (2001).

### 2C — Observability + security headers (~6 findings)

A2-1307 Sentry source maps · A2-1308 Sentry `beforeSend` scrubber · A2-1320 log retention · A2-655 redaction misses 6 secret keys · A2-1601 redaction misses JWT / DSN / webhooks · A2-1604 web emits zero security headers in prod.

→ Single observability+headers PR on `apps/backend/src/logger.ts`, Sentry init sites, `apps/web/app/utils/security-headers.ts` wiring.

### 2D — Cross-app contract drift (8 findings)

A2-1504 `LoopOrderView` no shared rep · A2-1505 13 `/me*` shapes web-only · A2-1506 ~30 admin shapes web-only · A2-1507 no CI drift detector · A2-1508 CTX procurement POST no idempotency · A2-1512 payout submitted rows never re-picked (overlaps Batch 1 PR 5) · A2-1518 accrue-interest (overlaps Batch 1 PR 3) · A2-1529 no client-version header · A2-1531 `LoopOrdersList.tsx` fallthrough · A2-1532 `assertNever` not adopted.

→ Multi-PR: (i) move shared types into `@loop/shared` + CI drift detector, (ii) add client-version header + backward-compat note, (iii) adopt `assertNever` + enable exhaustiveness ESLint rule.

### 2E — Mobile (2 findings)

A2-1200 iOS filesystem plugin not registered · A2-1206 iOS ↔ Android plugin parity.

→ Single PR on `apps/mobile/**` + CI check for iOS+Android plugin parity.

### 2F — Admin-surface (4 findings)

A2-502 cashback-config write not ADR-017-compliant · A2-652 operator-secret rotation unimplemented · A2-662 5 routes missing from openapi · A2-1000 ~11 more routes missing from openapi.

→ Admin-surface batch + openapi-drift CI job.

### 2G — CI/CD Highs (4 findings)

A2-1403 no rollback procedure · A2-1404 no preview envs · A2-1406 GitHub Environments (Batch 0) · A2-1408 no SAST.

→ Mostly config + doc work; one PR adds semgrep/CodeQL to CI and documents rollback.

### 2H — Image proxy SSRF (1 finding)

A2-672 DNS-rebinding TOCTOU.

→ Single PR on `apps/backend/src/images/proxy.ts` with DNS resolution-pinning.

### 2I — Operational-readiness Highs (14 findings — mostly doc + infra)

A2-1900..A2-1913. Each is a missing-runbook / missing-policy / missing-plan item. Approach:

- One PR creates the `docs/runbooks/` skeleton with per-alert templates (closes A2-1900, A2-1917).
- One PR drafts the incident/on-call/escalation playbook (A2-1901, A2-1902, A2-1903).
- One PR schedules + documents the first backup-restore rehearsal (A2-1904).
- One PR implements `DELETE /me` and `GET /me/export` (A2-1905, A2-1906).
- One PR adds env-flag kill-switches for `AUTH_DISABLED`, `ORDERS_DISABLED`, `PAYOUTS_DISABLED` (A2-1907) — with boot-time warning.
- One PR documents signing-cert expiry cadence + renewal runbook (A2-1908).
- One PR documents JWT/operator secret rotation schedule + rehearsal (A2-1909).
- One PR writes the DR plan w/ RPO/RTO (A2-1910).
- One PR adds log-retention + PII redaction policy doc (A2-1911).
- One PR replaces placeholder legal copy (A2-1912) — needs lawyer.
- One PR stands up staging env config (A2-1913).

Some of these will be short (write a doc); others (DSR endpoints, kill switches, staging) are substantive code changes.

### 2J — Remaining High items

A2-1819 AGENTS.md false auth-rule (doc fix) · A2-1701 missing credits module tests · A2-1704 OTP e2e flake · A2-1705 no full-journey e2e · A2-1706 no CTX contract tests.

→ Mixed doc + test PRs.

---

## Batch 3 — Medium-severity fixes (171 findings)

Approach identical to Batch 2 — clustered by surface. Full table generated on entry to Batch 3 so ordering stays responsive to what remains open once Batches 1 and 2 land. Too many findings to meaningfully pre-assign ordering here.

Estimated ~80 PRs after clustering; 4–6 per cluster-surface.

---

## Batch 4 — Low-severity fixes (164 findings)

Same shape. Mostly doc drift, style inconsistencies, orphan assets, unused exports. Many are one-liner deletes.

The four Phase-0 findings (A2-001 favicons, A2-002/003/004 asset dupes/orphans) land here as the opener since they're the simplest and remove tracker noise.

---

## Batch 5 — Info findings (43)

Per plan §3.4, Info findings "are discussed at sign-off; actions re-classified up only if an Info implies work." Triage pass:

- Drop any pure-observation Info (no action implied)
- Re-classify to Low+ any Info that actually needs a change
- Remaining become part of the sign-off record as `accepted-observation`

---

## Re-audit discipline

After every batch completes:

1. Re-run the impacted phase's evidence gathering on the new commit SHA — e.g. after Batch 1 PR 1 lands, re-probe Phase 12's auth matrix and Phase 18 attack #1.
2. If re-probe finds a regression, file a new finding (A2-NNN continuing from 2100+) and add it to the appropriate batch.
3. The goal of each batch is to retire a cluster of findings, not to introduce new ones. Net-new findings from re-probes halt the batch until they're addressed.

---

## Tracker update protocol

When a PR merges and closes a finding:

1. Edit `docs/audit-2026-tracker.md`:
   - Change the finding's `Status` column from `open` to `resolved`
   - Add the PR number to its notes
   - Decrement the `open` count, increment `resolved` in the index table
2. Add a line to this document's batch section: `✅ A2-NNN resolved by PR #XYZ`.
3. If the PR closes multiple findings, list them all.
4. If a second-reviewer hasn't signed off yet (required for Critical/High), use `resolved-pending-review` until they do.

---

## Open questions for the owner (not audit findings — decisions for remediation to proceed)

1. **Batch 0 config changes** — who has GitHub org admin access to flip 2FA / secret-scanning / branch protection?
2. **Legal copy** (A2-1912) — is there a lawyer engaged to replace the privacy/terms placeholders, or is a first-party draft acceptable for pre-launch?
3. **Staging env** (A2-1913) — Fly account can host a second app; what's the budget ceiling?
4. **DR plan** (A2-1910) — multi-region? One-region + documented "accept >1hr RTO on Fly region outage"?
5. **Apple/Google signing** (A2-1908) — who holds the certs; what's the renewal runbook owner?
6. **DSR endpoints** (A2-1905, A2-1906) — what's the promised turnaround time per the current privacy copy? (Drives implementation priority for export-my-data async pipeline.)
