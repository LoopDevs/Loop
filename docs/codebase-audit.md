# Comprehensive Codebase Audit Program

This document is the audit hub for Loop. It replaces the previous `docs/codebase-audit.md`, which mixed a partial checklist with a false "complete" conclusion and is not sufficient for a full-project audit.

## Goal

The standard is not "we glanced at the code and found a few issues." The standard is:

- every meaningful surface of the repo is explicitly audited
- every audit stream has evidence, not just opinions
- all critical and high-severity findings are resolved before sign-off
- medium findings are either resolved or accepted with an owner, rationale, and date
- residual risk is explicit, not hidden
- docs, tests, and operational guidance are reconciled with reality

Absolute perfection cannot be proven. For this project, "audit complete" means there are no unreviewed material surfaces left and no unowned meaningful risks.

## Depth Standard

This audit is intentionally both wide and deep.

- Wide means every material surface is reviewed: product flows, architecture, code, tests, native shell, CI/CD, docs, automation, deployment, operational readiness, and backlog assumptions.
- Deep means each important surface is reviewed from multiple levels:
  - system level: architecture, responsibilities, boundaries, failure modes, lifecycle
  - implementation level: concrete files, functions, branches, state transitions, schemas, and configs
  - behavioural level: user journeys, degraded states, recovery paths, and abuse paths

The audit should not optimize for speed. It should optimize for confidence.

## Audit Principles

- Audit the system, not just the code.
- Prefer evidence over assumptions.
- Verify architecture rules against implementation.
- Follow the highest-risk flows end to end.
- Treat mobile, CI/CD, docs, and operational readiness as first-class audit targets.
- Separate findings from fixes. The audit should stay useful even before remediation starts.

## Audit Method

The audit runs in ordered passes. Each pass must leave behind evidence in the tracker.

1. Baseline and inventory
   Capture commit SHA, package inventory, commands, env assumptions, workflow files, deploy surfaces, and third-party integrations.
2. High-level system review
   Reconcile implementation against `AGENTS.md`, ADRs, architecture docs, package boundaries, and critical rules.
3. Low-level implementation review
   Read code, tests, configs, scripts, and docs for each workstream listed below.
4. End-to-end behaviour review
   Trace critical user and operator flows from entry to completion, including retries, interruption, and recovery.
5. Runtime and build verification
   Run typecheck, lint, unit tests, build, and targeted exploratory checks. Record failures, flakiness, slow paths, and hidden prerequisites.
6. Adversarial review
   Threat-model auth, tokens, upstream proxying, image proxying, native storage, payment flows, error states, abuse cases, and operational failure modes.
7. Cross-source reconciliation
   Compare code, tests, docs, CI, deployment config, and package metadata for drift.
8. Reverse-direction review
   Re-check the system from the opposite direction: from docs to code, from tests to implementation, from workflows to expected protections, and from roadmap claims to shipped reality.
9. Findings triage
   Classify severity, blast radius, exploitability, reproducibility, and fix confidence.
10. Remediation planning
    Group findings into change batches, regression checks, and docs updates.
11. Final sign-off
    Confirm nothing material remains unaudited and that residual risks are explicit.

## Review Lenses

Each workstream should be reviewed through several lenses, not just one:

- architectural: does the shape of the system make sense?
- correctness: does it do the right thing?
- resilience: does it behave safely under failure?
- security and abuse: can it be broken or exploited?
- maintainability: is it understandable and durable?
- operability: can it be deployed, monitored, debugged, and recovered?
- product quality: does it feel complete and intentional to the user?

No important area should be signed off after a single-lens review.

## Audit Workstreams

Every audit run must cover all of these workstreams:

1. Repository hygiene and governance
2. Architecture and boundary compliance
3. Backend correctness and resilience
4. Web correctness and UX integrity
5. Mobile shell and native integration
6. Shared types, contracts, and serialization
7. Auth, session, identity, and token handling
8. Orders, payment, redemption, and business-flow correctness
9. Security, privacy, abuse, and trust boundaries
10. Performance, caching, bundle/runtime efficiency
11. Accessibility, responsiveness, and degraded-network behaviour
12. Tests, test quality, and regression confidence
13. CI/CD, release safety, and deployment correctness
14. Observability, alerting, and incident readiness
15. Dependencies, supply chain, licenses, and update posture
16. Documentation accuracy and operational usability
17. Backlog, roadmap, and delivery-risk alignment

Detailed checklists live in [docs/audit-checklist.md](docs/audit-checklist.md). Execution state lives in [docs/audit-tracker.md](docs/audit-tracker.md).

## Evidence Standard

No workstream is complete without concrete evidence. Acceptable evidence includes:

- code references
- config or workflow references
- test references
- command results
- runtime screenshots or logs when relevant
- documented contradictions between code and docs
- explicitly stated assumptions when an area cannot be fully verified

Every finding must point to its evidence. Every "no issue found" conclusion should still cite what was checked.
Every workstream should ideally include both high-level evidence and low-level evidence.

## Severity Model

- `CRITICAL`: exploitable security issue, irreversible fund loss, auth bypass, data leak, or release blocker
- `HIGH`: serious correctness or safety issue with meaningful user or business impact
- `MEDIUM`: real defect, drift, or maintainability issue that can plausibly cause breakage
- `LOW`: minor defect, inconsistency, or weakness with limited blast radius
- `NIT`: polish, clarity, or minor hygiene issue

Severity is based on impact and likelihood together. "Important architecture violation with no current symptom" can still be `HIGH`.

## Exit Criteria

The audit is not done until all of the following are true:

- every workstream in the tracker is marked `complete` or `blocked`
- every blocked item explains exactly what evidence is missing and why
- all critical and high findings have an approved remediation path
- all commands required for confidence have been run, or the reason they could not be run is documented
- docs that materially misdescribe the system are logged as findings
- the audit has a final gap-review pass with no new material categories added
- each major workstream has been reviewed at both system level and implementation level
- critical user journeys and critical operator journeys have been traced end to end

## Plan Review History

The plan was expanded through multiple gap-review passes before execution:

### Pass 1

Started from the obvious repo surfaces: backend, web, shared, config, tests, docs, security, and performance.

### Gap Review 1

Added major missing areas:

- mobile shell and native runtime risk
- CI/CD, release controls, and deploy safety
- observability, alerting, and incident response
- dependency supply chain and license posture
- privacy, abuse, and trust-boundary review
- roadmap and backlog alignment with current code reality

### Gap Review 2

Added methodology gaps:

- evidence requirements for "no issue found"
- cross-source reconciliation between docs, tests, code, and workflows
- runtime verification, not just static reading
- explicit exit criteria and severity model
- separation of tracker vs. checklist vs. findings

### Gap Review 3

Added end-to-end product-risk streams that are easy to miss in file-by-file audits:

- auth/session restoration under failure
- order creation, payment, polling, redemption, and recovery paths
- degraded network, offline, and retry behaviours
- native storage, WebView, browser bridge, and app-shell assumptions
- release-time correctness for branch protections, workflows, and PR-only checks

After the third review pass, no additional material audit categories remained unaccounted for.
