# Phase 13 - Workers, Schedulers, and Background Jobs

Status: in-progress

Required evidence:

- startup task inventory: in progress
- worker enablement and cadence review: in progress
- duplicate-run/idempotency review: in progress
- backoff, timeout, shutdown, alert review: finding filed for first-tick health false negative
- runbook interaction review: in progress

Artifacts:

- [runtime-health-first-tick-hang.txt](./artifacts/runtime-health-first-tick-hang.txt)

Observations:

- Worker startup is centralized in `apps/backend/src/index.ts` behind `LOOP_WORKERS_ENABLED`, with blocked/disabled state recorded for missing payment watcher/payout worker config.
- Payment watcher, procurement worker, payout worker, asset drift watcher, and interest scheduler all mark themselves started before their first async tick records success or failure.
- Runtime health staleness currently uses `lastSuccessAtMs` only, so a worker with no first success and no first failure is not stale.

Findings:

- A4-025: Worker health can stay green forever when the first tick hangs before success or failure.
