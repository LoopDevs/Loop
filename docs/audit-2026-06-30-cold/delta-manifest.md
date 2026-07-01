# Delta manifest — `04c3fae0` (06-15 audit baseline) → `56926e74` (this audit's HEAD)

22 commits, 214 files changed, +10,884/-1,615. Every vertical agent below is
briefed to give the files in its scope that appear here extra adversarial
scrutiny: verify the cited CF-finding is actually closed (not partially),
and check the fix itself for new bugs.

## Commits (chronological)

```
e45a55c4 fix(backend): harden pay-ctx idempotency and sep7 memo-type guard (#1438)
f831a1a0 fix(web): auth-gate wallet/payout cards + scope brand page to country (#1441)
20307af7 fix: harden redemption WebView message + cap inject scripts (CF-02) (#1442)
adbb5362 fix(backend): harden admin money-writes (CF-06/07/08) (#1443)
bdc77515 fix(backend): harden CTX 429 + expired-operator-401 (CF-12/CF-13) (#1444)
3df0e386 fix(web): bigint-exact currency rendering across money displays (CF-23) (#1445)
e4c121fd fix(backend): encrypt gift-card redeem codes/PINs at rest (CF-25) (#1446)
b17d0436 perf(web): code-split Sentry + relax catalog fetch cadence (CF-29) (#1439)
5dfce00d fix(web): harden money-path accessibility (CF-35) (#1447)
e35e58be docs: fix incident-runbook env-var bugs + observability doc drift (CF-33/34) (#1448)
009f598a fix(mobile): add Sign in with Apple button + hide native Google (CF-27/36) (#1449)
ddae90a7 fix(backend): native-auth admin grant + procureOne pay-ctx regression guard (CF-28/30) (#1450)
38022fd7 fix(web): admin step-up on payouts + stable idempotency key (CF-09/10) (#1451)
7e0a4250 fix(backend): in-app dsr ui + auth-row purge + csv formula guard (CF-26) (#1452)
e27063d2 fix(infra): lock down catalog operator tooling (CF-03 / T-01,02,03,05,06) (#1453)
3aca01ad fix(backend): order/withdrawal/payout resilience (CF-15/16/20/21) (#1454)
da067648 fix(web): route-locale-aware formatting + one format seam (CF-22) (#1455)
733107f7 perf(backend): add hot-path indexes + TTL cache for public stats (CF-29) (#1456)
fb6c1954 fix(backend): payout-worker row-claim with FOR UPDATE SKIP LOCKED (CF-14) (#1457)
162c4d06 fix(backend): authoritative tx-hash payout idempotency (CF-18) (#1458)
5296ceef fix(backend): wire extended-market order path (CF-19, ADR 035) (#1459)
56926e74 fix(backend): exempt numeric literals from CSV formula-injection guard (#1460)
```

## CF status entering this audit (re-verify, don't trust)

Claimed-closed by the commits above: CF-02, 03, 06, 07, 08, 09, 10, 12, 13,
14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 33, 34,
35, 36.

Still open (gated/branch-only, not expected to be closed by this delta):
CF-01 (burn), CF-05 (interest mint), CF-17 (drift equation), CF-32 (Privy
wallet branch blockers).

## Changed files by area (full list: `git diff --stat 04c3fae0..HEAD`)

**Backend (95 files)** — auth (admin-step-up-middleware, admin-step-up,
auth-row-purge [new], identities, otps, refresh-tokens), circuit-breaker,
credits (interest-scheduler, pending-payouts[-transitions], refunds),
csv/ [new module: csv-escape relocated], ctx/operator-pool, db (schema,
users, migrations 0035-0037), discord (admin-audit, monitoring [new],
notifiers-catalog), env.ts, index.ts, openapi (admin-credit-writes,
admin-payouts-cluster-writes, admin, orders-loop), orders (fulfillment,
get-handler, handler, loop-handler, loop-read-handlers, pay-ctx,
procure-one, redeem-crypto [new], redemption-backfill, sep7), payments
(horizon-find-outbound, horizon, payout-submit, payout-worker-pay-one,
payout-worker, price-feed-fx, price-feed), public/cashback-stats, routes
(admin-credit-writes, admin-payouts, admin-user-writes, admin),
runtime-health, scripts/quarterly-tax, users/cashback-history-handler.
Plus 30+ new/expanded test files.

**Web (86 files)** — components/features (onboarding/screen-currency,
order/OrderPayoutCard, orders/LoopOrdersList+OrdersSummaryHeader,
purchase/\* [AmountSelection, EarnedCashbackCard, LoopPaymentStep,
PaymentStep, PurchaseContainer, RedeemFlow], wallet/StellarTrustlineStatus),
hooks (use-focus-trap [new], use-merchants, use-radio-group-keys [new]),
i18n (format, locale, messages, t — the CF-22 wiring), root.tsx, routes.ts,
routes (admin.payouts.$id, admin.payouts, auth, brand.$slug,
gift-card.$name, home, map, orders.$id, orders, settings.privacy [new],
settings.wallet), services (admin-cashback-config, admin-merchants-resync,
admin-payouts, admin-user-credits, admin-user-home-currency, admin, user
[new]), utils (locale, money [deleted — see money-format consolidation],
redeem-message [new], security-headers, sentry-lazy [new]).

**Shared (5 files)** — api.ts, loop-asset.ts (new), money-format.ts(+test).

**Mobile (0 files)** — the Apple Sign-In change (CF-27) landed entirely in
`apps/web` (web script, not a Capacitor plugin) — confirm `apps/mobile/`
genuinely needed zero changes, not an oversight.

**Docs (23 files)** — ADRs 010/014/016/027/028/034/035, alerting,
architecture, deployment, development, error-codes, log-policy, roadmap,
runbooks (README + 4 new: deposit-skip-recorded, dsr, interest-pool-low,
peg-break-on-fulfillment; + redemption-backfill-exhausted, stuck-payout,
usdc-below-floor updated).

**Tooling (3 files, shown separately — not in the stat-tail above)** —
`tools/ctx-catalog/{demo-seed,domain-review-server,review-server}.mjs`.

**Scripts (1 file)** — `scripts/lint-docs.sh`.
