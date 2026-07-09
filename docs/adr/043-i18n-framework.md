# ADR 043 — i18n framework (i18next / react-i18next) + first string-extraction tranche

**Status:** Accepted (2026-07-10)
**Context:** `docs/readiness-backlog-2026-07-03.md` B-6, `docs/go-live-plan.md` §T1-BS B-6

## Context

B-6 has been open since the 2026-07-03 readiness backlog: `SUPPORTED_LANGS =
['en']` (`packages/shared/src/countries.ts`), copy is hardcoded in JSX, no i18n
framework, RTL unconsidered despite the AE/SA extended-currency markets (ADR
035). The backlog explicitly scoped closing it as "pick a framework
(i18next/formatjs → ADR), extract copy to catalogs, add RTL."

This is **not** the first pass at a translation seam. The 2026-06-16 cold audit
(CF-22) found a hand-rolled `i18n/t.ts` + `i18n/messages.ts` scaffold — a
dependency-free `t(key, vars, lang)` lookup with a small representative
message set — imported by nobody, and made a deliberate call documented in
`docs/adr/034-path-based-locale-routing.md` §"i18n seam status": **do not
mass-extract copy through `t()` while only English ships.** The reasoning was
sound at the time — with one language, routing ~137 components' copy through
`t()` is pure churn with zero user-visible effect, and the exhaustive
extraction was explicitly deferred to "the first non-`en` locale."

**What's changed:** the language SET is a 🧭 operator decision that stays
deferred — nobody has picked which language ships second. But the FRAMEWORK
and EXTRACTION work is language-agnostic: choosing i18next, wiring the
provider, and moving hardcoded JSX strings into keyed catalogs doesn't need to
know what language(s) are coming. Splitting B-6 this way — infrastructure +
extraction now, actual translations gated on the language decision — means the
large, mechanical, reviewable part of the work (this PR and its follow-up
tranches) can proceed today, and flipping on a second language later really is
the "JSON drop, not a refactor" ADR 034 §7 promised, rather than also needing a
from-scratch extraction at that point. This ADR supersedes CF-22's "don't
extract yet" call with "extract now, translate later" — the two are
different work and this decouples them.

The old scaffold (`t.ts`/`messages.ts`) is **deleted** by this PR, not kept
alongside the new framework — it was unimported dead code with a ~7-key
representative set, superseded outright by the real extraction below. Nothing
in the app imported it (verified before deletion).

## Decision

Adopt **i18next + react-i18next** (`i18next@26.3.6`, `react-i18next@17.0.9`,
`apps/web` dependencies) as the translation framework, extract a first tranche
of customer-facing copy into catalogs, and wire the provider into the app
bootstrap. Actual non-English translations are **out of scope** — every
catalog ships English-only; adding a language is follow-up work gated on the
🧭 language-set decision (see `docs/i18n.md`).

### Why i18next / react-i18next

| Requirement (from AGENTS.md + ADR 034)                                                                          | How i18next satisfies it                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locale driven by the `/:country/:lang` route param (ADR 034), not the browser                                   | `i18n.changeLanguage()` is a plain imperative call — wired into the _same_ `useEffect` in `root.tsx` that already derives `<html lang>`/`<html dir>` from `useLocale()` (A11Y-011/I18N-003). No `i18next-browser-languagedetector` — that plugin reads `navigator.language`, which is exactly the "US flash" ADR 034 was written to kill (server and client would disagree on first paint until a client-only detector resolved). |
| SSR (`loopfinance.io`, `ssr: true`) + static export (`BUILD_TARGET=mobile`, `ssr: false`, no server round-trip) | Resources are bundled at build time via `resources: {...}` in `.init()` — no `i18next-http-backend`, no lazy namespace fetch. `.init()` with inline resources completes **synchronously** (no `await`, no Suspense) — the single property that makes the same bootstrap work identically in `entry.server.tsx`'s `renderToPipeableStream`, the static SPA build, and hydration, with no environment-specific branching.           |
| Pure-API-client architecture (AGENTS.md rule 1)                                                                 | Catalogs are static JSON imported at build time, not fetched from `apps/backend` at runtime — no new API surface, no new loader.                                                                                                                                                                                                                                                                                                  |
| RTL support (`/:country/:lang` will eventually route AE/SA-class markets, ADR 035)                              | i18next is content-only — it has no opinion on `dir`. `<html dir>` is **already** live (`i18n/locale.ts#getLangDir`, wired in `root.tsx` since A11Y-011/I18N-003, currently `RTL_LANGS = ['ar','he','fa','ur']` — none shipped yet). i18next slots in alongside that existing seam rather than replacing or duplicating it.                                                                                                       |
| `packages/shared`'s `SUPPORTED_LANGS`/`isSupportedLang` stay the routing source of truth                        | Unchanged. i18next's own `resources` map is a **second**, independent list (which catalogs are _bundled_) — adding a language is "add to both": route support in `@loop/shared` (ADR 034) and a resources entry here (`docs/i18n.md`).                                                                                                                                                                                            |
| Ecosystem maturity for a money/consumer-finance app                                                             | i18next is the most widely deployed JS i18n framework (10+ years, ICU-adjacent plural/format support via optional plugins if ever needed, ~11M weekly downloads); `react-i18next` is its React binding, actively maintained, first-class TypeScript support via `resources`-derived types (not adopted in this tranche — see Consequences).                                                                                       |

### Alternatives considered

- **FormatJS / react-intl** — ICU MessageFormat is more expressive for
  complex pluralization/gender than i18next's own interpolation syntax, and
  its compile-time extraction tooling (`babel-plugin-formatjs`) is more
  rigorous than hand-written keys. Rejected for this pass: react-intl's
  `IntlProvider` model is heavier to thread through the SSR path we already
  have working (`entry.server.tsx`'s custom `renderToPipeableStream`), and
  Loop's copy so far has no complex plural/gender rules that would need real
  ICU — `{{var}}` interpolation covers every string in this tranche. Revisit
  if a shipped language needs real plural rules (Arabic's six plural forms,
  say) that i18next's simpler pluralization can't express cleanly.
- **Keep the hand-rolled `t.ts`/`messages.ts` scaffold, just start using it** —
  rejected. It has no namespace splitting (one flat key→string map — would
  become an unmaintainable single file at full-app scale), no ecosystem
  tooling (no extraction CLI, no translation-service integrations, no
  pluralization), and every consumer would need bespoke glue for the SSR/CSR
  language-sync problem i18next already solves. Reinventing i18next's core
  loop (resource store, namespace lookup, interpolation, fallback chain)
  by hand is exactly the kind of infra a mature dependency should own.
- **`next-intl` / other Next.js-specific libraries** — not applicable; this is
  React Router v7, not Next.js.
- **Do nothing further (leave B-6 as "framework decision open")** — rejected;
  it's the largest unclaimed item in the blind-spots tier of the go-live plan
  and the backlog explicitly calls for an ADR + extraction start.

## What this PR does

1. **Framework wiring** (`apps/web/app/i18n/i18next.ts`) — a single
   module-scope i18next instance, `.use(initReactI18next).init(...)` with
   bundled `resources` (no backend, no language detector), `lng: 'en'`,
   `fallbackLng: 'en'`, `react: { useSuspense: false }`.
2. **Provider** — `root.tsx`'s `Layout()` wraps `{children}` in
   `<I18nextProvider i18n={i18n}>`, and `App()`'s existing
   `<html lang>`/`<html dir>`-syncing `useEffect` (driven by
   `~/i18n/locale.ts#useLocale()`, ADR 034) now also calls
   `i18n.changeLanguage(locale.lang)` — the single place the route locale,
   `<html lang>`, and the active i18next language are kept in agreement.
3. **First extraction tranche** — customer-facing copy moved from inline JSX
   literals to `t()` calls, backed by per-feature-area JSON catalogs under
   `apps/web/app/i18n/locales/en/`:
   - `footer.json` ← `components/features/Footer.tsx` (full)
   - `notFound.json` ← `routes/not-found.tsx` + `routes/not-found-ssr.tsx`
     (full — including the `meta()` title, via the non-hook `i18n.t()`
     access pattern, since `meta()` runs outside the React tree)
   - `home.json` ← `routes/home.tsx`'s desktop hero, featured/directory
     section headers, `Feature` labels, and `ErrorBoundary` (the rendered
     JSX copy; the SEO `meta()` title/description are **not** extracted this
     pass — see "What's left" below)
   - `auth.json` ← `routes/auth.tsx` in full: the OTP sign-in flow, the
     authenticated Account view (cashback balance/history cards, theme +
     biometric-lock rows), and its `ErrorBoundary`
   - `onboarding.json` ← the `Onboarding.tsx` copy bank (`getOnboardingCopy()`,
     formerly the `COPY`/`PHASE1_TRUST_COPY` object literals) + its CTA-label
     array + `components/features/onboarding/screens-trust.tsx`'s inline
     strings (`TrustWelcome`/`TrustHowItWorks`/`TrustMerchants`)
   - `common.json` ← the one string shared verbatim across two surfaces
     (the `ErrorBoundary` heading "Something went wrong", home + auth)

   Product-brand terms are **deliberately not translated** — "Face ID" /
   "Touch ID" (Apple product names) stay hardcoded string literals in
   `auth.tsx` and `Onboarding.tsx`, same convention as never translating
   "iPhone". Only the generic "Biometrics" fallback is catalogue-driven.

   English text is byte-for-byte unchanged from what shipped before this PR —
   this is a mechanical extraction, not a copy edit.

4. **Test infra** (`apps/web/vitest.setup.ts`, wired via
   `vitest.config.ts#test.setupFiles`) — every test file's module registry
   now imports `~/i18n/i18next` (side-effect init) before tests run, so any
   component calling `useTranslation()` resolves real English copy instead of
   raw `"namespace:key"` fallback strings. Without this, two pre-existing
   test files (`onboarding-phase1-copy.test.tsx`,
   `onboarding-skip-nav.test.tsx`) that assert exact rendered strings failed
   immediately — vitest's per-file module isolation means an app-code-only
   import of the init module doesn't reliably run before a given test file's
   render call. `apps/web/app/i18n/__tests__/i18next.test.tsx` covers the
   framework itself: synchronous init, a known-key lookup via the
   non-component `i18n.t()` path, interpolation, the unknown-key fallback,
   and a `useTranslation()`-calling component actually rendering through
   `I18nextProvider`.

## What's left (follow-up tranches, unblocked by this PR)

Explicitly **not** done this pass — tracked as follow-up B-6 tranches, not
regressions:

- **Remaining customer-facing surfaces**: `MobileHome.tsx` (797 lines, the
  primary mobile dashboard), the other onboarding screens
  (`screen-currency.tsx`, `screen-biometric.tsx`, `screen-wallet-intro.tsx`,
  `signup-tail.tsx`), `OnboardingDesktop.tsx`'s own email/OTP capture form
  (distinct from the trust-screen copy bank this PR did extract — its own
  ~15 strings: "Welcome to the club.", the resend-code copy, etc.),
  gift-card detail, the purchase flow, orders list/detail, settings pages.
- **`home.tsx` / `auth.tsx` / `not-found.tsx` `meta()` titles that involve
  interpolation logic** (`home.tsx`'s country-conditional title/description)
  — the two static-title `meta()` functions (not-found, auth) ARE extracted
  via the non-hook `i18n.t()` pattern this PR establishes; the more complex
  conditional one is deferred to keep this tranche's diff reviewable.
- **Actual translations** — every catalog above is English-only. Adding a
  language is a resources-map + JSON-files change once the 🧭 language-set
  decision lands (see `docs/i18n.md` "Adding a language").
- **`<Trans>` for markup-embedded copy** — this tranche's headline-with-
  highlighted-word strings (e.g. home's "Instant **cashback** everywhere you
  shop.") were split into prefix/highlight/suffix `t()` keys with the JSX
  markup (`<span>`, `<br/>`) authored around them, rather than using
  react-i18next's `<Trans>` component. That's a deliberate simplicity choice
  for this first tranche (hand-splitting is easy to verify correct;
  hand-writing `<Trans>`'s numbered-child placeholder syntax without
  extraction tooling is easy to get subtly wrong). `<Trans>` is documented in
  `docs/i18n.md` as the right tool once a follow-up tranche hits copy where
  splitting would mangle the sentence (most European languages reorder
  clauses relative to English).
- **RTL runtime verification** — `getLangDir()`/`<html dir>` wiring predates
  this PR (A11Y-011/I18N-003) and stays correct, but no RTL language ships
  yet, so there's no rendered RTL layout to visually verify against.

## Consequences

- **New dependencies**: `i18next` (26.3.6) + `react-i18next` (17.0.9),
  `apps/web` only. Pulls in `html-parse-stringify` + `void-elements`
  (react-i18next's `<Trans>` HTML-string parsing, unused by this tranche but
  part of the package) and `use-sync-external-store` (React 18/19-compatible
  external-store subscription — already effectively present transitively via
  React itself, now an explicit top-level entry). None are Capacitor plugins,
  so no `apps/mobile/package.json` change is needed (AGENTS.md's
  "declare in both" rule is scoped to Capacitor plugins specifically — the
  mobile app loads the built static web output from disk, not this package
  directly).
- **Lockfile-pruning bug encountered and repaired**: `npm install` on this
  change dropped 11 `lightningcss-linux-*`/`lightningcss-*` platform
  optional-dependency entries from `package-lock.json` (a known npm
  optional-dependency lockfile-regeneration bug, not specific to this PR).
  Repaired by merging only the genuinely new package entries (the 5 above)
  into a clean `origin/main` copy of the lockfile rather than accepting
  npm's full regeneration, then validated with `rm -rf node_modules && npm
ci && npm run build -w @loop/web`.
- **Bundle budget — tight, not broken**: `check:bundle-budget` passes
  (3296 KB vs. the 3300 KB `MAX_SSR_KB` ceiling — was 3240 KB before this
  PR). i18next's `~/i18n/locales/en/*.json` catalogs + the library itself
  land in their own Rollup-split chunk (`i18next-*.js`, ~48 KB / 15.82 KB
  gzip) rather than the root chunk, but `check-bundle-budget.sh` sums the
  **entire** `build/client/` directory regardless of chunk/lazy-load
  boundaries, so code-splitting doesn't reduce this metric — only shipping
  fewer bytes does. **This PR used 56 of the previous 60 KB of headroom.**
  The next tranche that adds meaningful catalog JSON (or any unrelated web
  PR that adds client bytes) is likely to need `MAX_SSR_KB` raised in
  `scripts/check-bundle-budget.sh` with a PR-body justification, per that
  script's own documented escape hatch. Flagged here rather than silently
  discovered by a future contributor's unrelated PR failing CI.
- **`i18n/t.ts` + `i18n/messages.ts` deleted.** Confirmed zero importers
  before deletion (`grep` across `apps/web/app`). The one test file that
  exercised them (`i18n/__tests__/locale.test.ts`'s `describe('t', ...)`
  block) is removed; that file's `format.ts` coverage (unrelated, still
  live) is untouched.
- **No RTL regression**: `getLangDir()` / `<html dir>` wiring is untouched;
  this PR only adds `i18n.changeLanguage()` alongside the existing
  `lang`/`dir` attribute sync in the same effect.
- **Docs**: this ADR, `docs/i18n.md` (new — "how to add a translatable
  string" / "how to add a language"), `AGENTS.md` docs index,
  `docs/adr/034-path-based-locale-routing.md`'s "i18n seam status" section
  (updated to point here instead of describing the retired scaffold),
  `docs/readiness-backlog-2026-07-03.md` B-6, `docs/go-live-plan.md` §T1-BS
  B-6.
