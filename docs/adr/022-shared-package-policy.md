# ADR 022 — `@loop/shared` package policy

**Status:** Accepted
**Date:** 2026-04-22
**Depends on:** ADR 009 (credit ledger), ADR 011 (admin cashback config), ADR 013 (Loop auth + CTX supplier), ADR 014 (social login), ADR 015 (stablecoin topology)

## Context

The `packages/shared/` workspace already carries obviously-shared code: `ApiError`, `Merchant`, `Order`, protobuf types. Over 2026-04-22 the surface grew fast as the cashback pivot landed — `HOME_CURRENCIES`, `ORDER_STATES`, `PAYOUT_STATES`, `CREDIT_TRANSACTION_TYPES`, `LOOP_ASSET_CODES`, `SOCIAL_PROVIDERS`, `STELLAR_PUBKEY_REGEX`, `splitCashbackFaceValue`, and several public-endpoint response shapes all moved from `apps/backend/src/db/schema.ts` (or inline web declarations) into shared modules.

Each extraction had the same trigger: an enum / regex / pure function that existed as a literal string union, inline const, or duplicated regex in ≥2 places — once in `apps/backend` and one or more times in `apps/web`. The drift risk is "added a new currency to the backend, forgot to update the web currency picker". With the cashback pivot introducing half a dozen new enums touching both sides, the cost of drift exceeded the cost of the refactor.

Now that seven modules have been added this way, the rule is implicit but not written down. This ADR captures it.

## Decision

### The anti-drift test

A symbol belongs in `@loop/shared` if **all three** are true:

1. **It represents a value that crosses the web ↔ backend boundary** — a DB CHECK literal shipped in a zod enum and also used to render a UI filter chip, a format the user types on web and the backend validates, a response field shape the client destructures.
2. **It is pure TypeScript / regex / arithmetic** — no Node APIs (`fs`, `crypto` where possible, `process.env`), no React APIs, no runtime dependencies beyond what shared already has (`@bufbuild/protobuf`).
3. **Drift would be a bug** — silently adding a value on one side and forgetting the other produces wrong behaviour, not a type error at a boundary we own.

All three must hold. Missing any one:

- fails rule 1 → backend-only or web-only (stays where it is);
- fails rule 2 → can't move (Node / React APIs don't run in both environments);
- fails rule 3 → shared would add ceremony for no correctness benefit.

### Module shape conventions

Each shared module is one file per concept — `currencies.ts`, `states.ts`, `loop-assets.ts`. When possible, export:

1. A **frozen const tuple** (`['USD', 'GBP', 'EUR'] as const`) — the authoritative list.
2. A **type** derived from the tuple (`(typeof FOO)[number]`) — for compile-time narrowing.
3. A **narrowing helper** (`isFoo(value: string): value is Foo`) — for runtime narrowing where callers have unwired strings (web fetch responses, user input).

This triad is what every shared-enum extraction this session has looked like. Future additions should follow unless there's a specific reason not to.

### Backend re-export rule

When moving a symbol out of `apps/backend/src/db/schema.ts` (the main co-existing location), the schema file keeps a re-export:

```ts
// Re-exported from @loop/shared; list lives there for web parity.
export { HOME_CURRENCIES, type HomeCurrency } from '@loop/shared';
```

Rationale: backend consumers already import from `./schema.js`, and rewriting every import path in the same PR would inflate the diff without additional safety. The re-export is a one-line forwarding; path migration happens opportunistically when a file is touched for other reasons. The **list itself** must be `@loop/shared`; the **import path** can be either.

### Consumer adoption policy

Consumer refactors (web routes switching from inline unions to the shared import) are **explicitly out of scope** for the extraction PR. A PR that both adds the shared export and rewrites three web routes gets harder to review + revert for no correctness gain.

The pattern is:

1. **PR N**: add the shared export, keep the backend re-export, leave consumers as-is. 753 tests pass unchanged.
2. **PR N+1…**: each consumer migrates to the shared import when it's touched for another reason (a feature change, a test expansion). Zero "tidy-up" PRs that only do migrations unless reviewers specifically ask for one.

This is the phased approach used across `#452` (Stellar regex), `#453` (home currencies), `#454` (loop assets), `#455` (state enums), `#456` (credit-transaction types), `#459` (social providers). In each case, web still has its inline declaration on `main` — those migrate later.

## Consequences

### Positive

- **One rule to cite** at review. "This regex is used in both apps — Rule 1/2/3? Yes to all three, it belongs in shared."
- **Small diffs.** The extraction PR is `+40 / -10` not `+200 / -150`. Behaviour-preserving by construction.
- **Web onboarding currency picker can't drift from the backend** CHECK — it reads from the same const.
- **Test stability.** Backend's existing 753 unit tests pass on every shared extraction without modification.

### Negative / open issues

- **Two import paths for the same symbol.** `HOME_CURRENCIES` is importable from `@loop/shared` _and_ from `apps/backend/src/db/schema.js` during the transition window. Grep results double up; IDE auto-import sometimes picks the less-preferred path. Documenting the "prefer `@loop/shared`" direction in the per-package `AGENTS.md` is the plan but not yet landed.
- **Sweep-style PR stacking.** The session that introduced this ADR opened seven shared-extraction PRs in succession. They're small and independent, but the queue is visually noisy. Future sessions should consider batching by topic area (all "states", all "currencies") if they expect multiple extractions in one go.
- **The test-infra gap** — `packages/shared/` has no vitest setup of its own yet, so pure-function tests run from `apps/backend` (the one known caller) rather than inline. Adding a minimal test setup would let `cashback.ts` math and future helpers self-test. Deferred.

## Non-goals

- **Not a migration plan** for the existing duplicate declarations on web. Consumers migrate when touched.
- **Not a universal "move it to shared" rule.** Symbols that fail any of rules 1–3 stay where they are; shared isn't a dumping ground.
- **Not a dependency-management policy.** The "no runtime deps except `@bufbuild/protobuf`" rule in `packages/shared/AGENTS.md` continues to apply; this ADR is about contents, not dependencies.
- **Not a module-organisation overhaul.** One file per concept is the convention, but there's no "thou shalt not nest" rule if a concept genuinely has sub-files (proto types are the existing precedent).

## Rollout

- Descriptive. The seven shared-extraction PRs on-stack already follow the three-part test and the module shape conventions.
- Reviewers should cite this ADR when:
  - A new symbol looks like it should be in `@loop/shared` but isn't (point at rules 1–3).
  - A shared-extraction PR also tries to migrate consumers in the same diff (point at the phased policy).
  - A follow-up "tidy-up" PR appears that only migrates consumers without a real reason to touch those files (decline — wait for a feature PR to fold the migration in).
