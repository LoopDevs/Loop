# ADR 019: `@loop/shared` package policy

Status: Accepted
Date: 2026-04-22
Related: ADR 009 (credits ledger), ADR 011 (admin panel), ADR 015 (stablecoin topology), ADR 017 (admin credit primitives)

## Context

`@loop/shared` started as a place for the protobuf types the web and
backend both parse, the `Merchant` DTO, and a handful of slug helpers.
It has since absorbed a growing list of symbols that previously lived
twice — once on the backend (usually next to the Drizzle schema or a
zod boundary) and once in the web's `services/*` layer:

- `HOME_CURRENCIES` + `HomeCurrency` (ADR 015 — `users.home_currency`
  check constraint mirrored in the UI's currency picker).
- `LOOP_ASSET_CODES` + `LoopAssetCode` + `CURRENCY_TO_ASSET_CODE` +
  `loopAssetForCurrency` (ADR 015 — payout asset mapping; the admin
  UI filters on codes the backend validates).
- `STELLAR_PUBKEY_REGEX` (ADR 015 / 016 — the format
  `/settings/wallet` validates before submit and the backend
  re-validates at the `setStellarAddress` handler). The earlier
  `isStellarPublicKey(s): s is string` helper was dropped under
  A2-820 / A2-821 — zero consumers and a no-op type predicate; every
  call site uses `STELLAR_PUBKEY_REGEX.test(s)` directly.

Each extraction followed the same shape. Without a written rule the
pattern lives only in the diffs, and reviewers on the next extraction
have to re-derive whether the thing in front of them is a candidate.
This ADR pins the test so reviewers can cite it and new contributors
know when to reach for `packages/shared/` vs keep a symbol local.

## Decision

### The three-part test

A symbol belongs in `@loop/shared` when **all three** hold:

1. **Crosses the web ↔ backend boundary.** Evidence looks like: a DB
   `CHECK` literal that is also rendered as a filter chip in the admin
   UI; a format the user types on the web that the backend validates
   server-side; a union that shows up in zod on one side and in a
   `switch` on the other.
2. **Pure TypeScript / regex / arithmetic.** No Node APIs (`fs`,
   `process.env`, etc.), no React APIs, no new runtime dependencies.
   `packages/shared/` is intentionally a thin, tree-shakeable module
   that either build can include without pulling in the other's
   toolchain.
3. **Drift would be a bug, not a type error.** If silently adding a
   value on one side and forgetting the other would produce wrong
   behaviour that compiles cleanly, the symbol belongs in shared.
   Narrowing helpers (`isHomeCurrency`) and const tuples
   (`['USD', 'GBP', 'EUR'] as const`) pin the union at one site so the
   compiler catches divergence on the next edit.

Missing any one: stays where it is. Backend-only SQL literals
(`pg_type`, index names) never belong in shared. UI-only copy (button
labels, empty-state strings) never belongs in shared.

### Module conventions

Every shared enum introduced under this policy follows the same triad:

- A frozen const tuple: `export const FOO = ['a', 'b', 'c'] as const;`
- A type derived from the tuple: `export type Foo = (typeof FOO)[number];`
- A narrowing helper:
  `export function isFoo(s: string): s is Foo { return (FOO as readonly string[]).includes(s); }`

The helper takes `string` (not `string | null | undefined`). Callers
null-check at their own boundary; the helper's single responsibility
is the union check. This matches the signature zod emits and keeps
the cast surface small.

### Backend re-export rule

Extraction PRs keep the **list** in `@loop/shared` but leave a
re-export at the symbol's original backend home for one transition:

```ts
// apps/backend/src/db/schema.ts
export { HOME_CURRENCIES, type HomeCurrency } from '@loop/shared';
```

Rationale: the Drizzle schema file is where `pgTable` + `check(...)`
literals live, and a mechanical search for `HOME_CURRENCIES` most
naturally lands there. Preserving the import path means the extraction
PR is import-graph-neutral — no consumer has to change, diffs stay
small, and the reviewer can focus on the extraction itself.

### Consumer adoption is phased

An extraction PR adds the shared export and the backend re-export.
It does **not** rewrite web consumers to import from `@loop/shared`
directly. Consumers migrate when they're touched for another reason
(a feature slice, a refactor, a new test). "Tidy-up-imports" PRs
whose only purpose is to change `from './x'` to `from '@loop/shared'`
are discouraged — they contribute churn without enforcement.

### Test placement

Shared-module tests live at the consumers, not in `packages/shared/`.
`HOME_CURRENCIES` is exercised every time the admin home-currency
switch is tested on the backend and every time the currency picker
mounts on the web. A dedicated `packages/shared/src/__tests__/` adds
a third test-runner (vitest-in-shared) without enforcing anything a
consumer's test didn't already. If a shared symbol gains non-trivial
branching (`loopAssetForCurrency` would if it grew beyond a 1:1 map),
the test moves with the logic at that point.

## Consequences

**Positive.**

- One source of truth for every cross-boundary literal — drift
  becomes a compile error, not a runtime mismatch between a CHECK
  constraint and a UI chip.
- Narrowing helpers make "is this value from user input actually in
  the union?" a one-liner at the zod boundary on both sides.
- Re-export rule keeps extractions import-graph-neutral so a single
  PR can do one thing cleanly.

**Negative.**

- Two valid import paths during the transition (`@loop/shared` vs
  the backend re-export). The next contributor needs to read this
  ADR or the file header to know the re-export is transitional.
- Adding a currency / asset / payout state touches three files
  (the shared tuple, the Drizzle CHECK literal, the UI filter list).
  A checklist comment in `packages/shared/src/*.ts` cross-links the
  sites so future edits don't skip one.
- `packages/shared/` cannot host test utilities that depend on Node
  (`pg`, `drizzle-orm`, `hono/testing`). Those stay inline in each
  backend test file (or `apps/backend/src/__tests__/vitest-env-setup.ts`
  for the shared setup hook). No dedicated `__tests__/helpers/`
  directory has been needed — tests use `vi.hoisted` mocks per file.

## Open issues

- **Shared-package release cadence.** Currently bumped in lockstep
  with the consumers via npm workspaces. If a future non-monorepo
  consumer lands (a CLI, a separate landing-page repo) we'll need
  a real version on `packages/shared/package.json` and a publish
  step. Out of scope for Phase 1.
- **Sweep-style PRs.** Several of this session's extractions landed
  as same-shape PRs in succession (`stellar.ts`, `loop-asset.ts`).
  The phased-adoption rule above keeps each one small, but a reviewer
  benefits from seeing the sweep as a set. Convention: when stacking
  > 2 shared-extraction PRs in a day, link them in each PR body so
  > the review context is shared.

## Related

- ADR 015 — stablecoin topology and payment rails — introduced the
  first cross-boundary constants (currency ↔ asset mapping).
- ADR 017 — admin credit primitives — introduced the zod-shared
  invariants for admin-write endpoints.
- ADR 018 — admin panel architecture — the consumer-side pattern
  that drove most of the shared extractions in the last two weeks.
