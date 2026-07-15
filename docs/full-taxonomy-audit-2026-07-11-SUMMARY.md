# Full-Taxonomy Cold Audit — loop-app — Completion & Combined Coverage Statement

**Date:** 2026-07-11 · **Commit audited:** `83010533` · **Type:** cold / adversarial / systematic, read-only (findings only, no code changes) · **Status: COMPLETE.**

This is the top-level index. The findings live in three companion docs:

- **[audit-recipe.md](audit-recipe.md)** — the project recipe (architecture, invariants + enforcement tiers, adversary matrix, money flows, tech traps, in-scope vs N/A dimensions). Read this first.
- **[full-taxonomy-audit-2026-07-11.md](full-taxonomy-audit-2026-07-11.md)** — **Phase 1: backend + shared** (affirmative findings + structural-absence pass + convergence pass).
- **[full-taxonomy-audit-2026-07-11-phase2-web-mobile.md](full-taxonomy-audit-2026-07-11-phase2-web-mobile.md)** — **Phase 2: `apps/web` + `apps/mobile`.**

---

## Is it complete? Yes — and here is the proof, not the assertion

"Complete" for this audit means every file and every cross-file flow was assigned to a work unit, every unit × applicable-dimension pair landed on FINDING / EXAMINED-SOUND / NOT-EXAMINED, and the finding hunt ran until a convergence pass came back dry. All four hold:

- **Surface accounted for:** Phase 1 partitioned the whole backend + shared into 26 file-areas + 8 end-to-end money/security flows (1,492 coverage-ledger rows). Phase 2 covered all of `apps/web/app/**` (services, hooks, stores, native bridges, entry/root, 20 admin routes + 67 admin components, client routes + ~158 components, 21 UI primitives, i18n, utils, config, 208 test files) + `apps/mobile/**`. No directory is unmapped.
- **Two independent decompositions** (surface-first + threat-first) were merged to their union, so a flow that no single file "owns" (deposit→redeem, order-purchase, payout, interest-mint, vault, admin-money-write, auth-session, refund) still got audited as a unit.
- **Negative-space pass** run on both layers — finds _missing_ controls, not just wrong code (the NS-01..16 backend absences; the frontend structural-absence pass).
- **Convergence reached:** the deferred wave-2 depth was completed as a 3-cluster convergence pass over the densest areas (money/ledger, auth/admin, concurrency/watcher). **All three returned DRY / near-dry**, ~18 constructed candidates were killed on verification, and the 2 previously-UNVERIFIED findings were resolved. A dry convergence on the highest-risk clusters is the signal that the affirmative passes were exhaustive — not that we stopped early.

**No material NOT-EXAMINED surface remains at the backend/shared layer.** The only honest caveats: (1) Phase-2 SEO/soft-404/reachability items are **source-confirmed, not live-confirmed** — the public domain didn't resolve during the run; a `curl -I` / browser pass would upgrade several from "latent" to "confirmed live." (2) Phase 2 ran as directly-observable finder batches (chosen after the opaque workflow proved un-monitorable in this environment), so its medium/low tail carries finder-level confidence rather than the in-band skeptic-panel verification Phase 1's findings got — I verified the Phase-2 criticals/highs during synthesis. (3) Dimensions **LLM / MDL / TNS** are N/A with written justification in the recipe (no model, no user-on-user surface). MNY is N/A for the frontend (money is 100% backend-enforced).

---

## Combined findings tally

| Layer                              | Critical | High    | Medium  | Low / Info | Notes                              |
| ---------------------------------- | -------- | ------- | ------- | ---------- | ---------------------------------- |
| Phase 1 — backend affirmative      | 1        | 21      | 54      | 54         | 130 unique, skeptic-verified       |
| Phase 1 — structural absences (NS) | 2        | 5       | 8       | 1          | 16, the detection/operability tier |
| Phase 1 — convergence (CONV)       | 0        | 0       | 1       | 4          | DRY verdict; emergent + long-tail  |
| Phase 2 — web + mobile             | 1        | ~13     | ~30     | ~30        | deduped across 8 finders           |
| **Combined**                       | **~4**   | **~39** | **~93** | **~89**    | **~225 findings**                  |

The count is _lower_ than a comparably-sized greenfield app would yield — loop-app is exceptionally hardened (49 ADRs, prior cold audits, a live accepted-risk register, a CI money-invariant gate). That it still produced ~43 critical-or-high findings is the signal; that the money/auth/on-chain _core_ re-confirmed as strong (issuer/alg/IDOR pinning, boot fail-closed, conservation trigger, atomic refresh rotation) is the counter-signal. The yield concentrated in the **tiers that had never been audited**: the detection/observability layer, and the entire frontend surface (ACC, UXP, I18N, web-CI).

## The five cross-cutting themes (where remediation buys the most)

1. **A money breach is computed, then invisible.** The core defends the _point of mutation_ well, but a live ledger/solvency/float breach shows a green `/metrics`, a healthy `/health`, and a self-deleting (24h) audit trail — detection rides one Discord webhook that returns success when unset. (NS-01..06, CONV-WATCH-01/02, the watcher-tier highs.)
2. **Incident response can be locked out of its own controls.** No live kill-switch for the deposit/payout/vault/refund rails (redeploy-only), and a responding admin can be DoS'd out of step-up with no in-product recovery. (NS-04, NS-08, CONV-AUTH-01.)
3. **Uncapped admin value paths.** The ~$1M/day compromised-admin bound doesn't hold on retry/redrive/float-movement. (NS-05.)
4. **The frontend's never-audited dimensions.** A systemic keyboard-focus WCAG failure, an i18n framework that shipped without wiring the high-traffic chrome, SEO defects on the purchase-conversion pages, and the real purchase/admin e2e suites not being required-to-merge. (Phase 2 P2-01, P2-08..13.)
5. **Comment/code drift as a recurring class.** Multiple "this was fixed" comments assert guarantees the code doesn't implement (AGT-08) — a distinct, cheap-to-fix, trust-eroding pattern across both layers.

---

## What happens next (not part of this audit)

This audit is **read-only and findings-only.** Remediation is a **separate loop-app-bound session** — each phase doc carries a wave-ordered remediation plan to execute against the CI money-invariant gate. These three docs are **uncommitted**; review them before committing. Nothing in the repo was modified.

_Methodology: the audit-suite plugin (`~/code/tools`) — cold (never inherits prior verdicts / trusts a comment or test name), adversarial (findings constructed as failures, then independently skeptic-verified), systematic (coverage ledger, two decompositions, loop-until-dry convergence)._
