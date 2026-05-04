# Admin and Operator Handoff

This file tracks external settings, credentials, operational actions, and manual confirmations that code review alone cannot prove.

## Pending External Verifications

| ID    | Area                            | Verification Needed                                                                                                                               | Owner   | Evidence | Status  |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ------- |
| H-001 | GitHub branch protection        | Capture current `main` branch protection, required checks, code-owner review, conversation resolution, stale review dismissal, admin enforcement. | pending | pending  | pending |
| H-002 | GitHub secrets and environments | Verify production/staging secrets, environment protections, deploy approvals, and fork PR restrictions without exposing secret values.            | pending | pending  | pending |
| H-003 | Fly.io backend/web config       | Verify live app env vars, scaling, health checks, deploy history, rollback path, and secret presence without exposing values.                     | pending | pending  | pending |
| H-004 | Stellar accounts                | Verify operator issuer/distributor accounts, balances, trustlines, rotation plan, and Horizon network target without exposing secrets.            | pending | pending  | pending |
| H-005 | CTX supplier account            | Verify production CTX credentials, client IDs, rate limits, contract assumptions, and upstream support path without exposing secrets.             | pending | pending  | pending |
| H-006 | Discord webhooks                | Verify webhook targets, channels, alert routing, and owner response expectations without exposing URLs.                                           | pending | pending  | pending |
| H-007 | Mobile release accounts         | Verify Apple/Google signing, certificates, app IDs, privacy declarations, and release procedure.                                                  | pending | pending  | pending |
