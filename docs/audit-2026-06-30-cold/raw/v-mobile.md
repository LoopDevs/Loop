# Vertical Mobile/native — raw findings

Files examined: 67/67 tracked source/config/doc files in scope (47 `apps/mobile/**` +
18 `apps/web/app/native/**`, two of which overlap with the explicit binary-asset
carve-out granted in the brief — see Coverage confirmation). Plus 12 supporting
files read for cross-reference (ADRs, docs, security-headers, root.tsx, eslint
config, package.json files) — listed in full at the bottom.

## Findings

### M-01 [P1 · LIVE (claimed-closed) · GATED (pre-store-submission)] Sign in with Apple's popup-mode JS-SDK flow is very likely non-functional inside the native Capacitor WebView — CF-27's "zero mobile changes needed" verdict is wrong

- File: `apps/web/app/components/features/auth/AppleSignInButton.tsx:104-125` (popup init/redirectURI), `apps/web/app/utils/security-headers.ts:70-104` (COOP/frame-src wiring), `apps/web/app/root.tsx:257-289` (meta-tag CSP path, all other headers dropped for mobile), `apps/mobile/native-overlays/android/app/src/main/java/io/loopfinance/app/MainActivity.java` (no `WebChromeClient.onCreateWindow` override), `apps/mobile/native-overlays/ios/` (no `WKUIDelegate`/`CAPBridgeViewController` subclass anywhere)
- Description: `AppleSignInButton` calls Apple's JS SDK (`appleid.auth.js`) with `usePopup: true` and `redirectURI: window.location.origin`. This relies on three things, none of which hold inside Loop's native shell:
  1. **`window.open()` support.** Apple's popup mode calls `window.open()` to spawn a second browser context pointed at `appleid.apple.com`, which later calls `window.opener.postMessage(...)` to hand the authorization result back. Capacitor iOS's default `CAPBridgeViewController` implements `webView(_:createWebViewWith:for:windowFeatures:) -> WKWebView?` by returning `nil` (confirmed via Capacitor's own source/issue tracker — `ionic-team/capacitor#798`), so `window.open()` silently does nothing unless the app subclasses `CAPBridgeViewController` and overrides that delegate method. `apps/mobile/native-overlays/ios/` contains zero Swift/ObjC source — only asset/plist/privacy-manifest overlays — so no such override exists. Capacitor Android's `MainActivity.java` overlay (this repo) only overrides `setOverScrollMode`; Android `WebView`'s default `WebChromeClient.onCreateWindow` also does nothing and returns `false` unless explicitly overridden with `setSupportMultipleWindows(true)` + a real `onCreateWindow` implementation — also absent here.
  2. **A registrable Apple "Return URL."** `redirectURI: window.location.origin` evaluates at runtime to `capacitor://localhost` on iOS (Capacitor's default `iosScheme`) and `https://localhost` on Android (Capacitor's default `androidScheme`; `capacitor.config.ts` overrides neither). Apple's Sign In with Apple Service ID configuration requires HTTPS Return URLs on a domain Apple can verify ownership of via a hosted `apple-developer-domain-association.txt`. Neither `capacitor://localhost` nor a bare `https://localhost` is registrable/verifiable this way.
  3. **`Cross-Origin-Opener-Policy: same-origin-allow-popups`.** `security-headers.ts:99-104` adds this header specifically — the comment literally cites CF-27 — "so the Sign in with Apple popup... keeps its `window.opener` reference." But `root.tsx:257-289` only emits `Content-Security-Policy` via `<meta http-equiv>` for the mobile static export (the only directive that can be meta-tag-delivered); COOP, CORP, X-Frame-Options, HSTS, and Permissions-Policy are dropped with a comment claiming they're "applied at the deploy edge" — there is no deploy edge for a Capacitor app loading `index.html` from local device storage. So even on a hypothetical platform where `window.open()` worked, the one header purpose-built to keep `window.opener` alive for this exact flow never reaches the native binary.
- Impact: ADR-014's rollout checklist marks "Sign in with Apple button... rendered on web and native" as `[x]` done, and states "Native Google is intentionally hidden; native users get Apple + email-OTP." If Apple sign-in doesn't actually complete on native (button renders, tap does nothing — `handleClick` has no loading state or timeout, so the failure mode is a silently-dead button, not even a visible error), native users are left with **email-OTP only**, not the two-path coverage the ADR and the CF-27 commit message claim. This also undermines the premise of the delta-manifest's claim that "apps/mobile genuinely needed zero changes" — the fix is incomplete for the platform Apple's App Store Guideline 4.8 actually targets (the native binary, not the web build).
- Evidence: Capacitor iOS default `createWebViewWith` → `nil` (ionic-team/capacitor source + issue #798); Android `WebChromeClient.onCreateWindow` default → no-op/`false` (Android WebView API docs); independent prior-art reports that `appleid.auth.js`'s `AppleID.auth.signIn()` "will not open an Apple login window" when run inside a Cordova/Capacitor WebView, and that the `redirectURI` isn't recognized in that context (developer forum reports, confirmed via web search during this audit — see Sources below); `apps/web/app/components/features/auth/__tests__/AppleSignInButton.test.tsx` stubs `window.AppleID` directly and never exercises the real SDK's `window.open`/postMessage path, so CI cannot catch this class of failure.
- Minimal fix: Manually verify the native flow on a real iOS + Android device/simulator before treating CF-27 as closed for native. If broken (expected): switch `AppleSignInButton` to `usePopup: false` (redirect mode) on native only, routed through the existing `app/native/webview.ts` in-app-browser helper with a registered real-HTTPS return URL that bounces back into the app via a custom URL scheme / universal link Capacitor's `App` plugin already listens for (`appUrlOpen`). On Android, alternatively add a `WebChromeClient.onCreateWindow` override to `MainActivity.java` (same pattern as the existing overscroll override) and a matching iOS `CAPBridgeViewController` subclass, plus register a real HTTPS return URL (not `capacitor://localhost`).
- Better fix: Replace the JS-SDK approach on native with a true native Sign-In-with-Apple Capacitor plugin (`ASAuthorizationAppleIDProvider`-backed), wired through `app/native/` per the existing Capacitor-plugin-boundary convention (`eslint.config.js`'s `no-restricted-imports` group already supports adding a new `@aparajita/*`-style or first-party plugin there). This is the path the audit brief anticipated ("Sign in with Apple capability/entitlement registration") — it requires adding the "Sign In with Apple" capability + `com.apple.developer.applesignin` entitlement to the iOS native project (a new `App.entitlements` overlay + `apply-native-overlays.sh` step, mirroring exactly how `NSFaceIDUsageDescription` is enforced today) and an Android Credential Manager / system-browser flow for native Google parity (already deferred per ADR-014's M-02 — bundle the two fixes). Add a native smoke test (manual QA checklist item, or a Playwright run against a real device farm) since the unit-test boundary used elsewhere in this codebase cannot reach this bug class.

### M-02 [P2 · LIVE · doc-integrity] `docs/mobile-native-ux.md` "Current overlays" table covers 3 of ~15 real overlay actions — undermines the documented mitigation ADR-007 relies on

- File: `docs/mobile-native-ux.md:113-123` vs `apps/mobile/scripts/apply-native-overlays.sh` (392 lines, full script)
- Description: ADR-007 (native-projects-source-of-truth) explicitly names this doc's "Native-config overlays" section as the mitigation for the native trees being gitignored/unversioned ("Manual pre-release checks captured in `docs/mobile-native-ux.md` §Native-config overlays"). The table there lists only `backup_rules.xml`, `data_extraction_rules.xml`, and `Info.plist.additions.txt` (the original A-033/A-034 items). The actual script additionally applies, with no doc-table entry at all: `file_paths.xml` FileProvider scoping (A2-1213, a real attack-surface reduction — removes external-storage access, scopes cache access to `share/`), `network_security_config.xml` cleartext-traffic lockdown (A4-079, closes a localhost-MITM class), the `MainActivity.java` overscroll override, all launcher-icon/splash assets (Android mipmaps + drawables, iOS AppIcon/Splash imagesets), `signing.gradle` + `keystore.properties.example` release-signing wiring, Android `ACCESS_COARSE_LOCATION`/`ACCESS_FINE_LOCATION` permissions, iOS `NSLocationWhenInUseUsageDescription`, iOS `release.xcconfig` (A2-1201, pins `CAPACITOR_DEBUG=false`), and iOS `PrivacyInfo.xcprivacy`. `docs/deployment.md`'s signing/cert-expiry table (lines 468-481) is more current (covers A2-1213, release.xcconfig, NSFaceIDUsageDescription) but still omits `network_security_config.xml`, `PrivacyInfo.xcprivacy`, and the location-permission entries.
- Impact: A reviewer following the doc ADR-007 names as the audit trail for "what config must survive `cap sync`" would not learn that two real security-hardening overlays (cleartext lockdown, FileProvider scoping) exist, and has no checklist row to confirm they're still present in a built APK/IPA before shipping.
- Evidence: `apply-native-overlays.sh` lines 54-389 vs `docs/mobile-native-ux.md:113-123`.
- Minimal fix: Update the table to list every overlay action the script performs (one row per file/permission/attribute it touches).
- Better fix: Stop hand-maintaining a duplicate table; either point the doc at the script's own inline comments as the single source of truth, or add a `scripts/lint-docs.sh` check that diffs the overlay-target paths referenced in `apply-native-overlays.sh` against the doc table (same parity-gate pattern already used for `env.ts` ↔ `.env.example`).

### M-03 [P3 · LIVE · doc-truthfulness] Privacy-manifest rationale and App Store metadata both misidentify Sentry/Stellar as native iOS pods

- File: `apps/mobile/native-overlays/ios/App/App/PrivacyInfo.xcprivacy:6-10`, `docs/app-store-connect-metadata.md:237-242`
- Description: `PrivacyInfo.xcprivacy`'s header comment says "Capacitor + Sentry + Stellar pods ship their own `PrivacyInfo.xcprivacy` entries declaring their plugin-level API usage... Apple aggregates them at archive time, so this manifest deliberately leaves `NSPrivacyAccessedAPITypes` empty." `docs/app-store-connect-metadata.md`'s "Third-Party SDKs" section names the SDK as `@sentry/capacitor`. Neither is accurate: the only Sentry dependency anywhere in the monorepo is `@sentry/react` (`apps/web/package.json:35`, confirmed — no `@sentry/capacitor` in `apps/mobile/package.json` or `apps/web/package.json`), a pure-JS SDK that runs inside the WKWebView's JS context and is never compiled as a native CocoaPod/SPM target, so there is no Sentry-authored privacy manifest for Xcode to aggregate. `@stellar/stellar-sdk` is an `apps/backend`-only dependency (Node.js) — it is never bundled into the mobile client at all, so "Stellar pods" don't exist in this project either. The only genuine native pods are Capacitor core + its plugins (`@aparajita/*`, `@capgo/inappbrowser`, etc.).
- Impact: Low operational risk (the actual declared data types still look plausible), but the stated reasoning is false, and it has a real consequence: crash/performance data is only ever captured for in-WebView JS exceptions, never true native (Swift/ObjC-level WKWebView host process) crashes — worth being an explicit, intentional posture rather than an artifact of a wrong assumption. It also means the "Apple aggregates them at archive time" operator note (which correctly flags a real manual-verification step for Capacitor's plugins) is diluted by also pointing at two SDK families that were never relevant.
- Evidence: `apps/web/package.json:35` (`@sentry/react` only); no `@sentry/capacitor` anywhere; `apps/backend/package.json:29` (`@stellar/stellar-sdk` backend-only, absent from both `apps/web/package.json` and `apps/mobile/package.json`).
- Minimal fix: Correct both files — name `@sentry/react` (JS-only, no native pod, no manifest to aggregate) and drop the Stellar SDK claim entirely.
- Better fix: If true native-crash visibility (catching host-process crashes outside the WebView's JS context) is wanted, that's a real product decision — evaluate adding `@sentry/capacitor` under the repo's "new dependency → ADR" rule (AGENTS.md doc-update-rules table), not a docs-only fix.

### M-04 [P3 · GATED (Phase 2, already partially tracked) · dead-code/completeness] Push-notification channel setup runs on every native boot with no registration, no backend token storage, and no iOS push entitlement staged

- File: `apps/web/app/native/notifications.ts`, `apps/web/app/root.tsx:406-409`, `apps/mobile/capacitor.config.ts:20-22`, `apps/mobile/native-overlays/ios/` (no entitlements file)
- Description: `@capacitor/push-notifications` is declared (correctly paired, mobile + web `package.json`) and `capacitor.config.ts` configures `presentationOptions`. `setupNotificationChannels()` runs on every Android native cold boot and creates two notification channels ("orders", "general"), but nothing in the codebase ever calls `PushNotifications.requestPermissions()` or `.register()`, or registers an `addListener('registration', ...)` handler to capture and forward a device token. A repo-wide grep for `push.token` / `pushToken` / `push_token` in `apps/backend/src` and `apps/web/app` returns only `notifications.ts` itself — there is no backend endpoint to store a token and no send-side integration. On Android 13+, the OS-level `POST_NOTIFICATIONS` runtime permission is never requested, so channel creation is moot — no notification can ever display even if one were sent. No iOS Push Notifications capability / `aps-environment` entitlement file exists anywhere under `native-overlays/ios/` (unlike `NSFaceIDUsageDescription`, which has a dedicated, audited overlay step). This gap is honestly tracked as an open Phase-2 item in `docs/mobile-native-ux.md:30,91` ("end-to-end flow... is Phase 2"), so it is not a silently-missed feature, but the channel-creation side effect currently ships for zero benefit, and `docs/deployment.md`'s signing-asset table already tracks an "iOS Push (APNs) Auth Key" and "FCM Server Key" as operator-maintained credentials ahead of the code actually using them.
- Impact: Low today (matches the documented Phase-2 deferral, no privacy-manifest inaccuracy since no token is ever collected). Flagging because: (a) the dead channel-creation code is unexplained side-effect noise on every cold boot, and (b) when this ships, the iOS capability/entitlement step is a real native-side requirement that isn't staged anywhere in the overlay system yet, unlike every other audited iOS requirement in this repo.
- Evidence: `grep -rn "PushNotifications" apps/web/app` → only `notifications.ts`; `grep -rln "push.token|pushToken|push_token"` across `apps/backend/src` + `apps/web/app` → only `notifications.ts`; no `.entitlements` file under `apps/mobile/native-overlays/`.
- Minimal fix: Either remove `setupNotificationChannels()` until the rest of the flow ships, or add a one-line comment at the call site in `root.tsx` explicitly noting it's an intentional pre-warm with the rest of the flow deferred (so a future reader doesn't assume push is live).
- Better fix: Finish the wire-up — `requestPermissions()` + `register()` + `addListener('registration', ...)` POSTing the token to a new authenticated endpoint, a `user_push_tokens` table, and a Discord-style notifier hook on order-status transitions; add an `App.entitlements` overlay (Push Notifications capability + `aps-environment`) applied by `apply-native-overlays.sh` the same way `NSFaceIDUsageDescription` is, and request `POST_NOTIFICATIONS` at runtime on Android 13+.

### M-05 [P2 · LIVE · re-confirmed carry-over, independently re-verified] Privacy/app-lock overlays still paint below Navbar dropdown z-order

- File: `apps/web/app/native/task-switcher-overlay.ts:36` (`z-index:99999`), `apps/web/app/native/app-lock.ts:84` (`z-index:99998`), `apps/web/app/components/features/Navbar.tsx:53,314` (`z-[999999]`)
- Description: Flagged in the prior (2026-06-15) audit as M-06; independently re-verified now via direct grep rather than trusted forward — still true as of this audit's HEAD. The task-switcher privacy overlay (blur-on-`pause`, for the iOS task-switcher snapshot) and the cold-start app-lock overlay both use a lower z-index (99999 / 99998) than the Navbar's open dropdown menus (999999). If a dropdown is open when the app backgrounds or when the cold-start lock check fires, the dropdown paints over the privacy/lock overlay instead of being covered by it.
- Impact: A task-switcher snapshot could capture the contents of an open menu instead of the intended blur; the lock overlay could be visually (not functionally — biometric gate still fires) bypassed by an open dropdown sitting on top of it. Low real-world likelihood (menus are usually closed when backgrounding), unchanged severity assessment from the prior pass — still open, not addressed by this delta's commits (none of the 22 commits touch these files).
- Evidence: `grep -n "z-index\|z-\[" apps/web/app/native/{task-switcher-overlay,app-lock}.ts apps/web/app/components/features/Navbar.tsx` — values unchanged since the prior audit.
- Minimal fix: Raise the two native-overlay z-indexes above the app's max app-level z-index (e.g. `2147483646`).
- Better fix: Same numeric fix, plus close any open transient menus on the Capacitor `pause` event (the privacy overlay module already listens for `pause`; have it also dispatch a "close all menus" signal) so the underlying DOM state is consistent with what's visually hidden, not just visually covered.

### M-06 [P3 · LIVE · informational/confirmed-correct] Capacitor plugin import-boundary and version-parity controls are intact — no findings, documented for completeness

- File: `eslint.config.js:101-126`, `apps/mobile/package.json`, `apps/web/package.json`
- Description: Verified (not assumed) that `no-restricted-imports` covers `@capacitor/*`, `@aparajita/capacitor-*`, and `@capgo/*` and is scoped to `apps/web/app/**` excluding `apps/web/app/native/**`. A repo-wide grep for those import specifiers outside `app/native/` returned zero hits. Plugin versions are pinned identically between `apps/mobile/package.json` and `apps/web/package.json` for every plugin that has JS-side call sites (the mobile-only deps — `@capacitor/android`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/splash-screen` — are correctly absent from `apps/web/package.json` since nothing in `app/native/` calls the splash-screen plugin programmatically; it's config-only via `capacitor.config.ts`). Secure-storage migration (`secure-storage.ts`, `purchase-storage.ts`) correctly handles the Preferences→SecureStorage one-shot migration with test coverage in both directions (`native-modules.test.ts`, `secure-storage-native.test.ts`). No remediation needed; recorded so this audit doesn't silently skip the dimension.

## Delta re-verification

**CF-27/CF-36 zero-mobile-file-change claim — split verdict:**

- **CF-36 (ADR-027 sideload-trigger decision): genuinely complete with zero mobile-file changes.** This is a pure policy/ADR decision (re-accepting the Phase-1 binary-tamper-detection deferral given the controlled pre-launch sideload audience) — there is no code path it could touch; the only artifact is the ADR text update, which landed correctly in `docs/adr/027-mobile-platform-security.md`'s "2026-06-16 trigger review" section. Confirmed accurate and reasoned.
- **CF-27 (Sign in with Apple): the "zero mobile changes needed" claim is incorrect.** See M-01 above. The commit message's premise ("Apple's own JS SDK runs in the Capacitor WKWebView, so this button is rendered on web AND native") conflates "the script loads and the button renders" with "the sign-in flow completes." Three independent, mutually reinforcing technical gaps — `window.open()` unsupported by Capacitor's default WebView delegates on both platforms (no native code added to fix this), an unregistrable `redirectURI` (`capacitor://localhost` / `https://localhost`), and a COOP header that's purpose-built for this exact flow but architecturally cannot reach the mobile static export (meta-tag CSP only; no deploy edge for a locally-loaded bundle) — make it very likely the button is a no-op on a real device. This is exactly the missed native-side requirement the audit brief asked to check for, though the form it takes (WebView popup/redirect-URI plumbing, not a missing entitlement) differs from the brief's example list. Recommend re-opening CF-27 for the native platform specifically and verifying on a real device before considering it closed there.

## Coverage confirmation

`apps/mobile/**` (47 tracked files — all read in full; binary PNGs and the
17 generated/animated splash XMLs in `native-overlays/android/.../drawable/`
confirmed via `apply-native-overlays.sh`'s copy logic + inline comments per
the brief's explicit carve-out, not opened as binaries):

- `apps/mobile/capacitor.config.ts` — read
- `apps/mobile/package.json` — read
- `apps/mobile/README.md` — read
- `apps/mobile/scripts/apply-native-overlays.sh` — read in full
- `apps/mobile/native-overlays/android/app/signing.gradle` — read
- `apps/mobile/native-overlays/android/app/src/main/java/io/loopfinance/app/MainActivity.java` — read
- `apps/mobile/native-overlays/android/app/src/main/res/values/styles.xml` — read
- `apps/mobile/native-overlays/android/app/src/main/res/values/ic_launcher_background.xml` — read
- `apps/mobile/native-overlays/android/app/src/main/res/xml/backup_rules.xml` — read
- `apps/mobile/native-overlays/android/app/src/main/res/xml/data_extraction_rules.xml` — read
- `apps/mobile/native-overlays/android/app/src/main/res/xml/file_paths.xml` — read
- `apps/mobile/native-overlays/android/app/src/main/res/xml/network_security_config.xml` — read
- `apps/mobile/native-overlays/android/keystore.properties.example` — read
- `apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_{bloom,draw,drop,fade,scale,slide,wipe}.xml` (7) + `splash_icon_vector.xml` — purpose confirmed via script + styles.xml comments, not opened (generated animation assets, non-functional/non-security content)
- `apps/mobile/native-overlays/android/app/src/main/res/drawable/{splash.png,splash_icon.png}` — binary, confirmed via script (carve-out)
- `apps/mobile/native-overlays/android/app/src/main/res/mipmap-{m,h,x,xx,xxx}dpi/ic_launcher{,_round,_foreground}.png` (12) — binary, confirmed via script (carve-out)
- `apps/mobile/native-overlays/ios/App/App/Info.plist.additions.txt` — read
- `apps/mobile/native-overlays/ios/App/App/PrivacyInfo.xcprivacy` — read in full
- `apps/mobile/native-overlays/ios/release.xcconfig` — read
- `apps/mobile/native-overlays/ios/App/App/Assets.xcassets/AppIcon.appiconset/{Contents.json,AppIcon-512@2x.png}` — Contents.json is an Xcode asset-catalog manifest (low audit value, format confirmed via apply script), PNG binary — carve-out
- `apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/{Contents.json,splash-2732x2732{,-1,-2}.png}` — same carve-out as above

`apps/web/app/native/**` (18 tracked files — all read in full):

- `platform.ts`, `app-lock.ts`, `back-button.ts`, `biometrics.ts`, `clipboard.ts`, `haptics.ts`, `keyboard.ts`, `network.ts`, `notifications.ts`, `purchase-storage.ts`, `secure-storage.ts`, `share.ts`, `status-bar.ts`, `task-switcher-overlay.ts`, `webview.ts`
- `__tests__/app-lock.native.test.ts`, `__tests__/native-modules.test.ts`, `__tests__/secure-storage-native.test.ts`

Supporting cross-reference files read in full:

- `docs/audit-2026-06-30-cold/checklist.md`
- `docs/audit-2026-06-15-cold/checklist.md`
- `docs/audit-2026-06-30-cold/delta-manifest.md`
- `docs/adr/006-keychain-backed-secure-storage.md`
- `docs/adr/007-native-projects-source-of-truth.md`
- `docs/adr/008-capacitor-filesystem-for-share.md`
- `docs/adr/014-social-login-google-apple.md`
- `docs/adr/027-mobile-platform-security.md`
- `docs/mobile-native-ux.md`
- `docs/app-store-connect-metadata.md`
- `docs/log-policy.md`
- `docs/deployment.md` (Mobile section, lines 400-490)
- `apps/web/app/components/features/auth/AppleSignInButton.tsx`
- `apps/web/app/components/features/auth/__tests__/AppleSignInButton.test.tsx`
- `apps/web/app/utils/security-headers.ts`
- `apps/web/app/root.tsx` (native-lifecycle wiring section + CSP/meta-tag section)
- `apps/web/app/routes/auth.tsx` (button gating, grep-confirmed)
- `eslint.config.js`
- `apps/web/package.json`, `apps/backend/package.json` (dependency cross-check)

Sources consulted for the WebView/window.open technical claims (M-01):

- [Capacitor `CAPBridgeViewController.swift`](https://github.com/ionic-team/capacitor/blob/main/ios/Capacitor/Capacitor/CAPBridgeViewController.swift) and [issue #798](https://github.com/ionic-team/capacitor/issues/798) — default `createWebViewWith` returns `nil`
- [Android `WebChromeClient` reference](https://developer.android.com/reference/android/webkit/WebChromeClient) — default `onCreateWindow` behavior
- Apple Developer Forums threads on WKWebView OAuth popup / `window.opener` behavior (`developer.apple.com/forums/thread/664267`, `/thread/759487`)
- Ionic Forum / npm `cordova-plugin-sign-in-with-apple` discussion of `appleid.auth.js` failing inside Cordova/Capacitor WebViews
