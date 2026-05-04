# Operational Journeys

## OJ-001: Backend Boot

- Trigger: backend process starts.
- Path: env validation, logger, Sentry, migrations, app creation, worker gating, health routes, startup tasks.
- Required checks: production-required env vars, boot failure messages, migrations, worker defaults, secrets, logs.

## OJ-002: Web Deploy

- Trigger: web build/deploy.
- Path: package scripts, Vite, React Router build, Dockerfile, Fly config, static assets, SSR headers.
- Required checks: env vars, cache, build output, bundle budget, admin bundle split, health, rollback.

## OJ-003: Mobile Sync and Release

- Trigger: mobile sync/build.
- Path: web static export, Capacitor sync wrapper, native overlays, native projects, package parity, app store docs.
- Required checks: overlay persistence, permissions, backup rules, Face ID usage string, assets, signing docs.

## OJ-004: Upstream CTX Degradation

- Trigger: CTX auth, merchant, location, or gift card endpoint fails.
- Path: circuit breaker, health probe, public fallback, worker backoff, Discord, runbook.
- Required checks: independent breaker keys, timeouts, 502 vs 503, stale data, recovery probe, docs.

## OJ-005: Stellar or Horizon Degradation

- Trigger: Horizon read or Stellar submit failure.
- Path: payment watcher, payout worker, balance cache, asset drift watcher, alerts, runbooks.
- Required checks: retry, stale cache, permanent vs transient classification, operator action, no duplicate payout.

## OJ-006: Incident Response and Rollback

- Trigger: failed deploy, health degraded, ledger drift, stuck payout, asset drift, secret rotation.
- Path: alert, on-call, runbook, rollback command, verification, comms, postmortem.
- Required checks: exact commands, owners, severity, customer comms, log retention, recovery proof.
