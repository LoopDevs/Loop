# Vertical Web UI browse/discovery — raw findings

Files examined: 76/76 (every file enumerated in the brief, including `__tests__`
siblings; see Coverage confirmation at the bottom)

## Findings

### WUI-01 [P1 · LIVE] `useFocusTrap`'s tabbable-selector bug lets Tab escape the dialog whenever the dialog contains roving-tabindex children (CountrySelector + MapBottomSheet)

- File: `apps/web/app/hooks/use-focus-trap.ts:51-56` (root cause); consumers in my
  scope: `apps/web/app/components/features/CountrySelector.tsx:121-219`,
  `apps/web/app/components/features/MapBottomSheet.tsx:62-67,122-230`
- Description: `tabbables()` queries
  `'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'`.
  This is a CSS selector **union** (logical OR) — an element matches if _any_
  branch matches. A `<button role="radio" tabIndex={-1}>` matches
  `button:not([disabled])` (it's a button, not disabled) regardless of its
  `tabindex` value; the `[tabindex]:not([tabindex="-1"])` exclusion only
  applies to elements that _only_ match that final branch (e.g. a bare
  `<div tabindex="0">`), it does not retroactively filter elements already
  matched via the button/input/select/textarea/anchor branches. So
  `tabbables()` incorrectly **includes** every non-disabled
  button/input/select/textarea/anchor that carries an explicit
  `tabindex="-1"` — exactly the shape every roving-tabindex radio group in
  this app uses (`useRadioGroupKeys`'s `rovingTabIndex()` returns `0 | -1`).
  The trap then computes `last = focusable[focusable.length - 1]`, which
  becomes one of these bogus tabindex=-1 elements instead of the dialog's
  true last _naturally_ tabbable element. The Tab-wrap check
  (`if (activeEl === last) { …wrap… }`) therefore never fires when focus is
  actually on the real last tabbable element, so the browser's native Tab
  behaviour takes over uninterrupted and focus leaks out of the modal.
- Impact: This is the exact "focus escapes the modal" class of bug that the
  06-15 audit's A11Y-004 (CountrySelector) and A11Y-005 (MapBottomSheet)
  findings were written against, and that CF-35 (commit `5dfce00d`) was
  supposed to close by introducing `useFocusTrap`. The fix closes the
  _literal-absence-of-a-trap_ case but reopens the same user-facing failure
  mode via this selector bug, for any dialog whose content includes a roving
  radiogroup:
  - **CountrySelector**: DOM order is search input → close button → `<ul>` of
    `<li><button role="option" tabIndex={-1}>` (one per country, ~23+).
    `tabbables()` includes all of them, so `last` becomes the last visible
    country option, not the close button. Tabbing forward from the close
    button (the real last reachable control) is never intercepted — Tab
    leaves the modal into the page behind the `bg-black/40` backdrop.
  - **MapBottomSheet**: its content is `PurchaseContainer`, which renders a
    `role="radiogroup"` payment-rail picker via `useRadioGroupKeys` with
    `tabIndex={railKeys.rovingTabIndex(i)}`
    (`apps/web/app/components/features/purchase/PurchaseContainer.tsx:421-423`).
    Same mechanism — Tab from the sheet's true last control can escape onto
    the map underneath, on the screen that gates the purchase flow.
  - This is invisible to the existing hook unit test
    (`apps/web/app/hooks/__tests__/use-focus-trap.test.tsx`) because its
    fixture only uses plain `<button>`s with no `tabIndex` attribute at all
    — it never exercises the roving-tabindex shape that both real consumers
    actually use.
- Evidence: selector text at `use-focus-trap.ts:53`; `CountrySelector.tsx:201`
  (`tabIndex={-1}` on every option button); `PurchaseContainer.tsx:421-423`
  (`role="radio"` + `tabIndex={railKeys.rovingTabIndex(i)}`); test fixture at
  `use-focus-trap.test.tsx:9-19` has zero `tabIndex` props on any button.
- Minimal fix: filter on the IDL `tabIndex` property instead of relying on
  the selector to encode the exclusion: change
  `Array.from(nodes).filter(isVisible)` to
  `Array.from(nodes).filter((el) => isVisible(el) && el.tabIndex !== -1)` in
  `tabbables()`. One line, robust against this exact selector pitfall, and
  doesn't require touching every selector branch.
- Better fix (if different): same fix — this is already the idiomatic
  approach (the `element.tabIndex` getter returns the _effective_ tab index,
  correctly resolving `-1` regardless of which selector branch matched it).
  Pair it with extending the hook's own unit test fixture to include a
  `tabIndex={-1}` roving-radio button so this class of regression is caught
  next time, since both real consumers hit it and the current fixture
  doesn't.

### WUI-02 [P1 · GATED (behind `LOOP_PHASE_1_ONLY`)] Onboarding's global arrow-key page-navigation collides with the currency picker's radiogroup arrow-key navigation — selecting a currency with arrow keys silently skips the screen without saving

- File: `apps/web/app/components/features/onboarding/Onboarding.tsx:179-188`
  (global handler) interacting with
  `apps/web/app/components/features/onboarding/screen-currency.tsx:67-101`
  (`useRadioGroupKeys`'s `onKeyDown`, via
  `apps/web/app/hooks/use-radio-group-keys.ts:43-76`)
- Description: `Onboarding.tsx` attaches a `window`-level, bubble-phase
  `keydown` listener that advances/retreats the step on `ArrowRight`/
  `ArrowLeft`, guarded only by `document.activeElement instanceof
HTMLInputElement || HTMLTextAreaElement`. The currency-picker radios are
  `<button role="radio">` elements, not inputs, so they don't trip that
  guard. `useRadioGroupKeys`'s `onKeyDown` (wired to each radio button) calls
  `e.preventDefault()` on `ArrowRight`/`ArrowLeft` but **never calls
  `e.stopPropagation()`**. `preventDefault()` only cancels the keypress's
  default browser action; it does not stop the event from continuing to
  bubble. React's synthetic delegated listener (root container, bubble
  phase) fires first as the event bubbles through the tree, then the event
  continues bubbling out to the native `window` listener, which also fires.
  Net effect: pressing `ArrowRight` while focused on a currency radio both
  (a) moves the radio selection to the next currency (correct radiogroup
  behaviour) **and** (b) advances the onboarding step to the next screen
  (the global handler's `next()`).
- Impact: The CTA that actually persists the choice
  (`handleCurrencyCta` → `setHomeCurrency(currency)`,
  `Onboarding.tsx:241-257`) only fires from the "Continue" button click —
  arrow-key navigation never reaches it. A keyboard user who arrows through
  the three currency options to land on, say, GBP, and is then _bounced
  forward_ to the next screen by the same keypress, never has their
  selection POSTed to `/api/users/me/home-currency`. The user believes they
  picked GBP (the radio shows it selected, `aria-checked="true"`); the
  account's actual home currency stays whatever `useState` initialised it to
  (browser-locale/country-cookie guess) — since `home_currency` is described
  elsewhere in this codebase as locked after the first order and changeable
  only via support, this is a real, hard-to-recover, money-adjacent UX bug,
  not just a cosmetic one. Currently dormant: `LOOP_PHASE_1_ONLY=true` (the
  documented production default — `AGENTS.md` confirms `phase1Only` hides
  "onboarding currency picker") makes `Onboarding.tsx`'s direction-aware
  skip-effect (`Onboarding.tsx:351-359`) bypass step 5 unconditionally, so no
  user reaches this screen today. It will fire the moment Phase 2 ships
  unless fixed first.
- Evidence: `Onboarding.tsx:180-188` (`if (active instanceof
HTMLInputElement || active instanceof HTMLTextAreaElement) return;` — no
  exclusion for `role="radio"` buttons); `use-radio-group-keys.ts:43-76`
  (`e.preventDefault()` present, `e.stopPropagation()` absent on every
  branch). The existing regression test for the skip-effect
  (`onboarding-skip-nav.test.tsx`) explicitly blurs focus before every
  synthetic arrow press (`pressArrow()` helper, lines 67-70) specifically to
  avoid hitting an input — it never exercises an arrow press while focus is
  on a radio button, so this gap isn't covered.
- Minimal fix: add `e.stopPropagation()` alongside the existing
  `e.preventDefault()` in `useRadioGroupKeys`'s `onKeyDown` for the
  Arrow/Home/End branches (`use-radio-group-keys.ts:66`, right after the
  `switch`). This is also the right fix for the _other_ `useRadioGroupKeys`
  consumer in the purchase flow (`PurchaseContainer.tsx`), which would have
  the identical problem if it ever sits inside a component with its own
  page-level arrow-key handling.
- Better fix (if different): same one-line fix is already best practice —
  a component-local keyboard handler that mutates its own widget state
  should always stop the event from being reinterpreted by an ancestor's
  page-level shortcut handler. Additionally, `Onboarding.tsx`'s global
  handler could defensively check for `role="radio"`/`role="option"`/
  `[role][aria-expanded]` on `document.activeElement` as defense-in-depth,
  but that's a weaker, more bypassable fix than fixing the source.

### WUI-03 [P2 · LIVE] Navbar's search-results dropdown is keyboard-tabbable, breaking the `aria-activedescendant` combobox pattern (and likely auto-closing on Tab)

- File: `apps/web/app/components/features/Navbar.tsx:56-68` (`SearchDropdown`
  option `<button>`), vs. the correct pattern at
  `apps/web/app/components/features/CountrySelector.tsx:196-211`
  (`tabIndex={-1}` on the equivalent option button)
- Description: `SearchBar` implements an ARIA 1.2 combobox: the `<input>`
  carries `role="combobox"` and `aria-activedescendant`, and arrow keys move
  a virtual `selectedIndex` (`Navbar.tsx:205-224`) rather than moving real
  DOM focus — this is the correct pattern, and `CountrySelector`'s
  equivalent listbox gets it right by setting `tabIndex={-1}` on every
  `role="option"` button (so DOM focus never leaves the search input).
  `Navbar.tsx`'s `SearchDropdown` option buttons (`Navbar.tsx:56-65`) have no
  `tabIndex` prop at all, so they default to the native tabbable `0` for a
  `<button>` element. A keyboard user who presses Tab while the dropdown is
  open (e.g. after typing a query, before pressing Enter) moves real DOM
  focus from the search `<input>` into the first result button — at which
  point `aria-activedescendant` on the (now-blurred) input is meaningless,
  and the input's own `onBlur={() => setTimeout(() => setOpen(false), 200)}`
  (`Navbar.tsx:204`) starts a 200ms countdown to close the whole dropdown
  out from under the just-focused button.
- Impact: keyboard users who Tab instead of using arrow keys through the
  navbar's brand search (the primary cross-site search surface, present on
  every desktop/tablet route) get an inconsistent, possibly self-closing
  dropdown — a different and worse keyboard experience than the
  near-identical `CountrySelector` listbox a few files over.
- Evidence: `Navbar.tsx:56-65` (no `tabIndex` on the `<button>`); compare
  `CountrySelector.tsx:196-211` (`tabIndex={-1}` explicitly set on the
  identical option-button pattern).
- Minimal fix: add `tabIndex={-1}` to the `SearchDropdown` option `<button>`
  at `Navbar.tsx:60`, matching `CountrySelector`.
- Better fix (if different): same fix; could also add `Home`/`End` key
  support to `SearchBar`'s `onKeyDown` (`Navbar.tsx:205-224`) to match
  `CountrySelector`'s listbox keyboard contract (currently only
  ArrowUp/ArrowDown/Enter/Escape).

### WUI-04 [P2 · LIVE, delta-introduced] `useAllMerchants`'s 30-min `staleTime` exceeds the (unset, default 5-min) `gcTime`, undermining the CF-29 cadence fix it shipped alongside

- File: `apps/web/app/hooks/use-merchants.ts:72-90`
- Description: commit `b17d0436` (CF-29 / PERF-003) widened `useAllMerchants`'s
  `staleTime` from 5 min to 30 min and disabled `refetchOnWindowFocus`, with
  the documented intent that the ~1,134-record catalog (per ADR 032: 1,134
  tiles → 982 brand groups) shouldn't re-download on routine navigation
  within a session. Neither this hook nor any global `QueryClient`
  default (checked `apps/web/app/root.tsx:96-107`) sets `gcTime`, so it
  stays at TanStack Query's default of 5 minutes. `gcTime` controls how long
  _inactive_ (zero-observer) cached data survives before eviction,
  independent of `staleTime`. Once every component consuming
  `['merchants-all']` unmounts for 5+ minutes (the query has zero
  observers), the cached catalog is garbage-collected outright — even though
  it's still "fresh" for up to 25 more minutes per the `staleTime` the CF-29
  fix just raised. The next mount has no cache to read and must issue a full
  network fetch + render a loading state, exactly the round-trip CF-29 was
  trying to avoid.
- Impact: narrower in practice than it looks, because `Navbar`'s
  always-mounted `SearchBar` (`Navbar.tsx:117`) and `MobileHome`
  (`use-merchants.ts` caller) both keep an observer on `['merchants-all']`
  across most routes, so the eviction window rarely opens. But any route
  stack where Navbar isn't rendered for 5+ continuous minutes (e.g. a user
  who lingers on `/onboarding`'s full-bleed flow, which renders its own
  chrome and not `Navbar`, while `TrustMerchants` — the one other
  `useAllMerchants` consumer reachable there — isn't on the active step)
  silently re-triggers the exact multi-hundred-KB refetch + main-thread JSON
  parse cost the fix was written to eliminate. This is a real but narrow
  exposure window; flagging because the inconsistency itself (`staleTime` >
  `gcTime`) is a textbook TanStack Query anti-pattern independent of how
  often it's hit, and the PR's own commit message/tests assert the
  `staleTime`/`refetchOnWindowFocus` values without checking `gcTime` at all
  (`use-merchants.test.tsx:108-130`).
- Evidence: `use-merchants.ts:86` (`staleTime: 30 * 60 * 1000`, no `gcTime`);
  `root.tsx:96-107` (global `defaultOptions.queries` sets `retry` and
  `staleTime: 5 * 60 * 1000` only, no `gcTime`); confirmed via
  `git show b17d0436` that the staleTime widening was the entire diff — no
  `gcTime` companion change.
- Minimal fix: add `gcTime: 30 * 60 * 1000` (or longer) alongside
  `staleTime` in `useAllMerchants` (`use-merchants.ts:86`), so cache
  eviction can never undercut the staleness window.
- Better fix (if different): same fix, generalized — audit every hook in
  this file (and the codebase) for the `gcTime >= staleTime` invariant
  rather than patching this one call site; consider setting a sane
  `gcTime` floor in the global `QueryClient` `defaultOptions.queries`
  (`root.tsx:96-107`) so future hooks don't have to remember the pairing.

### WUI-05 [P2 · LIVE-but-orphaned] `CashbackStatsBand` / `FlywheelStatsBand` are fully built, fully tested, and never mounted anywhere — and still hardcode `en-US` formatting

- File: `apps/web/app/components/features/home/CashbackStatsBand.tsx`,
  `apps/web/app/components/features/home/FlywheelStatsBand.tsx`
- Description: repo-wide grep (`grep -rn "CashbackStatsBand\|FlywheelStatsBand"`
  across the entire tree, not just `apps/web`) finds these two exported
  components referenced **only** in their own definition files and their own
  test files — zero importers in any route, layout, or other component. They
  are home-page "social proof" bands (`<section aria-label="Loop cashback
totals">` / `aria-label="Loop flywheel stats"`) backed by real, working
  public endpoints (`getPublicCashbackStats`, `getPublicFlywheelStats`), with
  thorough unit tests (`CashbackStatsBand.test.tsx`,
  `FlywheelStatsBand.test.tsx`), but nothing in the app renders them. They
  are dead code in the sense that matters — no user ever sees them — despite
  representing real backend + frontend engineering investment.
  Independently, both also hardcode locale-naive formatting that directly
  contradicts the project's own "one format seam" policy
  (`apps/web/app/i18n/format.ts`'s header comment, written for CF-22):
  `CashbackStatsBand.tsx:75,87` and `FlywheelStatsBand.tsx:47` call
  `.toLocaleString('en-US')` directly instead of routing through
  `useLocaleTag()` + `formatNumber()`, and `CashbackStatsBand.tsx:2,14`
  imports `formatMinorCurrency` from `@loop/shared` directly — the
  locale-naive version `format.ts`'s own doc comment explicitly warns
  against ("Use this — not the shared one with a hardcoded 'en-US' default —
  wherever a user-facing money figure renders"). This exact file:line
  combination (`CashbackStatsBand:82,87,93`, `FlywheelStatsBand:47`) was
  already flagged in the 06-15 audit as part of cluster finding WEB-I1; the
  CF-22 commit (`da067648`) fixed the _other_ files in that cluster
  (`OrdersSummaryHeader` per the delta-manifest's changed-file list) but
  never touched these two — they were missed, not deliberately deferred.
- Impact: Two-part. (1) Dead code: two real public API integrations + UI
  components + tests exist with zero return on the engineering investment;
  if intentionally shelved this should be a documented decision (ADR/roadmap
  note), not a silent gap discovered by grep. (2) The i18n bug is real but
  currently inert — since nothing renders these components, no visitor
  actually sees `1,234` instead of a German `1.234` — so wiring them up
  _without_ also fixing the locale calls would immediately reintroduce a
  live WEB-I1-class regression.
- Evidence: repo-wide grep showing zero non-test, non-self importers (see
  Delta/Coverage notes below for the exact commands run); `format.ts`'s own
  header comment naming the anti-pattern these two files use.
- Minimal fix: either wire `CashbackStatsBand`/`FlywheelStatsBand` into
  `routes/home.tsx` (or `MobileHome.tsx`) where the social-proof framing
  belongs, fixing the `toLocaleString('en-US')` → `formatNumber(value,
useLocaleTag())` and the `@loop/shared` import → `~/i18n/format`'s
  `formatMinorCurrency` wrapper at the same time; or, if the marketing
  decision is to not ship these yet, delete them (and their backend
  endpoints, if otherwise unused) or move them behind an explicit flag with
  a one-line comment explaining the deferral, so the next agent doesn't
  have to rediscover "are these live?" from scratch.
- Better fix (if different): same as minimal — there's no value in a
  "better" fix distinct from just closing the loop (wire up + fix locale, or
  remove).

### WUI-06 [P3 · LIVE, still open] `FixedSearchButton.tsx` remains fully orphaned dead code

- File: `apps/web/app/components/features/FixedSearchButton.tsx`
- Description: zero importers anywhere in the repo (confirmed by repo-wide
  grep, not just `apps/web`); no test file. Independently re-confirms the
  06-15 audit's WEB-Q1 finding ("Zero importers anywhere... Fully styled,
  never mounted") — unchanged across this delta, created in PR #289 and
  never touched since (`git log --follow` shows a single commit). Likely
  superseded by `MobileHome.tsx`'s own inline collapsible search input
  (`MobileHome.tsx:286-335`), which duplicates the same "icon → expands to
  input" interaction this component implements standalone.
- Impact: maintenance noise — a fully-functional, accessible (proper
  `aria-label`s on both states) component sitting unused, at risk of bit-rot
  (e.g. it wasn't touched by CF-35's a11y pass, so it's untested against the
  current focus-trap/locale conventions other live surfaces now follow).
- Evidence: repo-wide grep finds only the definition file's own two
  identifier occurrences (the interface and the function declaration).
- Minimal fix: delete the file.
- Better fix (if different): if there's a planned use (e.g. a future
  search-first browse mode), wire it into a route and give it the same
  CF-35-era a11y review (focus management, touch-target sizing — its close
  button is 28px, under the 44px target the project otherwise pins for) as
  every other live interactive surface received.

### WUI-07 [P3 · LIVE] `components/ui/index.ts` barrel remains orphaned

- File: `apps/web/app/components/ui/index.ts`
- Description: every real consumer of the `ui/` primitives imports directly
  from the specific file (`~/components/ui/Button`, `~/components/ui/Card`,
  etc. — 18+ files do this); grep for `from '~/components/ui'` (the barrel's
  own import path, no trailing segment) matches only the barrel file itself.
  Re-confirms this was already true before this delta (no commits to this
  file in the delta-manifest's changed-file list).
- Impact: low — it's harmless dead weight, not a correctness bug, but it's
  the kind of "this should be the single import surface" file whose
  existence implies a convention nobody follows, which invites future
  confusion about which import style is canonical.
- Evidence: `grep -rln "from '~/components/ui'"` (no further path segment)
  across `apps/web/app` returns only `components/ui/index.ts` itself.
- Minimal fix: delete it, or pick one direction and enforce it (e.g. an
  ESLint rule requiring the barrel import) — leaving it as an unused,
  silently-divergent convention is the actual problem.
- Better fix (if different): if keeping it, add an `eslint-plugin-import`
  `no-restricted-imports` rule (mirroring the existing Capacitor-boundary
  pattern in this same codebase) that requires `~/components/ui` imports to
  go through the barrel, so the file actually does something.

### WUI-08 [P2 · LIVE] `MobileHome`'s directory grid renders the full filtered/grouped catalog with no virtualization or pagination

- File: `apps/web/app/components/features/home/MobileHome.tsx:160-183,
358-378`
- Description: `grid` (all enabled, country-filtered merchants when the
  search box is empty) and `groupedGrid` (ADR 032 brand-grouped) are
  computed with `useMemo` but rendered in full via `groupedGrid.map(...)`
  into a plain `grid grid-cols-2` CSS grid — every card mounts as a real DOM
  subtree (image, two badge spans, favourite button, title) simultaneously.
  Per ADR 032's own numbers (1,134 merchant tiles → 982 brand groups), an
  unfiltered visit to the mobile home tab mounts on the order of several
  hundred `DirectoryCell`/`DirectoryGroupCell` components in one pass, with
  no windowing (`react-window`/`react-virtual`), no "load more"/pagination,
  and no IntersectionObserver-gated incremental reveal. `LazyImage` mitigates
  _image_ network cost via `loading="lazy"`, but does nothing for DOM node
  count, layout, or initial paint cost — those scale linearly with however
  many merchants are enabled in the user's country.
- Impact: this is the default landing experience for every native/mobile-web
  visitor (it's the `MobileHome` tab, not an opt-in deep page), so the cost
  is paid on essentially every cold load. On lower-end Android hardware
  (the documented test target per `project_ctx_media_pipeline`/mobile-polish
  history elsewhere in this repo) a several-hundred-node grid mount + layout
  is a plausible jank/INP source, and will only get worse as the catalog
  grows past ~1,134.
- Evidence: `MobileHome.tsx:358-378` (`groupedGrid.map(...)`, no slicing/
  windowing); ADR 032 cites "1,134 tiles → 982 groups" as the current scale.
- Minimal fix: cap the initial unfiltered render (e.g. first 60-100 groups)
  with a "show more" affordance, matching the pattern many catalog apps use
  for a directory landing grid; the search path can stay full-scan since a
  query already narrows the result set.
- Better fix (if different): adopt a virtualization library
  (`@tanstack/react-virtual` pairs naturally with the rest of the TanStack
  stack already in use) for the grid so DOM node count stays bounded to the
  viewport regardless of catalog size, removing the need to choose an
  arbitrary cap.

### WUI-09 [P3 · LIVE] `MerchantCard`'s denomination-range currency symbol ignores the route locale

- File: `apps/web/app/components/features/MerchantCard.tsx:22-70`
  (`renderDenominationRange`, `currencySymbol(denominations.currency)` call
  at line 28)
- Description: `currencySymbol(currency, locale?)`
  (`apps/web/app/i18n/format.ts:94-105`) defaults to `'en'` when no locale is
  passed — `MerchantCard.tsx` never imports `useLocaleTag()` and calls
  `currencySymbol(denominations.currency)` with no second argument. This is
  the one money-adjacent string on every merchant card (every directory grid,
  every brand page, every favourites/recently-purchased strip — i.e. the
  single most-rendered component in this vertical) that doesn't thread the
  ADR 034 route locale, unlike the sibling `formatMinorCurrency`/`formatMoney`
  calls used elsewhere in this same scope (e.g. `MobileHome.tsx`'s
  `ActivityRow`). `format.ts`'s own doc comment calls out the concrete case
  this matters for: "`CAD` renders `'$'` under `en-CA` but `'CA$'` under
  `en-US`" — a CAD-denominated merchant viewed under a non-`en-CA` locale
  (the default, since no locale is passed) won't get the disambiguating
  `CA$` prefix.
- Impact: low-severity inconsistency (most currency symbols don't vary by
  locale), but it's a clear miss against CF-22's stated "one format seam"
  goal, on the single highest-traffic component in the browse surface.
- Evidence: `MerchantCard.tsx:1-9` (no `useLocaleTag` import);
  `MerchantCard.tsx:28` (`currencySymbol(denominations.currency)`, no second
  arg); `format.ts:94-105` (the locale param + its CAD example).
- Minimal fix: `const locale = useLocaleTag();` in `MerchantCard`, thread it
  into `renderDenominationRange(merchant.denominations, locale)` and the
  `currencySymbol(currency, locale)` call inside it.
- Better fix (if different): same fix; no further design needed.

### WUI-10 [P3 · LIVE] `MobileHome`'s "Recent activity" timestamps ignore the route locale

- File: `apps/web/app/components/features/home/MobileHome.tsx:674-758`
  (`ActivityRow`, `formatWhen`)
- Description: `ActivityRow` receives a `locale` prop and correctly threads
  it into `formatMoney(amount, currency, locale)` (lines 725, 732), but
  `formatWhen(createdAt)` (called with no locale argument at line 696) always
  calls `d.toLocaleTimeString(undefined, …)` / `d.toLocaleDateString(undefined,
…)` — `undefined` resolves to the browser/runtime's default locale, not the
  route's. This is the one date-formatting call in this vertical's scope and
  it's the odd one out relative to the money formatting right next to it in
  the same component.
- Impact: cosmetic — a `/de/en` or `/fr/fr` visitor sees "Today · 3:45 PM"
  English AM/PM formatting on their recent-orders list instead of a
  locale-correct 24-hour rendering, inconsistent with the money figure one
  line below it which _does_ localise correctly.
- Evidence: `MobileHome.tsx:696` (`formatWhen(createdAt)`, no locale arg);
  `MobileHome.tsx:740-758` (`new Date().toLocaleTimeString(undefined, …)`).
- Minimal fix: pass `locale` through to `formatWhen(createdAt, locale)` and
  use it in both `toLocaleTimeString`/`toLocaleDateString` calls.
- Better fix (if different): add a small `formatRelativeDay(date, locale)`
  helper to `i18n/format.ts` (out of this vertical's direct edit scope, but
  the natural home for it per that file's own "single seam" charter) so any
  future "Today/Yesterday/weekday" relative-date need in the app reuses one
  locale-correct implementation instead of each caller hand-rolling it.

### WUI-11 [P3 · LIVE] `MapBottomSheet` has no `key` tied to the selected merchant, so internal drag/focus-trap-setup state doesn't reset when the user taps a different pin without closing the sheet first

- File: `apps/web/app/routes/map.tsx:66-70` (caller, out of this vertical's
  edit scope but the symptom lives in my file) +
  `apps/web/app/components/features/MapBottomSheet.tsx:26-67`
- Description: `routes/map.tsx` renders `{selectedMerchant !== null && <MapBottomSheet
merchant={selectedMerchant} onClose={handleClose} />}` with no
  `key={selectedMerchant.id}`. `ClusterMap`'s mobile marker-click handler
  (`ClusterMap.tsx:270-291`) calls `onMerchantSelectRef.current?.(merchantId)`
  unconditionally on every marker tap, including while a different
  merchant's sheet is already open and visible (the sheet only covers the
  bottom ~2/3 of the viewport, per its own comments) — so
  `selectedMerchantId` can transition directly from one merchant's id to
  another's without ever passing through `null`. Because there's no `key`,
  React reuses the same `MapBottomSheet` component instance across that
  transition: it doesn't unmount/remount, so `useFocusTrap`'s one-shot setup
  effect (`active` is the literal `true`, so its dependency array never
  changes) does not re-run its "stash previously-focused element + move
  focus to the close button" logic for the newly-selected merchant.
- Impact: low in practice — `dragY` resets to 0 on every pointer-up
  regardless of outcome, so the drag offset can't visibly leak across a
  merchant switch, and `isClosing` can only be observed mid-transition in a
  narrow timing window. The concrete, reachable miss is the focus-trap setup
  not re-running: a screen-reader/keyboard user who switches merchants
  without closing the sheet keeps whatever focus position they had inside
  the _old_ merchant's `PurchaseContainer`, rather than being re-anchored to
  the new sheet's close button, which is a minor but real a11y regression
  for that specific interaction path.
- Evidence: `map.tsx:66-70` (no `key` prop); `MapBottomSheet.tsx:62-67`
  (`useFocusTrap({ active: true, … })` — literal, not a variable, so its
  setup effect runs exactly once per mount).
- Minimal fix: add `key={merchant.id}` to the `MapBottomSheet` element in
  `routes/map.tsx` so a merchant switch forces a clean remount (and
  therefore a fresh focus-trap setup + a fresh `PurchaseContainer`
  amount-selection state, which is arguably also a correctness improvement
  for the purchase flow itself).
- Better fix (if different): same fix — keying by id is the standard React
  idiom for "this prop change means semantically a new thing," no
  alternative needed.

### WUI-12 [P3 · LIVE] `nonce-context.ts` has no test file

- File: `apps/web/app/utils/nonce-context.ts`
- Description: every other file in my `utils/*` scope has a matching
  `__tests__/*.test.ts` sibling; this 30-line CSP-nonce React Context module
  is the one exception. Low risk given its size and simplicity (a
  `createContext`/`useContext` pair), but it's a security-adjacent file
  (feeds the strict-CSP `script-src 'nonce-…'` wiring per its own header
  comment) and the project's stated convention elsewhere is to test
  everything in this directory.
- Impact: minimal on its own; flagging for completeness since the brief
  asks for test-existence checks on every file.
- Evidence: `find apps/web/app/utils/__tests__` lists no
  `nonce-context.test.*`.
- Minimal fix: add a 5-line test asserting `useNonce()` returns `null`
  outside a Provider and the Provider's value otherwise.
- Better fix (if different): n/a — this is already the minimal-and-best fix.

### WUI-13 [P3 · LIVE] `Navbar`'s `AccountMenu` (`role="menu"`) lacks roving-tabindex / arrow-key navigation per the full ARIA menu pattern

- File: `apps/web/app/components/features/Navbar.tsx:259-351`
- Description: the dropdown correctly closes on outside-click/Escape/route
  change and uses `role="menu"`/`role="menuitem"`, but Tab simply walks
  through the menu items in document order (each is a real `<Link>`/
  `<button>`) rather than the ARIA menu spec's expected single-tab-stop +
  Up/Down arrow + typeahead model.
- Impact: low — Tab still reaches every item and Escape still closes the
  menu, so it's functionally usable, just not spec-perfect; less severe than
  the radiogroup gaps elsewhere in this vertical since there's no broken
  selection state, only a non-canonical keyboard model.
- Evidence: `Navbar.tsx:320-345` — `Link`/`button` items with no
  `tabIndex`/`onKeyDown` wiring beyond the browser's native Tab order.
- Minimal fix: leave as-is unless a future a11y pass specifically targets
  ARIA-menu conformance; the cost/benefit here is weak relative to WUI-01/02/03.
- Better fix (if different): if pursued, reuse the same `useRadioGroupKeys`-
  style roving-tabindex hook pattern already established in this codebase,
  adapted for a linear (non-circular, no "selection") menu.

### WUI-14 [P3 · LIVE] `Phase2Gate`'s `<main role="main">` carries a redundant explicit ARIA role

- File: `apps/web/app/components/Phase2Gate.tsx:30-33`
- Description: `<main>` already has an implicit ARIA role of `main`; the
  explicit `role="main"` attribute is redundant (harmless, but a lint-level
  nit — `eslint-plugin-jsx-a11y`'s `no-redundant-roles` would flag this).
- Impact: cosmetic only.
- Evidence: `Phase2Gate.tsx:30-33`.
- Minimal fix: drop `role="main"`, keep the `<main>` element.
- Better fix (if different): n/a.

## Positive findings (prior P0/P1s independently re-verified as fixed)

These were flagged P0/P1 in the 06-15 audit's `raw/x-a11y-i18n.md` (A11Y-005,
A11Y-004, A11Y-006, A11Y-007) and I verified them independently before
peeking at that file — worth recording so the next audit doesn't re-flag them
as still-open without checking:

- **A11Y-005 (MapBottomSheet — "no focus trap, backdrop role='button'
  tabIndex={-1} keyboard-unreachable, only dismissal is undiscoverable
  Escape")**: now has `role="dialog" aria-modal aria-label`, a real focusable
  `closeButtonRef` button, `useFocusTrap` wiring, and the backdrop is a
  presentational `<div onClick>` (not a fake keyboard-unreachable button).
  **Caveat: see WUI-01** — the trap itself has a latent escape bug via the
  `tabbables()` selector, so this is "the obvious failure mode fixed, a
  subtler one introduced," not a clean close.
- **A11Y-004 (CountrySelector — "no focus trap, no arrow-key navigation")**:
  now has `useFocusTrap`, full `aria-activedescendant` listbox keyboard
  support (Arrow/Home/End/Enter), and focus restore to the trigger on close
  — all independently verified via direct code read + the component's own
  test suite. **Same WUI-01 caveat applies.**
- **A11Y-006 (ClusterMap markers — "no accessible name, no role, no keyboard
  activation"; `zoomControl: false` removed keyboard zoom)**: now confirmed
  fixed — every marker (cluster and individual location) is created with
  `keyboard: true, title: <label>, alt: <label>` giving Enter/Space
  activation + an accessible name (`ClusterMap.tsx:188-193, 225-230`), and
  `zoomControl: true` is restored (`ClusterMap.tsx:424`).
- **A11Y-007 / A11Y-021 (currency-picker and payment-rail radiogroups — "every
  radio is a simultaneous tab stop, no arrow-key nav, color-only selected
  state")**: now fixed via the shared `useRadioGroupKeys` hook — real roving
  tabindex, Arrow/Home/End navigation, and a non-color checkmark glyph for
  the selected state (`screen-currency.tsx:124-146`). **Caveat: see WUI-02**
  — the fix is correct in isolation but collides with `Onboarding.tsx`'s
  page-level arrow-key handler because it doesn't stop propagation.
- **A11Y-019/A11Y-012 (inactive onboarding slides — "interactive children of
  `aria-hidden` slides remain tab-focusable")**: now fixed via the `inert`
  attribute on every non-active slide (`Onboarding.tsx:458-462`), which
  removes both AT-visibility and tab-focusability in one declarative
  attribute — confirmed correct.

## Delta re-verification

**`use-merchants.ts`** — CF-29/PERF-003 changed `useAllMerchants`'s
`staleTime` 5m→30m and `refetchOnWindowFocus` true→false (and made the same
`refetchOnWindowFocus` change to the paginated `useMerchants`). The cadence
intent itself is sound and matches the documented multi-hour catalog-sync
reality; the new issue is the `gcTime`/`staleTime` mismatch this widening
introduces (no companion `gcTime` bump) — see **WUI-04**. No other regression
found in this file; `useMerchantBySlug`/`useMerchant`/
`useMerchantCashbackRate`/`useMerchantsCashbackRatesMap` are unchanged by the
delta and look correct (trimmed-id guards against guaranteed-404s,
`shouldRetry` policy applied consistently).

**`screen-currency.tsx`** — this delta file itself is correct in isolation
(the `useRadioGroupKeys` wiring, roving tabindex, ARIA radiogroup semantics,
non-color selected indicator are all right, and the component's own test
suite, `screen-currency.test.tsx`, thoroughly covers its in-component
behaviour). The bug is an **interaction** bug between this file and its
parent `Onboarding.tsx` (pre-existing, unchanged-by-this-delta global
arrow-key handler) — see **WUI-02**. Not a regression within
`screen-currency.tsx` itself, but a regression in the combined system that
this delta's correct radiogroup-keyboard fix exposed (the radios didn't
handle Arrow keys at all before CF-35, so there was nothing to collide with
the page-nav handler).

## Coverage confirmation

All files read in full:

**`components/features/home/`** (6): `CashbackStatsBand.tsx`,
`FlywheelStatsBand.tsx`, `MobileHome.tsx`, `__tests__/CashbackStatsBand.test.tsx`,
`__tests__/FlywheelStatsBand.test.tsx`, `__tests__/SavingsHero.test.tsx`

**`components/features/onboarding/`** (11): `atoms.tsx`, `Onboarding.tsx`,
`OnboardingDesktop.tsx`, `screen-biometric.tsx`, `screen-currency.tsx`,
`screen-wallet-intro.tsx`, `screens-trust.tsx`, `signup-tail.tsx`,
`__tests__/onboarding-skip-nav.test.tsx`, `__tests__/screen-currency.test.tsx`,
`__tests__/screen-wallet-intro.test.tsx`

**`components/features/` (root, listed files + their tests)**:
`ClusterMap.tsx`, `CountrySelector.tsx`, `FavoritesStrip.tsx`,
`FavoriteToggleButton.tsx`, `FixedSearchButton.tsx`, `Footer.tsx`,
`MapBottomSheet.tsx`, `MerchantCard.tsx`, `MerchantGroupCard.tsx`,
`NativeBackButton.tsx`, `NativeTabBar.tsx`, `Navbar.tsx`,
`RecentlyPurchasedStrip.tsx`, `__tests__/CountrySelector.test.tsx`,
`__tests__/MerchantCard.test.tsx`, `__tests__/MerchantGroupCard.test.tsx`

**`components/ui/`** (18): `Avatar.tsx`, `BackToSite.tsx`, `Badge.tsx`,
`Button.tsx`, `Card.tsx`, `Container.tsx`, `index.ts`, `Input.tsx`,
`LazyImage.tsx`, `LocaleLink.tsx`, `LoopLogo.tsx`, `OfflineBanner.tsx`,
`PageHeader.tsx`, `Skeleton.tsx`, `Spinner.tsx`, `ToastContainer.tsx`,
`__tests__/LocaleLink.test.tsx`, `__tests__/PageHeader.test.tsx`

**`components/Phase2Gate.tsx`** (1)

**`hooks/`** (12 + 11 tests = 23): `query-retry.ts`, `use-admin-step-up.ts`,
`use-app-config.ts`, `use-auth.ts`, `use-favorites.ts`, `use-focus-trap.ts`,
`use-merchants.ts`, `use-native-platform.ts`, `use-orders.ts`,
`use-radio-group-keys.ts`, `use-recently-purchased.ts`,
`use-session-restore.ts`, `__tests__/query-retry.test.ts`,
`__tests__/use-admin-step-up.test.ts`, `__tests__/use-app-config.test.tsx`,
`__tests__/use-auth.test.tsx`, `__tests__/use-focus-trap.test.tsx`,
`__tests__/use-merchants.test.tsx`,
`__tests__/use-native-platform-hook.test.tsx`, `__tests__/use-orders.test.tsx`,
`__tests__/use-radio-group-keys.test.tsx`,
`__tests__/use-session-restore-a2-1150.test.tsx`,
`__tests__/use-session-restore.test.ts`

**`stores/`** (4 + 4 tests = 8): `admin-step-up.store.ts`, `auth.store.ts`,
`purchase.store.ts`, `ui.store.ts`, `__tests__/auth.store.test.ts`,
`__tests__/purchase.store.test.ts`, `__tests__/ui.store.ssr-safe.test.ts`,
`__tests__/ui.store.test.ts`

**`utils/`** (in-scope subset, 10 + 9 tests = 19; `locale.ts`,
`redeem-message.ts`, `security-headers.ts`, `sentry-lazy.ts` and their tests
excluded per brief — owned by the web-routes sibling): `admin-cache.ts`,
`error-messages.ts`, `format-stellar.ts`, `image.ts`, `nonce-context.ts`,
`query-error-reporting.ts`, `redeem-challenge-bar.ts`,
`sentry-error-scrubber.ts`, `sentry-scrubber.ts`, `share-image.ts`,
`__tests__/admin-cache.test.ts`, `__tests__/error-messages.test.ts`,
`__tests__/format-stellar.test.ts`, `__tests__/image.test.ts`,
`__tests__/query-error-reporting.test.ts`,
`__tests__/redeem-challenge-bar.test.ts`,
`__tests__/sentry-error-scrubber.test.ts`, `__tests__/sentry-scrubber.test.ts`,
`__tests__/share-image.test.ts` (no test for `nonce-context.ts` — see WUI-12)

**Cross-checked out-of-scope context** (read, not owned, to verify a
consumer-side bug; not counted toward the totals above):
`apps/web/app/i18n/format.ts`, `apps/web/app/root.tsx` (QueryClient defaults +
merchant-catalog cold-start cache), `apps/web/app/routes/map.tsx` (caller of
`MapBottomSheet`), `apps/web/app/components/features/purchase/
PurchaseContainer.tsx` + `LoopPaymentStep.tsx` (grep-only, to confirm the
roving-tabindex radiogroup shape that triggers WUI-01 inside
`MapBottomSheet`).

Total: 76 files read in full against the brief's enumeration (6 + 11 + 16 +
18 + 1 + 23 + 8 + 19 — note the root "13 named files + tests" group is listed
above as 16 to include its 3 test files explicitly).
