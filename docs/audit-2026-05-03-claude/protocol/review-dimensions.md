# Review Dimensions Protocol

Every phase must record which review dimensions apply and what evidence supports them.

## Logic Correctness

Review:

- input validation and output shape
- state transitions and impossible states
- concurrency and idempotency
- retry, timeout, crash, and partial-failure behavior
- invariant preservation
- edge cases, empty states, maximum sizes, stale data, and clock behavior

## Code Quality

Review:

- type safety and absence of unsafe escapes
- local pattern consistency
- naming and readability
- module cohesion and dependency direction
- duplication and abstraction quality
- dead code, unused exports, stale fixtures, and unreachable branches
- generated-code boundaries and source-of-truth clarity
- performance characteristics appropriate to the path

## Documentation Accuracy

Review whether existing docs are true:

- architecture and ADR claims
- AGENTS and package guide rules
- OpenAPI and error-code docs
- runbook commands and owner expectations
- env var tables and defaults
- testing, deployment, CI, and release docs
- comments that encode policy or security assumptions

## Documentation Coverage

Review whether important behavior is documented somewhere appropriate:

- endpoints and response shapes
- env vars and feature flags
- money-moving flows
- admin writes and operator procedures
- worker failure modes and alerts
- release and rollback paths
- mobile/native constraints
- planned, partial, deferred, and removed features

## Test Coverage

Review whether the right test type exists:

- pure unit tests for deterministic helpers
- integration tests for handlers, DB behavior, and transactions
- property or table tests for money/math/state-machine edges
- mocked e2e for deterministic product flows
- real-upstream or contract tests for external integration assumptions
- flywheel/real DB tests for lifecycle flows
- CI checks for docs, formatting, lint, typecheck, build, scanners, and budgets

## Test Accuracy

Review whether tests would catch real regressions:

- mocks match production contracts
- fixtures are schema-valid and current
- assertions check externally observable behavior
- negative cases are meaningful
- async behavior is awaited correctly
- tests are not overfit to implementation details
- skipped/flaky tests are justified and tracked
- CI runs the same tests the docs and branch policy claim

## Planned-Feature Fit

Review:

- roadmap vs code
- future ADRs vs reachable current behavior
- deferred control trigger conditions
- partial implementations behind flags
- hidden current features without docs or tests
- user-facing copy that overpromises planned behavior
