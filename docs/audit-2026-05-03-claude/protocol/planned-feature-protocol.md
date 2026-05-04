# Planned Feature Protocol

Phase 24 answers a separate question from ordinary correctness review:

What is Loop today, what does the repository say Loop is becoming, and what risk exists in the gap between those two states?

## Sources for Planned Features

Inspect and extract claims from:

- `docs/roadmap.md`
- ADRs, especially future-phase, deferred-control, and known-limitation sections
- `docs/adr/005-known-limitations.md`
- architecture, development, deployment, testing, standards, SLO, alerting, on-call, log policy
- runbooks
- AGENTS files
- package READMEs and root README
- old audit planning/checklist/tracker files as historical docs only
- archived docs
- TODO/FIXME comments and ticket references
- user-facing route copy where it promises capabilities
- CI workflow names and job labels

## Sources for Current Features

Build current reality from:

- backend route registrations, handlers, middleware, OpenAPI, env schema
- web routes, services, hooks, stores, components, and native wrappers
- mobile config, native projects, overlays, and scripts
- shared package exports and generated proto
- DB schema, migrations, constraints, and seed/fixture assumptions
- workers, schedulers, watchers, and startup code
- CI workflows, package scripts, Dockerfiles, Fly config, Playwright configs
- tests and fixtures

## Classification

Use exactly one primary classification:

- `implemented`: code, tests, docs, and operations align.
- `partial`: some code exists but behavior, tests, docs, or ops are incomplete.
- `planned-not-started`: docs plan it but code does not yet implement it.
- `deferred`: docs explicitly defer it and code does not expose it as live behavior.
- `stale`: docs plan or describe a feature that is no longer compatible with code direction.
- `contradictory`: docs and code make incompatible claims.
- `undocumented-current`: code ships behavior that is absent from product, architecture, ops, or test docs.
- `removed`: docs or old artifacts mention something that current code has intentionally removed.

## Risk Classification

Assign risk:

- `none`: no current risk; documentation is clear.
- `documentation`: mismatch can mislead developers, operators, or users.
- `latent`: partial code is unreachable today but could be activated accidentally.
- `active`: partial or undocumented code is reachable today.
- `financial`: gap affects credits, orders, payouts, stablecoins, treasury, reconciliation, tax, or settlement.
- `security`: gap affects auth, admin controls, mobile security, secrets, privacy, or abuse resistance.
- `operational`: gap affects alerts, runbooks, deploys, rollback, incident response, or support.

## Required Matrix Columns

Use [../inventory/planned-feature-matrix.tsv](../inventory/planned-feature-matrix.tsv):

- `id`
- `feature`
- `planned_source`
- `current_code_source`
- `classification`
- `risk_class`
- `current_user_visible`
- `current_operator_visible`
- `tests`
- `docs`
- `findings_refs`
- `notes`

## Closure Gates

Phase 24 cannot close until:

- every roadmap item has a row
- every ADR future/deferred/known-limitation claim has a row or is grouped with a precise range
- every user-visible current feature has a row
- every admin/operator current feature has a row
- every money-moving and auth feature has a row
- every `partial`, `contradictory`, `undocumented-current`, `active`, `financial`, `security`, or `operational` row has a finding, accepted-risk entry, or explicit no-finding rationale
