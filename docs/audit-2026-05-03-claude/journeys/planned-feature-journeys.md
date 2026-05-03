# Planned Feature Journeys

These journeys compare what the product appears to be planning against what the current code actually supports.

## PFJ-001: Current User Feature Set

- Build from web routes, backend public/auth/order/user routes, mobile wrappers, shared contracts, and e2e tests.
- Output: implemented user-facing capabilities, partial capabilities, hidden capabilities, and user-facing copy that overstates or understates current support.

## PFJ-002: Current Admin and Operator Feature Set

- Build from admin backend routes, admin web routes/services/components, OpenAPI, audit logs, runbooks, and CI/operator docs.
- Output: implemented operator capabilities, partial controls, planned controls, and sensitive current behavior missing from docs.

## PFJ-003: Planned Money and Stablecoin Feature Set

- Build from ADR 009, ADR 010, ADR 015, ADR 016, ADR 017, ADR 024, roadmap, docs, DB schema, credits, payments, payouts, and workers.
- Output: current vs planned state of credits ledger, cashback, LOOP assets, USDC/XLM rails, payouts, withdrawals, refunds, reconciliation, and settlement.

## PFJ-004: Planned Identity Feature Set

- Build from ADR 013, ADR 014, ADR 028, auth code, user identities, social login, admin auth, client IDs, docs, and tests.
- Output: current vs planned state of native auth, legacy proxy auth, social login, admin step-up, token rotation, and account linking.

## PFJ-005: Planned Mobile Security Feature Set

- Build from ADR 006, ADR 007, ADR 008, ADR 027, mobile native files, native wrappers, overlays, package deps, and app store docs.
- Output: current vs planned state of secure storage, generated native projects, share filesystem, SSL pinning, App Attest, Play Integrity, jailbreak/root detection, binary tamper, backup rules, biometrics, and app lock.

## PFJ-006: Planned Operations and Release Feature Set

- Build from ADR 029, CI workflows, deploy docs, runbooks, SLO, alerting, on-call, log policy, branch protection claims, and scripts.
- Output: current vs planned state of CI gates, scanners, SBOM/provenance, deployment, rollback, incident response, alerting, and repo policy.
