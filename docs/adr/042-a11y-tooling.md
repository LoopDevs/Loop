# ADR 042 — Accessibility regression tooling (eslint-plugin-jsx-a11y, jest-axe)

**Status:** Accepted (2026-07-09)
**Context:** `docs/readiness-backlog-2026-07-03.md` B-2 (Accessibility), `docs/go-live-plan.md` §T1-BS B-2

## Context

Loop is a consumer finance app targeting the Eurozone; the **European
Accessibility Act** mandates accessibility for e-commerce/banking there, and
WCAG 2.1 AA is the practical bar we're being held to. B-2 has been open since
the 2026-07-03 readiness backlog with "no axe/jsx-a11y/pa11y/keyboard tests."

The manual-only approach has already proven it doesn't hold as a regression
gate:

- **CF-35** was a batch of manual accessibility fixes (skip-link + `<main>`
  landmarks, `role="alert"` on inline errors, `inert` on inactive onboarding
  slides, roving-tabindex radiogroups, aria-live copy-confirmation patterns)
  applied by hand across the purchase/auth/onboarding surfaces.
- **WUM-10** (`docs/audit-2026-06-30-cold/raw/v-web-ui-money.md`) found the
  CF-35 copy-confirmation pattern hadn't actually been rolled out to all five
  "copy to clipboard" sites — a fix landed in one place regressed by omission
  everywhere else, because nothing mechanical checked for it.

Both fixes were correct in isolation but non-durable: nothing stopped the next
PR from reintroducing an unlabeled input, a click handler on a non-interactive
`<div>`, or a new copy-to-clipboard button without the aria-live pattern.
That's the gap this ADR closes — a **mechanical** floor under the manual work,
mirroring how the money invariants (`docs/invariants.md`) demote from
"someone remembered" to "CI enforces."

## Decision

Two devDependencies, **apps/web only**, wired as regression gates:

| Dep                                | Layer                                                                           | What it catches                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint-plugin-jsx-a11y`           | Static JSX lint — every PR, via `npm run lint`                                  | Structural mistakes at write time: missing `alt`, click handlers on non-interactive elements without a role/keyboard handler, unlabeled form controls, invalid ARIA attribute/role combinations, redundant/missing landmark roles.            |
| `jest-axe` (+ `axe-core`, bundled) | Runtime DOM scan — `npm test` (vitest), one smoke test per key rendered surface | What static analysis can't see because it depends on the actual rendered DOM: computed contrast (where color isn't dynamic), duplicate IDs, missing accessible names that only resolve after render, landmark structure of the composed tree. |

**Why both, not one:** jsx-a11y is fast and runs on every file on every PR,
but it only sees JSX syntax — it can't catch a violation that only exists in
the rendered output (e.g., two components each emitting a static
`id="main"` that only collide once composed). jest-axe scans real DOM but
only wherever a test renders a surface, so it doesn't cover every file the way
the lint gate does. Together they're the same static-analysis-plus-runtime-check
shape the repo already uses elsewhere (typecheck + tests, or
`check-openapi-parity` + the integration ledger assertion).

**Both stay devDependencies, apps/web only, never in a shipped bundle** —
same framing as ADR 041: `eslint-plugin-jsx-a11y` only runs inside the ESLint
process (never imported by app code); `jest-axe` and its bundled `axe-core`
only run inside the vitest test process (`*.test.tsx` files, which are
excluded from the SSR/mobile build). Neither is imported from
`apps/web/app/**` non-test source, so `npm run check:bundle-budget` and the
web Docker image are unaffected.

**Scope of the lint gate:** `apps/web/app/**/*.tsx` only — the plugin's
`flatConfigs.recommended` rule set, added as its own flat-config block so it
doesn't interact with the existing TypeScript/react-hooks block. Backend and
`packages/shared` have no JSX to lint.

**Scope of the runtime scans:** one `jest-axe` smoke test per key user-facing
surface — home (`MobileHome`), the purchase flow (`PurchaseContainer`), the
auth screen (`AuthRoute`), the orders list (`LoopOrdersList`), and onboarding
(`Onboarding`) — asserting `toHaveNoViolations()` at the WCAG 2.1 A + AA rule
tags (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`). These are smoke tests, not
an exhaustive audit: they catch a structural regression on a render that
already happens in CI; they do not replace a keyboard/screen-reader pass.

## Alternatives considered

- **pa11y / `@axe-core/playwright`** — e2e-layer scans (real browser, real
  CSS, real contrast). More accurate than jsdom-rendered `jest-axe` — but
  slower (spins up a browser) and the repo's e2e suites (`test-e2e-mocked`)
  are already the slowest CI job. Deferred, not rejected: worth adding once
  the unit-test-layer gate has caught the easy regressions and the marginal
  e2e cost is worth the extra fidelity (real contrast checking in particular
  needs a real rendering engine — jsdom has no layout/paint, so `jest-axe`
  cannot catch color-contrast violations; that gap is explicitly left to a
  future pa11y/axe-playwright pass and/or manual review, not silently closed).
- **Manual-only (status quo)** — rejected. CF-35 + WUM-10 (above) are direct
  evidence a hand-applied fix regresses by omission with nothing to catch it.
  B-2 needs a mechanical floor, not another one-off pass.

## Consequences

- `npm run lint` now fails on new jsx-a11y violations in `apps/web/app/**/*.tsx`.
  The repo's `lint` script runs `eslint . --max-warnings=0`, so a rule-level
  `warn` downgrade would still fail CI on every existing hit — there is no
  "quiet but visible" middle tier. The initial sweep found 26 violations
  across 4 rules; 24 were genuine false positives specific to this codebase
  (documented below) and are suppressed with scoped, reasoned
  `eslint-disable-next-line` comments — same convention the repo already uses
  for `react-hooks/exhaustive-deps` escape hatches — rather than a blanket
  rule downgrade, so the rule stays at `error` and keeps catching _new_
  instances everywhere else. The other 2 were real gaps, fixed directly.
  Tracked in `docs/readiness-backlog-2026-07-03.md` B-2:
  - `jsx-a11y/no-redundant-roles` (19 instances) — `role="list"` on `<ul>`.
    Tailwind Preflight sets `list-style: none` on every `<ul>`, which strips
    the browser's implicit `list`/`listitem` role in Safari/VoiceOver (a
    WebKit-specific quirk; Chrome/Firefox are unaffected). `role="list"`
    restores it. The rule has no way to see the CSS interaction, so every
    instance in this codebase is a false positive, not a mistake.
  - `jsx-a11y/no-autofocus` (5 instances) — the sole input on an
    auth/onboarding step that just became active after an explicit user
    action (submit email, advance a wizard step). Not an unexpected focus
    jump; the plugin blanket-disallows `autoFocus`, WCAG does not.
  - `jsx-a11y/no-noninteractive-element-interactions` (1 instance,
    `CountrySelector.tsx`) — `onMouseDown` on the modal panel only stops
    propagation to the backdrop's close-on-outside-click handler; it offers
    no interaction of its own needing a keyboard equivalent.
  - `jsx-a11y/role-has-required-aria-props` (1 instance, `Navbar.tsx`) — a
    real gap, fixed: the search `combobox` was missing `aria-controls`
    alongside its existing `aria-expanded`/`aria-owns`.
- `npm test` (vitest) gains five `*.a11y.test.tsx` smoke tests. They render
  with the same mocking patterns already used by the surface's other tests
  (`QueryClientProvider` + `MemoryRouter`, hooks/services mocked) — no new
  test infrastructure beyond `expect.extend(toHaveNoViolations)` per file.
- Does **not** cover: real browser contrast checking (jsdom has no layout
  engine), keyboard-only navigation walkthroughs, or screen-reader behavior
  (VoiceOver/TalkBack/NVDA) — those remain the manual pass B-2 still calls
  for. This ADR closes the "no mechanical floor at all" gap, not all of B-2.
- `npm audit` / `sbom` now include `eslint-plugin-jsx-a11y`, `jest-axe`, and
  `axe-core` (bundled transitive dep of `jest-axe`); all three are
  well-maintained with no known criticals at adoption time.
