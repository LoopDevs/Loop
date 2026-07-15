# Native / device deferred items — implementation + device-QA handoff

Branch: `feat/native-device-items`. Covers the deferred native/device audit
items FE-01, AGT-11, FE-03, FE-04, FE-02, FE-55, P2-14. Each was written to
be correct-by-construction; the pieces that can only be _proven_ on a real
device/build are listed here with exact verification steps.

The Android native tree (`apps/mobile/android/`) is gitignored (ADR-007) —
every native change is an OVERLAY under `apps/mobile/native-overlays/`,
re-applied by `apps/mobile/scripts/apply-native-overlays.sh` after `cap sync`
and asserted by the CI `mobile-overlay-guard` job. To materialise the native
projects locally for QA:

```
cd apps/mobile
npx cap add android          # + npx cap add ios --packagemanager SPM
npx cap sync
./scripts/apply-native-overlays.sh
```

---

## FE-01 — Android FLAG_SECURE (block screenshots / screen-recording)

**Status: implemented.**

`task-switcher-overlay.ts` only blurred the iOS app-switcher snapshot and its
own comment said real screenshot prevention needs `FLAG_SECURE`. Now set
app-wide on the host Activity.

Files:

- `apps/mobile/native-overlays/android/app/src/main/java/io/loopfinance/app/MainActivity.java`
  — `getWindow().setFlags(FLAG_SECURE, FLAG_SECURE)` in `onCreate`.
- `apps/web/app/native/task-switcher-overlay.ts` — comment updated (Android
  now has real OS-level blocking; the JS overlay is now belt-and-braces on
  Android and the primary control on iOS).
- `.github/workflows/ci.yml` — overlay-guard step "Verify Android FLAG_SECURE
  screenshot block" greps the regenerated `MainActivity.java`.

Decision (needs your sign-off): **app-wide**, not per-screen. A single
Capacitor WebView means per-route toggling would need a custom
`setSecure(bool)` Capacitor plugin (JS↔native bridge) that can't be
device-verified in this pass. App-wide is the banking/crypto-app norm and the
safe default for a money app; the tradeoff is that a user also can't
screenshot a non-sensitive screen (e.g. a cashback offer to share). Flip to
per-screen later if product wants sharable screens.

iOS: there is **no** FLAG_SECURE equivalent — screenshots can't be blocked,
only detected after the fact. The existing task-switcher overlay covers the
app-switcher snapshot; a `UserDidTakeScreenshot` detect-and-warn listener
remains deferred (ADR-027).

Device QA (Android):

1. Open any authed screen (order receipt / gift-card code).
2. Press Power+VolDown to screenshot → expect a system toast "Can't take
   screenshot due to security policy" and no image saved.
3. Start a screen recording → the Loop frames record as black.
4. Open the recents/app-switcher → the Loop thumbnail is blank, not a live
   preview.

Device QA (iOS): confirm the app-switcher card is blurred (unchanged
behaviour); screenshots are NOT blocked (expected — OS limitation).

---

## AGT-11 — Android soft-keyboard focus + resize

**Status: implemented (two parts).**

Root cause of the audit finding was that the A11Y-019 `inert` on inactive
onboarding slides silently defeated the Brands→Email `.focus()` call: `next()`
only schedules the step change, so at the instant `.focus()` runs the email
slide is still `inert`, and focus on a descendant of an `inert` subtree is a
no-op — so Android never got the gesture-bound focus and the keyboard stayed
down.

Files:

- `apps/web/app/components/features/onboarding/Onboarding.tsx` — `goToEmail`
  now clears `inert` on the target slide (via a new `data-onboard-slide`
  marker) within the click gesture, before `.focus()`; React re-asserts the
  correct `inert` on the next render.
- `apps/mobile/scripts/apply-native-overlays.sh` — idempotent patch adds
  `android:windowSoftInputMode="adjustResize"` to the MainActivity
  `<activity>` so the window resizes and the focused input scrolls above the
  keyboard (complements `Keyboard.resize:'body'` in capacitor.config.ts).
- `.github/workflows/ci.yml` — overlay-guard asserts
  `windowSoftInputMode="adjustResize"` in the regenerated manifest.

Web-side unit coverage: existing onboarding suites still pass; the inert/focus
timing itself is only observable on-device.

Device QA (Android):

1. Onboarding → advance to the Brands screen → tap "Continue".
2. Expect the soft keyboard to raise automatically as the Email screen appears
   (previously it stayed down until a manual tap).
3. With the keyboard open on the Email + OTP screens, confirm the input and
   its label sit ABOVE the keyboard (window resized), not hidden behind it.

---

## FE-03 — served App-Link / Universal-Link association files

**Status: implemented (this was broken end-to-end).**

The native intent-filter + `App.entitlements` declare hosts
`loopfinance.io`, `www.loopfinance.io`, `beta.loopfinance.io` — and
Apple/Google fetch the verification file from **those exact hosts**. Those
hosts are served by `@loop/web` (react-router-serve, Fly app
`loopfinance-web`); the backend handler that builds the files
(`apps/backend/src/well-known/deep-link-verification.ts`) is reachable only at
`api.loopfinance.io`, so the verifiers were hitting the web app's SSR 404. The
package/team IDs and host list were all correct — the files were served at the
wrong origin.

Fix: serve byte-identical files from the web app at the marketing hosts.

Files:

- `apps/web/app/services/deep-link-association.ts` — pure builders + env
  gating, mirroring the backend handler exactly (same `io.loopfinance.app`
  bundle/package, same `WELL_KNOWN_NOT_CONFIGURED` 404, same
  `Cache-Control: public, max-age=300`).
- `apps/web/app/routes/well-known.assetlinks.tsx` — `GET /.well-known/assetlinks.json`.
- `apps/web/app/routes/well-known.apple-app-site-association.tsx` —
  `GET /.well-known/apple-app-site-association`.
- `apps/web/app/routes.ts` — registers both (SSR build only, like
  `sitemap.xml`; excluded from the mobile SPA build which rejects `loader`s).
- `apps/web/app/routes/__tests__/well-known.test.ts` — parity tests.

**Operator action required:** set the two PUBLIC env vars on the
`loopfinance-web` Fly app (not just the backend) so the web-served files
populate. They're an Apple Team ID and release-keystore SHA-256 fingerprints —
both intended to be public:

```
fly secrets set -a loopfinance-web APPLE_TEAM_ID=XXXXXXXXXX
fly secrets set -a loopfinance-web ANDROID_CERT_SHA256=AA:BB:...:ZZ   # comma-sep for debug+release
```

Until set, the routes 404 (correct pre-enrollment state). Cross-checked: the
host list matches `.github/workflows/ci.yml` (`loopfinance.io`,
`www.loopfinance.io`, `beta.loopfinance.io`) and `App.entitlements`
`applinks:` hosts + the Android intent-filter data hosts.

Alternative to env-duplication (your call): a Cloudflare (ADR-040) rewrite of
`/.well-known/apple-app-site-association` + `/.well-known/assetlinks.json` on
the marketing hosts to the backend origin, or a proxy loader. I chose direct
web-served files because OS verifiers are unforgiving and infrequent, so no
runtime web→backend coupling is the most robust.

Local smoke test:

```
cd apps/web && npm run build && npm start
curl -i localhost:3000/.well-known/assetlinks.json   # 404 until ANDROID_CERT_SHA256 set
ANDROID_CERT_SHA256='AA:BB:CC' npm start
curl -s localhost:3000/.well-known/assetlinks.json   # array with package io.loopfinance.app
APPLE_TEAM_ID=ABCDE12345 npm start
curl -s localhost:3000/.well-known/apple-app-site-association   # appID ABCDE12345.io.loopfinance.app
```

Device QA:

- Android: install the release build, tap a `https://loopfinance.io/...` link
  from another app → opens Loop directly (not Chrome). Debug with
  `adb shell pm get-app-links io.loopfinance.app` → the hosts should show
  `verified`. Requires the release keystore fingerprint in
  `ANDROID_CERT_SHA256`.
- iOS: install via TestFlight, long-press a `https://loopfinance.io/...` link →
  "Open in Loop". Apple's CDN caches the AASA; use a fresh install. Requires
  `APPLE_TEAM_ID`.

---

## FE-04 — TLS certificate pinning for the API host

**Status: scaffolded + documented, deliberately INERT (ADR-027 defers).**

ADR-027 §"SSL / cert pinning" is an **accepted Phase-1 deferral** (re-accepted
2026-06-16): TLS rides the system trust store today; the Phase-2 trigger is
"first confirmed MITM in prod telemetry OR enterprise requirement", neither
fired. An active `<pin-set>` with a wrong/placeholder digest would brick every
API call the moment the pinned cert rotates — a self-inflicted outage. So the
control is written as a ready-to-activate, one-uncomment recipe, not switched
on.

Files:

- `apps/mobile/native-overlays/android/app/src/main/res/xml/network_security_config.xml`
  — a fully-commented `<domain-config>` / `<pin-set>` template for
  `api.loopfinance.io` with the exact `openssl` SPKI-digest command, the
  ADR-027 Phase-2 strategy (pin the **intermediate CA**, not the rotating
  leaf), a mandatory **backup pin**, and an expiration.

**Decision needed from you to ACTIVATE (all four):**

1. This is an ADR-027 Phase-2 call — confirm a trigger has fired first.
2. Pin strategy: intermediate-CA SPKI (recommended, survives leaf rotation) —
   run the `openssl` command in the file against `api.loopfinance.io`.
3. Always ship ≥2 pins (primary + backup key) or a rotation bricks the app.
4. iOS has no `network_security_config`: pinning there is a native spike —
   `URLSessionDelegate` SPKI pinning or TrustKit in a small Capacitor plugin.
   Note the WKWebView traffic does NOT flow through `URLSession`, so iOS
   pinning only covers the app's `fetch()` path unless the WebView is also
   intercepted.

Device QA (once activated, Android): run an mitmproxy with a user-installed
root CA. BEFORE = API requests succeed through the proxy (MITM works). AFTER =
API requests fail with a cert-validation error (the pin rejects the proxy
cert). Legit direct traffic still succeeds.

---

## FE-02 — app-lock on foreground (biometric/PIN)

**Status: implemented — reverses a documented design decision, needs QA
sign-off.**

The existing `registerAppLockGuard` was cold-start-only by deliberate design
(M-5 deferred resume-relock). The FE-02 audit flagged cold-start-only as the
gap: a phone left unlocked on a desk / handed over / picked up minutes later
exposes every already-visible balance and gift-card code with no re-gate. Added
a foreground re-lock, reconciled with the original "don't be hostile on brief
switches" concern via a grace window.

Files:

- `apps/web/app/native/app-lock.ts` — on Capacitor `pause` record the time; on
  `resume`, if app-lock is enabled and the app was backgrounded ≥
  `FOREGROUND_RELOCK_AFTER_MS` (60s), re-run the lock check (overlay +
  biometric prompt). Still opt-in (same `APP_LOCK_KEY`), still not a purchase
  gate, listeners disposed on cleanup.
- `apps/web/app/native/__tests__/app-lock.native.test.ts` — re-locks after
  > 60s background; does NOT re-lock on a 5s switch; stops after cleanup.

To revert to cold-start-only: set `FOREGROUND_RELOCK_AFTER_MS = Infinity` (or
drop the resume listener) — the cold-start path is untouched. Off-by-default
and the read-fails-open behaviour of `isAppLockEnabled` are unchanged (an
opt-in, off-by-default feature that can't read its own preference should not
lock; flag if you want that hardened).

Device QA:

1. Enable app-lock in onboarding (biometric step) or settings.
2. Background the app > 60s, return → biometric/passcode prompt appears over a
   splash-styled overlay before content is visible.
3. Background the app ~5s, return → NO prompt (grace window).
4. Disable app-lock → no prompt in either case.
5. Cold start with app-lock on → prompt as before (unchanged).

---

## FE-55 — user feedback when biometric auth fails

**Status: implemented.**

The onboarding biometric step reset silently on a failed/cancelled prompt (ring
back to idle, no message) and the footer CTA only ever re-fires the prompt, so
a user whose biometrics kept failing had no signal and no way off the step.

Files:

- `apps/web/app/components/features/onboarding/screen-biometric.tsx` — a
  `failed` state now shows a red "Couldn't verify" status + a
  `role="alert"` explanation, and a "Skip for now" escape that advances without
  enabling app-lock. Cleared on a new attempt / on leaving the step.
- `apps/web/app/i18n/locales/en/onboarding.json` — `biometric.status.failed`,
  `biometric.sub.failed`, `biometric.skip`.

Device QA:

1. Onboarding → biometric step → tap Enable, then FAIL the prompt (wrong
   finger a few times / cancel).
2. Expect a red "Couldn't verify" + "We couldn't confirm your Face ID. Tap
   Enable to try again, or skip for now." (announced to a screen reader).
3. "Skip for now" advances past the step (app-lock stays disabled). Tapping the
   footer CTA again re-tries and clears the error.

---

## P2-14 — min-app-version force-update gate

**Status: implemented.**

Files:

- Backend `apps/backend/src/config/handler.ts` — `/api/config` now returns
  `minSupportedVersion: { ios, android }`.
- Backend `apps/backend/src/env/sections/core.ts` — new
  `MIN_SUPPORTED_APP_VERSION_IOS` / `MIN_SUPPORTED_APP_VERSION_ANDROID`.
- Backend `apps/backend/src/openapi/health.ts` — schema updated;
  `apps/backend/src/config/__tests__/handler.test.ts` — coverage.
- Web `apps/web/app/services/config.ts` + `hooks/use-app-config.ts` — type +
  fail-open default (`{ios:null, android:null}`).
- Web `apps/web/app/utils/version.ts` (+ test) — numeric-dotted compare that
  fails open on a blank/malformed floor.
- Web `apps/web/app/components/ForceUpdateGate.tsx` — native-only blocking
  screen with a store CTA; compares `X-Client-Version`
  (`VITE_CLIENT_VERSION` from package.json) against the platform floor.
- Web `apps/web/app/root.tsx` — gate wraps all three native branches
  (restoring / onboarding / shell) so it supersedes every route including
  onboarding.

**Source of truth: the server** (`MIN_SUPPORTED_APP_VERSION_*` env on the
backend). Raising the floor is a config change, no app-store resubmission. The
client never decides its own minimum. Web is never gated (served fresh). Unset
= no gate (pre-launch default). Fails open on config outage / parse error.

**Decision needed:** the iOS store link uses a placeholder
(`APP_STORE_APP_ID = ''` in `ForceUpdateGate.tsx`, currently opens an App Store
search). Fill the numeric App Store ID at App Store Connect setup (L1-7). The
Android link is a direct Play Store URL keyed on `io.loopfinance.app`.

Device QA:

1. Build with `VITE_CLIENT_VERSION` e.g. `0.3.0`.
2. Set `MIN_SUPPORTED_APP_VERSION_ANDROID=0.4.0` (or `_IOS`) on the backend.
3. Cold-start the native app → the non-dismissible "Update Loop to continue"
   screen replaces the app; the CTA opens the store.
4. Set the floor to `0.3.0` (or unset) → the app loads normally.
5. Confirm the OTHER platform's floor is independent (an iOS floor doesn't gate
   Android and vice-versa), and that web (loopfinance.io) is never gated.
6. Point the client at a backend with `/api/config` unreachable → app still
   loads (fails open).

---

## Test / lint status (this branch)

- `npm run typecheck -w @loop/web` — pass. `-w @loop/backend` — pass.
- Web: `well-known`, `version`, `app-lock.native`, full `onboarding` suites —
  pass. Backend: `config/handler`, `env`, `openapi-*`, `deep-link-verification`
  — pass.
- ESLint on every changed file — clean.
- `apply-native-overlays.sh` — `bash -n` clean; the new AGT-11
  `windowSoftInputMode` python patch verified against a representative
  Capacitor v8 manifest (correct placement, well-formed XML, idempotent guard).
- CI `mobile-overlay-guard` gains two assertions (FLAG_SECURE, adjustResize);
  the full job (`cap add` + apply + assert) needs CI/Android SDK and is the
  final proof the overlays survive a scratch regeneration.
