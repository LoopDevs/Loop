# Phase 13 - Workers, Schedulers, Background Jobs

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/index.ts (orchestration)
- apps/backend/src/cleanup.ts
- apps/backend/src/clustering/data-store.ts (location refresh)
- apps/backend/src/merchants/sync.ts (merchant refresh)
- apps/backend/src/payments/{watcher-bootstrap,payout-worker,asset-drift-watcher,stuck-payout-watchdog,cursor-watchdog}.ts
- apps/backend/src/orders/{procurement,transitions-sweeps}.ts
- apps/backend/src/credits/interest-scheduler.ts

## Findings filed

- A4-006 Low — cleanup interval timer not `unref`ed
- A4-016 Low — sweepExpiredRateLimits runs hourly; long-tail accumulation between sweeps

## No-finding-but-reviewed

- All worker timers gated on `LOOP_WORKERS_ENABLED`.
- Each worker calls `markWorkerStarted/Stopped/TickSuccess/TickFailure` for runtime-health introspection.
- Stuck watchdogs for procurement and payouts present.
- Graceful shutdown calls every stop function.
