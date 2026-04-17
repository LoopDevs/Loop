# Loop Engineering Standards

This document is the authoritative reference for how we write, test, review, and ship code at Loop. Every rule here is enforced — either by tooling or by code review. "We'll fix it later" is how technical debt starts. These standards exist to prevent that.

---

## Table of contents

1. [Principles](#1-principles)
2. [Repository structure](#2-repository-structure)
3. [TypeScript rules](#3-typescript-rules)
4. [Code style](#4-code-style)
5. [Linting and formatting](#5-linting-and-formatting)
6. [Commit discipline](#6-commit-discipline)
7. [Branching strategy](#7-branching-strategy)
8. [Testing](#8-testing)
9. [Documentation](#9-documentation)
10. [Dependency management](#10-dependency-management)
11. [Security rules](#11-security-rules)
12. [Performance rules](#12-performance-rules)
13. [Error handling](#13-error-handling)
14. [Logging](#14-logging)
15. [CI/CD](#15-cicd)
16. [Code review](#16-code-review)
17. [Regular maintenance](#17-regular-maintenance)

---

## 1. Principles

These underpin every specific rule below. When a situation isn't covered by a specific rule, apply these principles.

**Clarity over cleverness.** Code is read far more than it is written. Optimise for the person reading it in six months, not the person writing it today.

**Explicit over implicit.** If something isn't obvious from the code itself, make it obvious. Name things clearly, handle errors explicitly, document decisions that aren't self-evident.

**Small, focused units.** Functions do one thing. Files have one clear purpose. PRs address one concern. Small scope means smaller bugs, easier review, easier testing.

**No broken windows.** A linting error left unfixed signals that standards are optional. A `TODO` without a ticket signals that it will never be done. Fix it now or don't merge.

**Commit working code only.** Every commit on `main` must be in a deployable state. Every commit on a feature branch must at minimum compile and pass lint.

---

## 2. Repository structure

```
loop-app/
├── apps/
│   ├── web/          # React Router v7 + Vite
│   ├── mobile/       # Capacitor v8 shell
│   └── backend/      # TypeScript + Hono
├── packages/
│   └── shared/       # Types, proto generated code, constants
├── docs/
│   ├── architecture.md  # System design, data flows, API endpoints
│   ├── development.md   # Getting started, env vars, commands
│   ├── deployment.md    # Deploy backend, web, mobile
│   ├── testing.md       # Testing pyramid, coverage
│   ├── standards.md     # This file
│   ├── codebase-audit.md # Audit program and exit criteria
│   ├── audit-checklist.md # Workstream checklist
│   ├── audit-tracker.md # Audit execution tracker
│   ├── migration.md     # Migration plan and checklist
│   └── adr/             # Architecture Decision Records
├── .github/
│   └── workflows/    # CI/CD pipelines
├── AGENTS.md         # AI agent instructions
├── CLAUDE.md         # Symlink -> AGENTS.md
└── package.json      # Workspace root
```

### File naming

| Type                  | Convention                | Example                  |
| --------------------- | ------------------------- | ------------------------ |
| React components      | `PascalCase.tsx`          | `MerchantCard.tsx`       |
| Hooks                 | `use-kebab-case.ts`       | `use-native-platform.ts` |
| Utilities / services  | `kebab-case.ts`           | `api-client.ts`          |
| TypeScript types file | `kebab-case.types.ts`     | `merchant.types.ts`      |
| Test files            | co-located, same name     | `MerchantCard.test.tsx`  |
| Constants             | `kebab-case.constants.ts` | `stellar.constants.ts`   |

### One export per file (with exceptions)

Each file exports one primary thing. Exceptions: type-only files, constants files, and `index.ts` barrel files (which may re-export from multiple files in the same directory but must never re-export across directories).

### Barrel files

Each directory that is a public API surface should have an `index.ts` that controls what is exported. Internal implementation files should not be imported directly from outside the directory.

```
app/components/ui/
  button.tsx
  card.tsx
  input.tsx
  index.ts     ← only file imported by other directories
```

---

## 3. TypeScript rules

### Strict mode — non-negotiable

All packages run with TypeScript strict mode:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### No `any`

`any` is banned. Use `unknown` when a type is genuinely unknown and narrow it explicitly. The only exception is Capacitor plugin type bridges — add `// TODO: type properly` on every line that uses `any`.

### Explicit return types on exported functions

All exported functions must have explicit return types. This catches contract changes at the definition site, not the call site.

```typescript
// Wrong
export function formatCurrency(amount: number) {
  return `$${amount.toFixed(2)}`;
}

// Right
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
```

### Type imports

Always use `import type` for type-only imports. This ensures they are stripped at compile time and never affect runtime behaviour.

```typescript
import type { Merchant } from '@loop/shared';
import { fetchMerchants } from '~/services/api';
```

### Avoid type assertions

`as SomeType` is a lie to the compiler. Prefer type guards and proper narrowing. The only acceptable uses are:

- Casting event targets (`e.target as HTMLInputElement`)
- Generated protobuf/external types where you have no control

### Enums

Use `const` objects over TypeScript enums to avoid runtime overhead and unexpected behaviour:

```typescript
// Wrong
enum OrderStatus {
  Pending,
  Complete,
  Failed,
}

// Right
export const ORDER_STATUS = {
  Pending: 'pending',
  Complete: 'complete',
  Failed: 'failed',
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
```

---

## 4. Code style

### Functions

- Maximum 40 lines. If a function exceeds this, it is doing too much.
- Maximum 4 parameters. If more are needed, use an options object.
- Single responsibility — a function name should be accurate and complete.
- No boolean parameters that toggle behaviour. Use two separate functions or an options object.

```typescript
// Wrong
function fetchMerchants(includePagination: boolean) { ... }

// Right
function fetchMerchants(options: { page: number; pageSize: number }): Promise<MerchantPage> { ... }
```

### Files

- Maximum 300 lines. If a file exceeds this, it should be split.
- One primary exported unit per file (see above).

### Nesting

Maximum 3 levels of nesting. Use early returns to reduce nesting:

```typescript
// Wrong
function process(data: unknown) {
  if (data) {
    if (typeof data === 'object') {
      if ('id' in data) {
        return data.id;
      }
    }
  }
}

// Right
function process(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('id' in data)) return undefined;
  return data.id as string;
}
```

### Named constants — no magic numbers or strings

```typescript
// Wrong
setTimeout(refresh, 21600000);
if (zoom > 13) { ... }

// Right
const MERCHANT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLUSTERING_MAX_ZOOM = 13;
setTimeout(refresh, MERCHANT_REFRESH_INTERVAL_MS);
if (zoom > CLUSTERING_MAX_ZOOM) { ... }
```

Constants live in a `*.constants.ts` file in the same directory as the code that uses them, or in `packages/shared/src/constants.ts` if used across packages.

### No commented-out code

Delete it. Git history exists. Commented-out code causes confusion about whether something was intentionally removed or is a WIP.

### No `console.log`

All logging goes through the logger (see [Logging](#14-logging)). ESLint bans `console.log` in committed code.

### Import ordering

Enforced by ESLint `import/order`. Order must be:

```typescript
// 1. Node built-ins
import path from 'node:path';

// 2. External packages
import { Hono } from 'hono';
import { useQuery } from '@tanstack/react-query';

// 3. Internal packages
import type { Merchant } from '@loop/shared';

// 4. Internal aliases (~/ or @/)
import { apiClient } from '~/services/api';

// 5. Relative imports
import { Button } from './button';

// 6. Type imports (always last, grouped by above order)
import type { Route } from './+types/home';
```

Blank lines between each group. No mixing.

### React component structure

Every component file follows this order:

```typescript
// 1. Imports (ordered as above)

// 2. Types local to this component
interface MerchantCardProps {
  merchant: Merchant;
  onSelect: (id: string) => void;
}

// 3. Sub-components (if small and tightly coupled)

// 4. The component
export function MerchantCard({ merchant, onSelect }: MerchantCardProps) {
  // a. Hooks (always first)
  // b. Derived values / memos
  // c. Handlers
  // d. Effects (last among logic)
  // e. Render
}

// 5. No default export (except React Router route files)
```

---

## 5. Linting and formatting

### Tools

| Tool                        | Purpose                          | Runs                               |
| --------------------------- | -------------------------------- | ---------------------------------- |
| ESLint (v9 flat config)     | Code quality + style             | Pre-commit, CI                     |
| Prettier                    | Formatting                       | Pre-commit, CI                     |
| TypeScript (`tsc --noEmit`) | Type checking                    | Pre-commit (affected packages), CI |
| Husky                       | Git hooks                        | On commit, on commit-msg           |
| lint-staged                 | Run linters on staged files only | Pre-commit                         |
| commitlint                  | Enforce commit message format    | On commit-msg                      |

### Prettier config (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "bracketSpacing": true,
  "arrowParens": "always"
}
```

### ESLint rules (non-exhaustive — see `eslint.config.js` for full config)

```
@typescript-eslint/no-explicit-any             error
@typescript-eslint/no-unused-vars              error
@typescript-eslint/explicit-function-return-type  error (allowExpressions)
@typescript-eslint/no-floating-promises        error
@typescript-eslint/await-thenable             error
@typescript-eslint/consistent-type-imports    error
@typescript-eslint/no-misused-promises        error
react-hooks/rules-of-hooks                    error
react-hooks/exhaustive-deps                   warn
no-console                                    error
no-debugger                                   error
no-var                                        error
prefer-const                                  error
eqeqeq                                        error
```

### Pre-commit hook behaviour

Husky runs on every `git commit`:

1. `lint-staged` — runs ESLint + Prettier on staged `.ts`/`.tsx` files

If lint fails, the commit is rejected. Fix the issue and commit again. **Never use `--no-verify`.**

Typecheck runs via CI (not pre-commit) to keep commits fast.

---

## 6. Commit discipline

### Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec. Enforced by `commitlint`.

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

**Types:**

| Type       | Use for                                         |
| ---------- | ----------------------------------------------- |
| `feat`     | New feature or capability                       |
| `fix`      | Bug fix                                         |
| `refactor` | Code change that is neither a fix nor a feature |
| `perf`     | Performance improvement                         |
| `test`     | Adding or correcting tests                      |
| `docs`     | Documentation only                              |
| `chore`    | Maintenance — deps, config, tooling             |
| `ci`       | CI/CD pipeline changes                          |
| `build`    | Build system changes                            |
| `revert`   | Reverting a previous commit                     |

**Scopes:** `web`, `mobile`, `backend`, `shared`, `infra`, `deps`

**Examples:**

```
feat(web): add merchant search with debounced input
fix(backend): resolve off-by-one error in cluster grid calculation
refactor(shared): extract currency formatting to shared utility
perf(backend): cache upstream API responses with ETags
test(backend): add coverage for OTP expiry edge cases
docs(api): document /api/clusters endpoint parameters
chore(deps): update @bufbuild/protobuf to 2.x
ci: add coverage threshold enforcement to workflow
```

### Commit frequency

- Commit at logical checkpoints — a feature is complete, a bug is isolated and fixed, a refactor is done.
- Each commit on a feature branch must compile and pass lint (even if tests are incomplete).
- Each commit on `main` must be fully working and tested.
- Do not batch unrelated changes into one commit.
- Do not commit half-finished work to a shared branch. Use `git stash` or a draft PR.

### Commit message body

If the change is non-obvious, add a body explaining **why**, not what:

```
fix(backend): increase OTP expiry window to 10 minutes

Users on slow email providers were receiving their OTP after it had
already expired at 5 minutes. Increased to 10 minutes based on P95
email delivery latency data.
```

---

## 7. Branching strategy

### Trunk-based development with short-lived feature branches

```
main           ← always deployable, protected
├── feature/merchant-search
├── feature/purchase-flow
├── fix/cluster-zoom-calculation
└── chore/update-protobuf-types
```

### Branch naming

```
feature/<short-description>     feat(web): add merchant search
fix/<short-description>         fix(backend): otp-expiry-window
chore/<short-description>       chore(deps): update-protobuf
refactor/<short-description>    refactor(shared): currency-utils
```

Use hyphens, no spaces, all lowercase.

### Rules

- **`main` is protected.** No direct pushes. All changes via PR.
- **Feature branches are short-lived.** Target < 2 days from branch to merge. If it takes longer, the change is too large — split it.
- **One concern per branch.** A branch that touches both the map clustering and the auth flow needs to be split.
- **Rebase, don't merge.** Keep a linear history. Rebase feature branches onto current `main` before raising a PR.
- **Squash merge to `main`.** Each PR becomes one commit on `main`. The commit message is the PR title (which must be a valid Conventional Commit).
- **Delete branches after merge.** No branch graveyard.
- **No long-lived branches.** There is no `develop` or `staging` branch. Environment differences are handled by configuration, not branching.

### Releases and tags

Releases are tagged on `main`:

```
v0.1.0   First TestFlight build
v0.2.0   Auth flow complete
v1.0.0   App Store submission
```

Tags follow [semver](https://semver.org/). Mobile app version numbers in Xcode/Android are derived from git tags via CI.

---

## 8. Testing

### Tools

| Tool                        | Used for                                          |
| --------------------------- | ------------------------------------------------- |
| Vitest                      | Unit and integration tests (web, backend, shared) |
| `@testing-library/react`    | React component tests                             |
| `msw` (Mock Service Worker) | Mocking HTTP in tests                             |
| Playwright                  | End-to-end tests (critical paths only)            |

### Coverage thresholds (enforced in CI)

| Package / directory            | Line coverage |
| ------------------------------ | ------------- |
| `packages/shared`              | 90%           |
| `apps/backend/src/clustering/` | 85%           |
| `apps/backend/src/auth/`       | 85%           |
| `apps/backend/src/orders/`     | 80%           |
| `apps/web/app/services/`       | 80%           |
| `apps/web/app/hooks/`          | 70%           |
| Overall minimum                | 65%           |

CI fails if any threshold is breached. Coverage is measured on every PR — not just at release.

### What to test

**Unit test:** pure functions, data transformations, clustering algorithm, auth token logic, currency formatting, URL building.

**Integration test (Vitest + msw):** API client functions (mock the HTTP layer), auth flow (OTP request → verify → token storage), order creation flow, full clustering pipeline from raw locations to clustered output.

**E2E test (Playwright):** critical user journeys only — do not use E2E where a unit or integration test would suffice.

Critical paths for E2E:

1. Auth: email entry → OTP → authenticated → home screen visible
2. Purchase: select merchant → choose denomination → pay → order confirmation
3. Map: map loads, clusters visible, zoom in shows individual pins

### What NOT to test

- Snapshot tests (fragile, noisy with Tailwind)
- Implementation details (test behaviour, not internals)
- Third-party library behaviour (assume it works)
- Trivial getters/setters with no logic

### Test file location

Tests are co-located with the code they test:

```
app/services/api-client.ts
app/services/api-client.test.ts

app/hooks/use-merchants.ts
app/hooks/use-merchants.test.ts
```

E2E tests live in `tests/e2e/` at the repo root.

### Test naming

```typescript
describe('formatCurrency', () => {
  it('formats positive amounts with two decimal places', () => { ... });
  it('formats zero as $0.00', () => { ... });
  it('throws for negative amounts', () => { ... });
});
```

Use plain English descriptions that read as sentences. Avoid acronyms and jargon.

### Mocking Capacitor in tests

```typescript
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));
```

### Test data

Use explicit, readable test fixtures — not random generation unless specifically testing randomness. Define fixtures in a `__fixtures__/` directory alongside tests when they are reused.

---

## 9. Documentation

### Where documentation lives

| Type                          | Location                                               |
| ----------------------------- | ------------------------------------------------------ |
| Engineering standards         | `docs/standards.md` (this file)                        |
| Architecture decisions        | `docs/adr/NNN-title.md`                                |
| API reference                 | `docs/architecture.md` (Backend API endpoints section) |
| Migration plan                | `docs/migration.md`                                    |
| AI agent instructions         | `AGENTS.md` (symlinked as `CLAUDE.md`)                 |
| Component/hook usage          | JSDoc on the export                                    |
| Complex algorithm explanation | Inline comment in the file                             |

### When to write an ADR

Write an Architecture Decision Record when:

- You are choosing between two or more non-trivial technical approaches
- You are making a decision that will be hard to reverse
- Future developers will wonder "why did they do it this way?"

ADR format (`docs/adr/NNN-title.md`):

```markdown
# NNN — Title

## Status

Accepted | Superseded by ADR-NNN

## Date

YYYY-MM-DD

## Context

What is the problem or situation that required a decision?

## Decision

What did we decide?

## Consequences

What are the trade-offs? What becomes easier? What becomes harder?
```

Existing decisions to record as ADRs:

- `001-static-export-capacitor.md` — Static export over remote URL
- `002-typescript-backend.md` — TypeScript over Go for the backend
- `003-protobuf-clustering.md` — Protobuf for clustering endpoint

### JSDoc on exported functions

Every exported function must have a JSDoc comment. It must explain what the function does, its parameters if non-obvious, and its return value if non-obvious. It does not need to restate what the type signature already makes clear.

```typescript
/**
 * Converts a merchant name to a URL-safe slug.
 * Lowercases, replaces spaces with hyphens, strips non-alphanumeric characters.
 */
export function toMerchantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}
```

### Inline comments

Write comments that explain **why**, not **what**. The code explains what; the comment explains the reasoning behind a non-obvious choice.

```typescript
// Wrong
// Multiply by 1000 to convert to milliseconds
const ms = seconds * 1000;

// Right
// OTP expiry is stored in seconds on the backend but the JWT library
// expects milliseconds — convert here to avoid confusion at the call site.
const expiryMs = otpExpirySeconds * 1000;
```

### Keeping docs current

Documentation that is wrong is worse than no documentation. When you change behaviour, update the relevant docs in the same PR. A PR that changes an API endpoint must update `docs/architecture.md`. A PR that makes an architectural change must add or update an ADR.

---

## 10. Dependency management

### Adding a dependency

Before adding any package, ask:

1. Is this functionality already available in a package we have?
2. Is the package actively maintained (last release < 6 months)?
3. Does it have a healthy download count and GitHub star count?
4. What is its licence? (MIT/Apache/BSD acceptable. GPL: check carefully.)
5. What is its bundle size impact? (Check bundlephobia.com for frontend deps.)

New dependencies in `apps/web` must not increase the initial bundle by more than 10KB gzipped without a documented justification.

### Keeping dependencies updated

- Run `npm audit` weekly. Fix `high` and `critical` findings immediately.
- Update minor/patch versions monthly. Update major versions intentionally with a dedicated PR.
- Do not use `^` for major-version packages that are architecturally critical (React, React Router, Capacitor). Pin these and update deliberately.

### No duplicate dependencies

If `packages/shared` already contains a utility, do not reimplement it in `apps/web`. Import from `@loop/shared`.

---

## 11. Security rules

These are hard rules. There are no exceptions without explicit documented justification reviewed by a second engineer.

- **No secrets in source code.** API keys, JWT secrets, private keys, and credentials live in environment variables only. Never in `.env` files committed to the repository.
- **No access tokens in persistent storage.** Access tokens live in memory (Zustand store) only. They are gone when the app is refreshed/closed.
- **Refresh tokens on mobile:** Capacitor secure storage only. Not `localStorage`. Not `sessionStorage`. Not `AsyncStorage`.
- **All inputs validated.** Validate at the API boundary in the backend. Never trust client-supplied data.
- **Stellar private keys never leave the device.** Generated on-device. Never transmitted. The backend receives only the public key.
- **No logging of sensitive data.** No logging of tokens, OTPs, email addresses in full, or any PII. Truncate or redact.
- **Auth and payment code requires two-person review.** Any PR touching `apps/backend/src/auth/`, `apps/backend/src/orders/`, `apps/backend/src/stellar/`, or any Capacitor secure storage call requires approval from a second engineer who reviews security implications specifically.

---

## 12. Performance rules

### Web / mobile

- Images served through the backend image proxy — never directly from upstream CDN URLs in production.
- Map clustering requests use protobuf (`Accept: application/x-protobuf`) — never JSON in production.
- Lazy-load heavy components (map, purchase flow) — no blocking large bundles on initial render.
- No synchronous operations in React render. Heavy computation goes in `useMemo` or a web worker.
- TanStack Query handles caching — do not implement a parallel custom cache.

### Backend

- Merchant and location data is held in memory — no database query per request for clustering.
- Refresh cycles run on background timers, never on the request path.
- Image cache has a max size (100MB) with LRU eviction — enforced in code, not just policy.
- All upstream API requests have a timeout (30 seconds max).

---

## 13. Error handling

### The rule: errors must be handled or explicitly propagated

There are no silent failures. Every `try/catch` either:

1. Handles the error (logs it, returns a fallback, shows the user a message), or
2. Re-throws it with added context

```typescript
// Wrong — silent failure
try {
  await fetchMerchants();
} catch {}

// Wrong — swallowed without action
try {
  await fetchMerchants();
} catch (err) {
  console.error(err);
}

// Right — handled with fallback
try {
  return await fetchMerchants();
} catch (err) {
  logger.error('Failed to fetch merchants', { error: err });
  return [];
}

// Right — propagated with context
try {
  return await fetchMerchants();
} catch (err) {
  throw new Error('Merchant fetch failed during home screen load', { cause: err });
}
```

### User-facing errors

Never show raw error messages, stack traces, or internal identifiers to users. Map errors to user-friendly messages at the UI layer. Keep technical details in logs.

### Async functions

All async functions that can fail must have error handling at every `await`. An unhandled promise rejection is a bug.

### Backend error responses

```json
{
  "error": {
    "code": "OTP_EXPIRED",
    "message": "The verification code has expired. Please request a new one."
  }
}
```

Error codes are `SCREAMING_SNAKE_CASE` strings, stable across versions, documented in `docs/architecture.md`. HTTP status codes follow convention (400 bad request, 401 unauthenticated, 403 forbidden, 404 not found, 500 server error).

---

## 14. Logging

### Web app

No `console.log` in committed code. For development debugging, use `console.debug` which is stripped in production builds via the bundler config.

### Backend

Use a structured logger (e.g. `pino`). All log entries are JSON objects with consistent fields:

```json
{
  "level": "info",
  "time": "2025-03-05T12:00:00.000Z",
  "msg": "Merchant sync complete",
  "count": 1247,
  "duration_ms": 2341
}
```

**Log levels:**

- `debug` — detailed info for development. Never enabled in production.
- `info` — routine operational events (sync complete, server started, request received).
- `warn` — something unexpected but recoverable happened.
- `error` — something failed. Always include the error object.

**Never log:** tokens, OTPs, raw passwords, full email addresses (use first 3 chars + `***`), full API keys.

---

## 15. CI/CD

### Pipeline runs on every PR and every push to `main`

```yaml
jobs:
  quality:
    - typecheck (all packages)
    - lint (all packages)
    - test (all packages, with coverage thresholds)
    - build:web (SSR mode)
    - build:mobile (static export)
    - build:backend

  security:
    - npm audit (fail on high/critical)

  e2e: # Only on PRs targeting main
    - playwright tests against preview deployment
```

### Branch protection on `main`

- All CI jobs must pass
- At least 1 approving review
- Dismiss stale approvals on new commits
- No force pushes
- No direct pushes

### Environment promotion

```
feature branch → preview deploy (automatic, ephemeral)
main           → staging deploy (automatic)
git tag vX.Y.Z → production deploy (manual trigger)
```

---

## 16. Code review

### What reviewers check

1. **Correctness** — does it do what the PR says it does?
2. **Tests** — are the right things tested? Does coverage hold?
3. **Standards compliance** — does it follow this document? (CI catches most of this.)
4. **Security** — especially for auth, payment, and storage code.
5. **Documentation** — is anything newly complex documented?
6. **Simplicity** — is there a simpler way to achieve the same thing?

### PR requirements

- Title is a valid Conventional Commit message (it becomes the squash commit).
- Description explains **what** changed and **why** — not just a list of files.
- All CI checks pass before requesting review.
- Self-review before requesting review — read your own diff once.

### PR size

Target < 400 lines changed. Large PRs are hard to review well and slow everything down. Split large changes into a stack of smaller PRs if needed.

### Review turnaround

Review open PRs within one working day. A PR that sits unreviewed for more than two days should be chased up.

### Responding to feedback

All review comments must be addressed before merging — either by making the change or by explaining why you disagree. "LGTM" on a disagreement is not resolution. Discuss until consensus.

---

## 17. Regular maintenance

### Weekly

- `npm audit` — fix high/critical findings immediately.
- Review and close any stale branches (> 1 week old with no activity).

### Monthly

- Update minor/patch dependencies across all packages.
- Review open TODOs in the codebase — if a TODO has no associated ticket, either create the ticket or delete the TODO.
- Review test coverage report for any packages that have dropped below threshold.

### Per quarter

- Review ADRs — are any decisions now outdated and worth revisiting?
- Review `docs/architecture.md` for accuracy against the running backend.
- Dependency major version review — are any major updates worth taking?
- Security audit of auth and payment code paths.

### Zero-tolerance issues

These are fixed immediately, before any other work:

- `npm audit` high/critical finding
- Secrets committed to the repository (rotate the secret, then remove from history)
- A failing test on `main`
- A linting error on `main`
