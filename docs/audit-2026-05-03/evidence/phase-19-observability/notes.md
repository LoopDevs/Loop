# Phase 19 - Observability and Operations

Status: in-progress

Required evidence:

- logs, metrics, health, runtime health review: started; `/health`, `/metrics`, runtime-health, Docker healthcheck, and Fly check reviewed
- Sentry and Discord review: started; Sentry source-map upload and Discord notifier/runbook surfaces identified for continued pass
- SLO/alert/on-call review: started; `docs/slo.md`, `docs/alerting.md`, and `docs/oncall.md` reviewed against health/alert code
- runbook command and owner verification: started; runbook inventory captured, with command truth pass still continuing
- incident recovery and rollback review: pending

Evidence captured:

- [health-orchestrator-db-gaps.txt](./artifacts/health-orchestrator-db-gaps.txt)

Findings:

- A4-032: `/health` does not probe Postgres connectivity.
- A4-033: Docker and Fly health checks treat degraded `/health` responses as healthy HTTP 200.
