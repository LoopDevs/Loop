# Adversarial Journeys

## ADV-001: Anonymous Resource Exhaustion

- Attack: hammer public APIs, image proxy, cluster endpoint, auth OTP, merchants, sitemap.
- Checks: rate limits, body limits, cache, timeouts, error envelopes, logging, CDN/cache assumptions, no expensive DB path without limit.

## ADV-002: Auth and Session Abuse

- Attack: OTP brute force, email enumeration, token replay, refresh token reuse, forged client ID, expired JWT, previous signing key abuse, logout bypass.
- Checks: rate limits, replay guard, validation, storage cleanup, issuer/audience, tests.

## ADV-003: Cross-User Data Access

- Attack: enumerate order IDs, user IDs, payout IDs, merchant/admin IDs, CSV exports, public slugs.
- Checks: authz, route params, admin-only middleware, DB filters, error messages, tests.

## ADV-004: Admin Abuse or Mistake

- Attack: replay admin writes, omit reason, spoof actor, exceed cap concurrently, retry payout twice, export sensitive data, change cashback config silently.
- Checks: idempotency, actor binding, step-up expectations, audit logs, DB constraints, rate limits, review docs.

## ADV-005: Payment and Payout Fraud

- Attack: wrong memo, wrong asset, wrong amount, duplicate payment observation, forged Stellar address, trustline missing, duplicate payout retry, stale balance.
- Checks: Horizon matching, address regex, asset mapping, memo idempotency, transaction transitions, reconciliation.

## ADV-006: SSRF, XSS, and Content Injection

- Attack: malicious image URL, SVG script, redirect chain, crafted merchant data, barcode/redemption fields, admin CSV injection, markdown/doc rendering assumptions.
- Checks: image proxy allowlist, content-type rules, escaping, CSV sanitization, React rendering, CSP/security headers.

## ADV-007: Supply Chain and CI Compromise

- Attack: malicious npm package, workflow PR from fork, overbroad token permissions, live npm install in secret-bearing job, artifact poisoning, cache poisoning.
- Checks: lockfile installs, action permissions, pinned CLIs, scanners, branch gates, protected environments.

## ADV-008: Mobile Device Compromise and Lifecycle Abuse

- Attack: backup exfiltration, app switcher screenshot, clipboard leakage, biometric unavailable, rooted device assumptions, stale refresh token, offline replay.
- Checks: secure storage, overlays, app lock, task switcher, clipboard/share wrappers, native permissions, docs for deferred controls.
