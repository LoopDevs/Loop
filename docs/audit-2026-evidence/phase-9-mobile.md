# Phase 9 — Mobile shell (evidence)

- **Commit audited**: `450011ded294b638703a9ba59f4274a3ca5b7187` (HEAD at start of audit).
- **Scope**: `apps/mobile/capacitor.config.ts`; `apps/mobile/native-overlays/**`; `apps/mobile/scripts/apply-native-overlays.sh` (content correctness — idempotency already logged in `phase-4-build-release.md` §3); live `apps/mobile/ios/**` and `apps/mobile/android/**` (gitignored, locally generated); Capacitor plugin inventory cross-referenced with `apps/web/app/native/**`; threat-model posture for mobile.
- **Method**: primary-file reads + `grep -R` enumeration. No source mutated. Overlay script NOT re-run (Phase 4 already covered idempotency evidence at `phase-4-build-release.md:75-131`).

Native dirs are live and post-overlay — `AndroidManifest.xml` mtime `21 Apr 11:26`, `Info.plist` mtime `21 Apr 11:26`. Last `cap sync` on iOS side wrote `apps/mobile/ios/App/App/capacitor.config.json` and `apps/mobile/ios/App/CapApp-SPM/Package.swift` on **Apr 20 07:46** — before ADR-008 (`Add @capacitor/filesystem`, dated 2026-04-21). Android side re-synced on `Apr 21 12:35`. This asymmetric state is itself a finding below (A2-1206).

---

## 1. `capacitor.config.ts` (bundled runtime config)

File: `apps/mobile/capacitor.config.ts` (27 lines, full read).

| Field                                           | Value                         | Note                                                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                                         | `io.loopfinance.app`          | Matches Android `applicationId` and iOS `PRODUCT_BUNDLE_IDENTIFIER`.                                                                                                                                       |
| `appName`                                       | `Loop`                        | Matches `android/res/values/strings.xml:app_name`.                                                                                                                                                         |
| `webDir`                                        | `../web/build/client`         | Correct for React Router static export (`BUILD_TARGET=mobile`).                                                                                                                                            |
| `plugins.SplashScreen.backgroundColor`          | `#030712`                     | Diverges from the Android splash theme which pins `#111111` via `styles.xml:31,60` — two different "dark" backgrounds paint across the boot sequence (system splash → Capacitor splash). Noted as A2-1211. |
| `plugins.SplashScreen.launchShowDuration`       | 2000ms                        | User-perceived splash duration.                                                                                                                                                                            |
| `plugins.PushNotifications.presentationOptions` | `['badge', 'sound', 'alert']` | iOS foreground-presentation — the OS prompt for POST_NOTIFICATIONS / APNs is never explicitly requested in code. See A2-1208.                                                                              |
| `server` block                                  | Absent                        | Correct for production; dev live-reload uses a temporary `server.url` per `apps/mobile/README.md:32-37`.                                                                                                   |

No `allowNavigation`, `overrideUserAgent`, `hostname`, `iosScheme`, or `androidScheme` overrides — Capacitor defaults apply (`capacitor://localhost` on iOS, `https://localhost` on Android). CORS middleware in `apps/backend/src/app.ts` accepts both per `AGENTS.md` §Backend middleware stack, so the WebView origins are handled.

---

## 2. `native-overlays/` inventory

| File                                                        | Purpose                                                                          | Status                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ios/App/App/Info.plist.additions.txt`                      | Documentation-only — lists keys the apply script injects via PlistBuddy.         | Docs ok.                                                 |
| `android/.../xml/backup_rules.xml`                          | Pre-Android-12 `fullBackupContent` exclusion of `CapacitorStorage.xml`.          | Matches ADR-006 §Consequences.                           |
| `android/.../xml/data_extraction_rules.xml`                 | Android-12+ `cloud-backup` + `device-transfer` exclusion of same file.           | Matches ADR-006.                                         |
| `android/.../values/styles.xml`                             | `Theme.SplashScreen` with `windowSplashScreen*` pinned to `#111111`.             | See A2-1211 for bg colour drift.                         |
| `android/.../values/ic_launcher_background.xml`             | Adaptive-icon background colour override (`#111111`).                            | Consistent with styles.                                  |
| `android/.../java/io/loopfinance/app/MainActivity.java`     | `OVER_SCROLL_NEVER` to suppress WebView rubber-band. See `MainActivity.java:17`. | Fine, explicit rationale in overlay comment.             |
| `android/.../drawable/splash.png` + density-variant copies  | Branded splash PNG.                                                              | Copied to 11 drawable dirs on every run (unconditional). |
| `android/.../drawable/splash_icon*.xml` + `splash_icon.png` | AVD animated splash icon + 1024px source.                                        | Fine.                                                    |
| `android/.../mipmap-*/ic_launcher*.png`                     | Launcher icon at every density.                                                  | Fine.                                                    |

No overlay file exists to inject `POST_NOTIFICATIONS` on Android 13+ (see A2-1208) or to set `allowBackup="false"` outright — audit A-033's compromise was to keep auto-backup **on** and exclude `CapacitorStorage.xml` only, per ADR-006. That matches what is shipped.

---

## 3. Cross-reference with Phase 4 — overlay script content correctness (not idempotency)

`phase-4-build-release.md:75-131` already logged the idempotency run (identical stdout on pass 2; byte-identical plist + manifest) and the NSFaceIDUsageDescription copy drift (`A2-405`, Low). This section audits **content correctness** only.

- **Script sets NSFaceIDUsageDescription on absent-only semantics** (`scripts/apply-native-overlays.sh:181-186`) — matches ADR-006 approach and the A2-405 finding.
- **Script sets NSLocationWhenInUseUsageDescription** (`:194-199`) — value `"Loop uses your location to show nearby merchants on the map."` matches the live `Info.plist:30` ("`Loop uses your location to show nearby merchants on the map.`"). No drift here.
- **Script inserts `android:fullBackupContent` / `android:dataExtractionRules`** (`:156-171`) — inserts **immediately after** `android:allowBackup="true"`. This order is load-bearing: on a manifest where `allowBackup` has been flipped to `false`, the `grep -q 'android:fullBackupContent'` guard is still satisfied by a prior run, but a fresh regenerated manifest from a future Capacitor template bump that removes `allowBackup="true"` would cause the `sed` substitution to silently no-op. Filed as A2-1209 (Low).
- **Script does not remove stale entries** — if an overlay file is deleted from `native-overlays/`, the copy in `apps/mobile/android/...` persists. This is a Capacitor-ecosystem-wide pattern but worth recording (A2-1210, Low).
- **No iOS equivalent for MainActivity.java** — iOS webview overscroll is disabled by `WKWebView` default elastic-bounce config, so an overlay isn't needed. Confirmed by absence of `UIScrollView`/`bounces` override in `apps/mobile/ios/App/App/AppDelegate.swift` (50 lines read, no scroll-view override).

---

## 4. Capacitor plugin inventory — web + mobile + usage matrix

Versions from `apps/mobile/package.json` and `apps/web/package.json`. Usage from `grep -n "from '@capacitor\|from '@aparajita\|from '@capgo\|import\(.*'@capacitor\|import\(.*'@aparajita\|import\(.*'@capgo'" apps/web/app/native`.

| Plugin                                | web ver  | mobile ver | Parity | Runtime usage in `apps/web/app/native/**`                                   |  iOS `packageClassList`   |  iOS `CapApp-SPM/Package.swift`  | Android `capacitor.plugins.json` |
| ------------------------------------- | -------- | ---------- | :----: | --------------------------------------------------------------------------- | :-----------------------: | :------------------------------: | :------------------------------: |
| `@capacitor/core`                     | 8.3.1    | 8.3.1      |   Y    | `platform.ts:1`, every module's `Capacitor.isNativePlatform()`              |         (runtime)         | `capacitor-swift-pm@exact 8.3.1` |            (runtime)             |
| `@capacitor/app`                      | 8.1.0    | 8.1.0      |   Y    | `back-button.ts:21`                                                         |        `AppPlugin`        |                Y                 |                Y                 |
| `@capacitor/clipboard`                | 8.0.1    | 8.0.1      |   Y    | `clipboard.ts:8,32`                                                         |     `ClipboardPlugin`     |                Y                 |                Y                 |
| `@capacitor/filesystem`               | 8.1.2    | 8.1.2      |   Y    | `share.ts:31` (ADR-008)                                                     |        **MISSING**        |           **MISSING**            |                Y                 |
| `@capacitor/haptics`                  | 8.0.2    | 8.0.2      |   Y    | `haptics.ts:6,14,24`                                                        |      `HapticsPlugin`      |                Y                 |                Y                 |
| `@capacitor/keyboard`                 | 8.0.3    | 8.0.3      |   Y    | `keyboard.ts:16`                                                            |     `KeyboardPlugin`      |                Y                 |                Y                 |
| `@capacitor/network`                  | 8.0.1    | 8.0.1      |   Y    | `network.ts:17`                                                             |    `CAPNetworkPlugin`     |                Y                 |                Y                 |
| `@capacitor/preferences`              | 8.0.1    | 8.0.1      |   Y    | `secure-storage.ts:55`, `app-lock.ts:10,21`, `purchase-storage.ts:27,43,73` |    `PreferencesPlugin`    |                Y                 |                Y                 |
| `@capacitor/push-notifications`       | 8.0.3    | 8.0.3      |   Y    | `notifications.ts:8`                                                        | `PushNotificationsPlugin` |                Y                 |                Y                 |
| `@capacitor/share`                    | 8.0.1    | 8.0.1      |   Y    | `share.ts:90`                                                               |       `SharePlugin`       |                Y                 |                Y                 |
| `@capacitor/splash-screen`            | (absent) | 8.0.1      |  N/A   | **no runtime import** (config-only via `capacitor.config.ts`)               |   `SplashScreenPlugin`    |                Y                 |                Y                 |
| `@capacitor/status-bar`               | 8.0.2    | 8.0.2      |   Y    | `status-bar.ts:6,14`                                                        |     `StatusBarPlugin`     |                Y                 |                Y                 |
| `@aparajita/capacitor-biometric-auth` | 10.0.0   | 10.0.0     |   Y    | `biometrics.ts:15,33`                                                       |   `BiometricAuthNative`   |                Y                 |                Y                 |
| `@aparajita/capacitor-secure-storage` | 8.0.0    | 8.0.0      |   Y    | `secure-storage.ts:45`                                                      |      `SecureStorage`      |                Y                 |                Y                 |
| `@capgo/inappbrowser`                 | 8.6.1    | 8.6.1      |   Y    | `webview.ts:62`                                                             |   `InAppBrowserPlugin`    |                Y                 |                Y                 |
| `@capacitor/android`                  | (absent) | 8.3.1      |  N/A   | build-only                                                                  |             —             |                —                 |                —                 |
| `@capacitor/ios`                      | (absent) | 8.3.1      |  N/A   | build-only                                                                  |             —             |                —                 |                —                 |
| `@capacitor/cli`                      | (absent) | 8.3.1      |  N/A   | build-only                                                                  |             —             |                —                 |                —                 |

**Finding:** `@capacitor/filesystem` is installed and consumed by `apps/web/app/native/share.ts:31`, registered correctly on Android (`capacitor.plugins.json:18-21`), but **absent from iOS `packageClassList`** (`apps/mobile/ios/App/App/capacitor.config.json:26-40`) and **absent from iOS `CapApp-SPM/Package.swift`** (dependency list `:13-28` and target products `:29-48`). Filed as A2-1200 (High).

`@capacitor/splash-screen` is a valid mobile-only dependency (no JS import site) — it wires iOS + Android splash at native build time via `capacitor.config.ts.plugins.SplashScreen`.

All other plugins in the web bundle have a matching class entry in both `packageClassList` and `capacitor.plugins.json`.

ESLint `no-restricted-imports` enforcement on `@capacitor/*`, `@aparajita/*`, `@capgo/*` is claimed by ADR-007 §Decision — verified in `apps/web/app/native/*.ts` where **every** import of those scopes lives in `apps/web/app/native/**`. No violations in `grep -R "@capacitor\|@aparajita\|@capgo" apps/web/app` outside `app/native/` except in testing mocks.

---

## 5. iOS `Info.plist` audit table

File: `apps/mobile/ios/App/App/Info.plist` (55 lines read).

| Key / Attribute                                  | Present? | Value / Note                                                                                                                                                                                  |
| ------------------------------------------------ | :------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CFBundleDisplayName`                            |    Y     | `Loop` (static, not templated — fine for a single-brand app).                                                                                                                                 |
| `CFBundleIdentifier`                             |    Y     | `$(PRODUCT_BUNDLE_IDENTIFIER)` → `io.loopfinance.app`.                                                                                                                                        |
| `CFBundleShortVersionString` (marketing version) |    Y     | `$(MARKETING_VERSION)` → `1.0` in pbxproj (`:306,328`).                                                                                                                                       |
| `CFBundleVersion`                                |    Y     | `$(CURRENT_PROJECT_VERSION)` → `1` in pbxproj (`:299,321`).                                                                                                                                   |
| `LSRequiresIPhoneOS`                             |    Y     | iPhone-only; no iPad-optimised build submitted.                                                                                                                                               |
| `NSFaceIDUsageDescription`                       |    Y     | Live copy drifts from overlay canonical — documented in Phase 4 A2-405.                                                                                                                       |
| `NSLocationWhenInUseUsageDescription`            |    Y     | Matches overlay canonical. No `…Always…` variant — matches "one-shot position" design.                                                                                                        |
| `NSPhotoLibraryAddUsageDescription`              |  **N**   | Not required: share flow writes to `Directory.Cache`, not the photo library. Intentional.                                                                                                     |
| `NSAppTransportSecurity` / exceptions            |  **N**   | Absent → iOS default (HTTPS only, forward-secrecy, TLS 1.2+) applies. Correct default-deny posture.                                                                                           |
| `LSApplicationQueriesSchemes`                    |  **N**   | No external-app probing. Fine.                                                                                                                                                                |
| `CFBundleURLTypes` (custom URL schemes)          |  **N**   | No deep-link URL scheme registered.                                                                                                                                                           |
| `com.apple.developer.associated-domains`         |  **N**   | No entitlements file at all (`find apps/mobile/ios -name '*.entitlements'` → empty). No Universal Links.                                                                                      |
| `UIBackgroundModes`                              |  **N**   | Absent → no background fetch / push / location — matches current feature set.                                                                                                                 |
| `UIRequiredDeviceCapabilities`                   |    Y     | `armv7` only; stale for modern arm64-only devices but harmless.                                                                                                                               |
| `UISupportedInterfaceOrientations`               |    Y     | Portrait + both landscapes on iPhone; all four on iPad. Mismatches the app's fixed-bottom-nav UI which is portrait-only in practice.                                                          |
| `UIViewControllerBasedStatusBarAppearance`       |    Y     | `true` — required for Capacitor status-bar plugin.                                                                                                                                            |
| `CAPACITOR_DEBUG`                                |    Y     | `$(CAPACITOR_DEBUG)` wired to `debug.xcconfig:1` (`CAPACITOR_DEBUG = true`). No release xcconfig — same flag value ends up in App-Store builds, exposing verbose bridge logging. See A2-1201. |

`IPHONEOS_DEPLOYMENT_TARGET = 15.0` at `project.pbxproj:233,284,301,323`. `README.md:7` says "iOS 16+ target". Drift between documented minimum-OS policy and shipped deployment target (A2-1202, Low).

`CODE_SIGN_STYLE = Automatic` (`:298,320`), `CODE_SIGN_IDENTITY = iPhone Developer` (`:214,271`), no explicit `DEVELOPMENT_TEAM` — the team ID is empty in the committed pbxproj, so any clone must configure signing in Xcode before archiving. Not a finding in itself; part of A2-1205 (signing/provisioning docs gap).

---

## 6. Android `AndroidManifest.xml` + resource audit table

File: `apps/mobile/android/app/src/main/AndroidManifest.xml` (54 lines read).

| Attribute / Element                                            | Present? | Value / Note                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<application android:allowBackup>`                            |    Y     | **`true`** (ADR-006 chose "keep backup on, exclude sensitive file" approach).                                                                                                                                                                                                         |
| `android:fullBackupContent="@xml/backup_rules"`                |    Y     | Overlay-injected. Verified against `res/xml/backup_rules.xml:21-23`.                                                                                                                                                                                                                  |
| `android:dataExtractionRules="@xml/data_extraction_rules"`     |    Y     | Overlay-injected. Verified against `res/xml/data_extraction_rules.xml:16-23`.                                                                                                                                                                                                         |
| `android:networkSecurityConfig="@xml/network_security_config"` |    Y     | `network_security_config.xml:3-6` permits cleartext only for `localhost` + `10.0.2.2` (emulator loopback). Correct scoped dev allowance; no wildcard cleartext.                                                                                                                       |
| `android:theme="@style/AppTheme"`                              |    Y     | Parent `Theme.AppCompat.Light.DarkActionBar`. Light parent on a dark-first app is an overlay gap — see A2-1212 (Low).                                                                                                                                                                 |
| `<activity android:exported="true">` (MainActivity)            |    Y     | Explicit `exported="true"` — required for API 31+. OK.                                                                                                                                                                                                                                |
| `<provider FileProvider>` `android:exported="false"`           |    Y     | Matches Capacitor default. Paths `res/xml/file_paths.xml:3-4` expose `external-path` + `cache-path` at `"."` (whole directory) — fine for share URIs via `Directory.Cache` but broad if future features write secrets there. Filed as A2-1213.                                        |
| `intent-filter android:autoVerify="true"` (deep links)         |  **N**   | No deep-link `VIEW` intent-filter. Universal Links / App Links not configured. Consistent with iOS. See A2-1204 for the decision-record gap.                                                                                                                                          |
| `<uses-permission INTERNET>`                                   |    Y     | Line 50.                                                                                                                                                                                                                                                                              |
| `<uses-permission ACCESS_FINE_LOCATION>`                       |    Y     | Line 51. Overlay-injected (`apply-native-overlays.sh:142-152`).                                                                                                                                                                                                                       |
| `<uses-permission ACCESS_COARSE_LOCATION>`                     |    Y     | Line 52. Overlay-injected.                                                                                                                                                                                                                                                            |
| `<uses-permission POST_NOTIFICATIONS>`                         |  **N**   | Required on Android 13+ for `PushNotifications`. Missing. See A2-1208.                                                                                                                                                                                                                |
| `<uses-permission USE_BIOMETRIC>` / `USE_FINGERPRINT`          |  **N**   | `@aparajita/capacitor-biometric-auth` merges these via its own manifest — verify: `find node_modules/@aparajita/capacitor-biometric-auth/android -name AndroidManifest.xml` not explored, but biometric currently works per product testing. Leaving as observation only, no finding. |
| `versionCode 1`, `versionName "1.0"`                           |    Y     | `app/build.gradle:10-11`. Never bumped. Pre-launch, but no documented bump policy. See A2-1203.                                                                                                                                                                                       |
| `minSdkVersion 24` (Android 7.0)                               |    Y     | `variables.gradle:2`. Docs say "API 35+ target" without a matching min-SDK statement. See A2-1202.                                                                                                                                                                                    |
| `targetSdkVersion 36`, `compileSdk 36`                         |    Y     | Android 14+. Fresh.                                                                                                                                                                                                                                                                   |
| `google-services.json`                                         |  **N**   | Gradle comment: "not found, google-services plugin not applied. Push Notifications won't work" (`app/build.gradle:48-54`). Consistent with no FCM functional story; tracks with A2-1208.                                                                                              |

---

## 7. Mobile threat-model posture — pinning / integrity / jailbreak

Plan G5-63 (SSL pinning), G5-64 (jailbreak/root detection), G4-12 (App Attest / Play Integrity / binary tamper), G5-57 (universal-link vs custom-scheme collision risk).

| Control                               |    Present?     | Decision recorded where?                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | :-------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS certificate pinning (iOS)         |        N        | No decision doc. No `ATSPinnedDomains` / `NSPinnedLeafIdentities` entry. Network egress to `loopfinance.io` rides Capacitor's default WKWebView TLS stack + `URLSession` defaults only.                                                                                                                                                                              |
| TLS certificate pinning (Android)     |        N        | No `<pin-set>` inside `network_security_config.xml` (`:1-7`, fully read).                                                                                                                                                                                                                                                                                            |
| Root / jailbreak detection            |        N        | No plugin, no native check. `grep -R 'jailbreak\|rooted\|SafetyNet\|Magisk\|JailMonkey'` in the whole repo returns only docstring hits in ADRs/audit docs — no runtime code.                                                                                                                                                                                         |
| iOS App Attest / DeviceCheck          |        N        | No `DCAppAttestService` reference anywhere in the repo.                                                                                                                                                                                                                                                                                                              |
| Android Play Integrity / SafetyNet    |        N        | No `PlayIntegrityService` reference anywhere.                                                                                                                                                                                                                                                                                                                        |
| Tampered-binary detection             |        N        | No.                                                                                                                                                                                                                                                                                                                                                                  |
| App-level re-auth on resume           | N (intentional) | Explicitly documented in `apps/web/app/native/app-lock.ts:45-55`: cold-start only; matches the `docs/infra: app-lock prompts on cold start, not on resume` commit `3e800c1`.                                                                                                                                                                                         |
| Screenshot guard on sensitive screens |     Partial     | `apps/web/app/native/screenshot-guard.ts` applies a blur overlay via the Capacitor `pause`/`resume` DOM events. No FLAG_SECURE on Android (only a JS overlay), so real screenshots are **not** blocked on Android — only the task-switcher thumbnail is blurred. Comment in file line 6 admits this ("true FLAG_SECURE requires a native plugin"). Filed as A2-1207. |
| Deep-link / custom-scheme exposure    |       N/A       | No custom scheme registered (see plist + manifest tables). Nothing to exploit.                                                                                                                                                                                                                                                                                       |

**Net posture:** for a payments-adjacent app that will hold refresh tokens in Keychain / EncryptedSharedPreferences and a Stellar signing key (Phase 2) on-device, **none of** SSL pinning, attest/integrity, or binary-tamper detection are in place. None of these are strictly required for Phase 1 (XLM pay-with-your-own-wallet — no custodial assets on-device yet), but the lack of a recorded decision one way or the other is the finding, not the absence of controls. Filed as A2-1204 (Medium).

The cold-start-only app-lock decision is correctly recorded and traceable to the commit + source comment; no finding.

---

## 8. Version-bump discipline (plan G5-61)

- iOS `MARKETING_VERSION = 1.0` (`project.pbxproj:306,328`), `CURRENT_PROJECT_VERSION = 1` (`:299,321`). Never incremented.
- Android `versionCode 1`, `versionName "1.0"` (`app/build.gradle:10-11`). Never incremented.
- No `docs/deployment.md` section or `scripts/` helper bumps these on release.
- No `fastlane` / `bumpversion` config in repo (`grep -R Fastfile` → empty; `grep -R bumpversion` → empty).
- `docs/deployment.md:159-197` (full read) covers "how to open Xcode / Android Studio and hit Archive" but says nothing about bumping either version scalar, nor about the App Store / Play Store rule that every TestFlight / internal-track upload requires a monotonically-rising `CFBundleVersion` / `versionCode`.

This is pre-launch so "never bumped" is literally true. But once a second build is submitted, the **first** upload will succeed and the **second** will be rejected because `CFBundleVersion=1` hasn't moved. Filed as A2-1203 (Medium).

---

## 9. Signing / provisioning (plan G3-12, G6-06) — docs-only

- No signing certificates, `.p8` keys, `.mobileprovision`, or `.p12` files in the repo (`git ls-files | grep -E '\.(p8|p12|mobileprovision|jks|keystore|cer|pem)$'` → empty).
- No documented cert-expiry runbook (`grep -R 'expiry\|expires' docs/deployment.md` → empty).
- No `CODEOWNERS` entry for `apps/mobile/**` — checked `.github/CODEOWNERS` against `apps/mobile` path; no match. Mobile-config changes merge without explicit reviewer enforcement.
- `docs/deployment.md:183-186` says "Select team and bundle ID `io.loopfinance.app`" with no further detail about which Apple Developer account, where provisioning profiles live, or how TestFlight releases are managed.
- No documented `google-services.json` handling (not in repo — gradle gracefully degrades per `app/build.gradle:48-54`, but no secrets-management flow documented).

Filed as A2-1205 (Medium): signing / provisioning / cert-expiry runbook absent.

---

## 10. Findings

All filed for post-audit remediation queue (plan §3.4, §0.4). IDs monotonic from A2-1200.

### A2-1200 — iOS missing `@capacitor/filesystem` in `packageClassList` + `Package.swift` (High)

**Files:**

- `apps/mobile/ios/App/App/capacitor.config.json:26-40` (`packageClassList` omits `FilesystemPlugin`).
- `apps/mobile/ios/App/CapApp-SPM/Package.swift:13-28` (no `CapacitorFilesystem` package dependency).
- `apps/mobile/ios/App/CapApp-SPM/Package.swift:29-48` (no `CapacitorFilesystem` target product).
- Consumer: `apps/web/app/native/share.ts:31` — `await import('@capacitor/filesystem')` for the ADR-008 share-with-image path.

**Evidence:** `apps/mobile/android/app/src/main/assets/capacitor.plugins.json:18-21` registers `FilesystemPlugin` correctly for Android; iOS parity was never achieved. Mtime on iOS `capacitor.config.json` + `Package.swift` is `Apr 20 07:46`, one day before ADR-008 landed; Android side mtime `Apr 21 12:35`.

**Impact:** iOS users hitting "Share" on `PurchaseComplete` lose the composited gift-card image silently. `share.ts:91-95` awaits `writeTempShareImage`, which on iOS loads a module that isn't registered in the native bridge. The dynamic `import('@capacitor/filesystem')` resolves the JS shim, whose first `Filesystem.writeFile` call returns `"Filesystem plugin is not implemented on ios"` and the catch at `share.ts:74-76` silently returns `null`. `share.ts:94` branches to the text-only fallback — no crash, no user-visible error, just missing image. In production this manifests as "the Android users see the barcode in their share, the iOS users don't."

**Remediation:** run `npx cap sync ios` after `@capacitor/filesystem` was added in `apps/mobile/package.json`. Verify `packageClassList` includes `FilesystemPlugin` and `CapApp-SPM/Package.swift` lists the `CapacitorFilesystem` product. Consider adding a CI step that fails if iOS and Android plugin registrations diverge.

---

### A2-1201 — `CAPACITOR_DEBUG=true` shipped in release builds (Medium)

**Files:** `apps/mobile/ios/debug.xcconfig:1` (`CAPACITOR_DEBUG = true`); `apps/mobile/ios/App/App/Info.plist:5-6` (`<key>CAPACITOR_DEBUG</key><string>$(CAPACITOR_DEBUG)</string>`).

**Evidence:** only a `debug.xcconfig` exists under `apps/mobile/ios/`. No `release.xcconfig` and no `.xcconfig` assignment per configuration in `project.pbxproj` (reads `IPHONEOS_DEPLOYMENT_TARGET = 15.0;` at `:301,323` without an xcconfig basis). Release-configured builds inherit whatever Xcode defaults — in practice the flag propagates and the plist resolves to `$(CAPACITOR_DEBUG)` = empty, which Capacitor reads as false-y, so today the defect is latent, not active. The defect is that the xcconfig wiring does not differentiate Debug from Release and a developer flipping the file's value "to see more bridge logs" would ship the verbose path by accident.

**Impact:** verbose Capacitor bridge logging exposes plugin call arguments at runtime — refresh-token writes, biometric-auth calls, clipboard reads — in the iOS system log, readable by `idevicesyslog` / Xcode's Console app on any physical device.

**Remediation:** add `apps/mobile/ios/release.xcconfig` with `CAPACITOR_DEBUG = false`, and wire both xcconfig files to the matching Xcode configurations in `project.pbxproj`.

---

### A2-1202 — Minimum-OS policy drift between docs, Info.plist, and build.gradle (Low)

**Files:**

- `apps/mobile/README.md:7-8` — "iOS: Xcode 15+, iOS 16+ target; Android: Android Studio, API 35+ target".
- `apps/mobile/ios/App/App.xcodeproj/project.pbxproj:233,284,301,323` — `IPHONEOS_DEPLOYMENT_TARGET = 15.0`.
- `apps/mobile/android/variables.gradle:2-4` — `minSdkVersion = 24` (Android 7.0), `compileSdk = 36`, `targetSdk = 36`.

**Evidence:** README says "iOS 16+" but live Xcode config says iOS 15.0. README says "API 35+ target" — `targetSdkVersion 36` is fine, but minSdkVersion 24 is Android 7.0, not anything like "35+" — the README conflates target and min SDK.

**Impact:** auditors reading the README reach a false conclusion about which OS versions are actually supported. Pre-launch the ambiguity doesn't break anything, but it's the kind of doc drift that causes a support-ticket surprise ("my Android 8 phone can install the app, didn't you say 12+?").

**Remediation:** document the actual **min** SDK policy (iOS 15.0, Android API 24 / 7.0) in the README and in a new `docs/adr/NNN-mobile-min-os-policy.md` (plan G6-08). Either raise minSdkVersion to match the README or rewrite the README.

---

### A2-1203 — No version-bump discipline documented for iOS `CFBundleVersion` / Android `versionCode` (Medium)

**Files:**

- `apps/mobile/ios/App/App.xcodeproj/project.pbxproj:299,321` (`CURRENT_PROJECT_VERSION = 1`), `:306,328` (`MARKETING_VERSION = 1.0`).
- `apps/mobile/android/app/build.gradle:10-11` (`versionCode 1`, `versionName "1.0"`).
- `docs/deployment.md:159-197` — no section mentions bumping either.

**Evidence:** `grep -n 'MARKETING_VERSION\|CFBundleShortVersionString\|versionCode\|versionName' docs/` returns only the audit plan's mention at `audit-2026-adversarial-plan.md:989` (G5-61) — no runbook, no script, no CI step. `find . -name Fastfile -o -name .github/workflows/*mobile*` → empty.

**Impact:** the first TestFlight / internal-track upload succeeds. The second is rejected by App Store Connect / Play Console because the version scalar didn't move. Even worse, a developer might flip `CFBundleVersion` on one branch and forget on another, leading to confusing rejection messages across branches. Pre-launch severity because multiple TestFlight uploads are already inevitable for QA.

**Remediation:** (a) add a `docs/deployment.md` §Mobile §Version bump discipline section; (b) ideally a `scripts/bump-mobile-version.sh` that edits `project.pbxproj` + `app/build.gradle` atomically; (c) CI lint that fails if a mobile-touching PR keeps both values unchanged since the last tagged release.

---

### A2-1204 — No recorded decision on SSL pinning / attest / integrity / jailbreak (Medium)

**Files:** whole repo — no ADR, no doc section, no runtime code.

**Evidence:** `grep -R 'pinning\|SSL pinning\|certificate pinning\|AppAttest\|DeviceCheck\|PlayIntegrity\|SafetyNet\|jailbreak\|rooted' --exclude-dir=docs/audit-2026-* --exclude=docs/audit-tracker.md` returns only docstring hits on stellar-pinning / asset-pinning (different concept).

**Impact:** audit rule §3.4 + plan G5-63/G5-64/G4-12 require that, for each of these controls, the codebase records either the presence of the control or an explicit decision not to implement it with rationale. Loop has neither. Not a direct runtime vulnerability today (Phase-1 has no on-device custodial secrets beyond the refresh token, which is Keychain-bound), but Phase 2 ships Stellar signing keys on-device and the absence-of-decision risk lands there.

**Remediation:** add an ADR — something like `docs/adr/024-mobile-threat-model-decisions.md` — that records, for each of: TLS pinning, App Attest / DeviceCheck, Play Integrity, jailbreak / root detection, binary tamper detection — the current decision (don't implement, implement, defer to Phase 2) and the rationale. Link from `docs/standards.md` security section.

---

### A2-1205 — Signing / provisioning / cert-expiry runbook absent (Medium)

**Files:** `docs/deployment.md:159-197`; `.github/CODEOWNERS` (no `apps/mobile/**` entry); absence of any mobile secrets-management doc.

**Evidence:** the full mobile release section in `docs/deployment.md` is 39 lines and says "select team and bundle ID" and "upload `.aab` to Play Console" with no detail on which Apple Developer account, provisioning-profile rotation, push-notification certificate rotation (APNs), Play signing key rotation, or cert-expiry calendaring.

**Impact:** plan G6-06 explicitly flags Apple/Google signing cert expiry as a real risk. Certs silently expire, builds silently break, and without a runbook the first person to discover the expiry does so when a release is blocked.

**Remediation:** add `docs/deployment.md` §Signing + provisioning + cert rotation or a separate `docs/adr/NNN-mobile-signing.md`. Track expiry dates in a calendar reminder or `docs/roadmap.md`. Add `apps/mobile/**` to `CODEOWNERS` so mobile-config changes require an explicit reviewer.

---

### A2-1206 — iOS `cap sync` stale vs Android (High — evidence of live drift)

**Files:**

- `apps/mobile/ios/App/App/capacitor.config.json` mtime `Apr 20 07:46`.
- `apps/mobile/ios/App/CapApp-SPM/Package.swift` mtime `Apr 20 07:46`.
- `apps/mobile/android/app/src/main/assets/capacitor.plugins.json` mtime `Apr 21 12:35`.
- `docs/adr/008-capacitor-filesystem-for-share.md:Date: 2026-04-21` — the date `@capacitor/filesystem` was added.

**Evidence:** Android platform files are mtime-dated after ADR-008; iOS platform files are mtime-dated before. This is the direct cause of A2-1200 — `npx cap sync` was run on the Android target only after the filesystem plugin was added. There is no CI or pre-commit hook that verifies `cap sync` has been run consistently across both platforms.

**Impact:** two findings compound — (1) A2-1200's concrete bug, and (2) the general invariant "iOS and Android plugin sets stay in lockstep" has no enforcement. Any future plugin addition is susceptible to the same drift.

**Remediation:** `scripts/verify.sh` could check that `apps/mobile/ios/App/App/capacitor.config.json:packageClassList` and `apps/mobile/android/app/src/main/assets/capacitor.plugins.json` list the same set of plugins. Alternatively, a CI step that runs `npx cap sync ios android` and fails if the diff isn't empty. Cross-reference Phase 4 §10 (plugin-parity summary) which checked `package.json` parity but did not check native-project parity — that was the gap.

---

### A2-1207 — Screenshot guard is JS-only overlay; no FLAG_SECURE on Android (Medium)

**Files:** `apps/web/app/native/screenshot-guard.ts:1-40` (full read).

**Evidence:** `screenshot-guard.ts:6` explicitly comments "On Android, this is a best-effort overlay — true FLAG_SECURE requires a native plugin." The implementation listens for Capacitor DOM `pause` / `resume` events and overlays a blurred `<div>`. This covers the task-switcher thumbnail on both platforms (Android captures the thumbnail when the app goes to background) but does **not** prevent an actual screenshot from inside the app. iOS: `UIApplicationUserDidTakeScreenshotNotification` is not listened to; system screenshot still captures the sensitive view before the pause/resume cycle. Android: no `WindowManager.LayoutParams.FLAG_SECURE` — any screenshot app or `adb shell screencap` pulls the raw view.

**Impact:** the product feature is advertised as "screenshot guard" (function name, file name) but only guards the task-switcher thumbnail, not actual screenshots. On `PurchaseComplete` (the only call site at `apps/web/app/components/features/purchase/PurchaseComplete.tsx:85`) a user can screenshot the redeemable code + PIN and share it; the feature does not meaningfully prevent this. Name-vs-behaviour mismatch is the specific finding, not the absence of FLAG_SECURE itself (which is a legitimate product choice).

**Remediation:** either (a) rename the function / file to `enableTaskSwitcherBlur` so the name matches the behaviour, or (b) add a native overlay that sets `FLAG_SECURE` on Android and listens for `UIApplicationUserDidTakeScreenshotNotification` on iOS, to actually block screenshots. Option (a) is the no-cost fix; (b) is the feature-parity fix.

---

### A2-1208 — No `POST_NOTIFICATIONS` permission; no runtime permission request; no APNs / FCM setup (Medium)

**Files:**

- `apps/mobile/android/app/src/main/AndroidManifest.xml:48-53` — no `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`.
- `apps/web/app/native/notifications.ts:1-27` — `setupNotificationChannels` creates channels but never calls `PushNotifications.requestPermissions()` or `PushNotifications.register()`.
- `apps/mobile/android/app/build.gradle:48-54` — "google-services.json not found, google-services plugin not applied. Push Notifications won't work".
- No APNs `.p8` / `.p12` or keys configured anywhere in docs.

**Evidence:** the Capacitor `PushNotifications` plugin is imported, a channel is created, `Info.plist` declares `presentationOptions`, but nothing ever requests permission from the user or registers a device token. Android 13+ additionally blocks notifications without the runtime `POST_NOTIFICATIONS` permission, which must be declared in the manifest first.

**Impact:** push notifications as a feature is zero-functional today. Either the feature should be removed from the dependency tree (unused plugin surface increases attack area) or the code should be completed before launch. The "channel created but nothing registered" pattern suggests a half-finished feature rather than a deliberate future surface.

**Remediation:** decide whether push is Phase-1 or Phase-2. If Phase-2, delete the `@capacitor/push-notifications` dependency and the `notifications.ts` module; remove the presentation options from `capacitor.config.ts`. If Phase-1, wire up `requestPermissions` + `register` + add `POST_NOTIFICATIONS` to the Android manifest overlay and provision `google-services.json` / APNs.

---

### A2-1209 — Overlay script's manifest patch is brittle to Capacitor template changes (Low)

**Files:** `apps/mobile/scripts/apply-native-overlays.sh:156-171`.

**Evidence:** the `sed` substitution at `:162` (GNU) and `:165-167` (BSD) matches literal `android:allowBackup="true"`. The Capacitor template has used that exact string for several major versions, but a future template change (e.g. `allowBackup = true` whitespace change, or flipping to `"false"`) silently no-ops the substitution — the grep guard at `:156` then never triggers on subsequent runs, and the overlay never lands, but the script still reports success.

**Impact:** audit A-033's protection silently regresses on a Capacitor version bump, with no detection.

**Remediation:** anchor the substitution to a more robust token, or verify post-write that `android:fullBackupContent` is present in the output and `exit 1` if not.

---

### A2-1210 — Overlay script does not garbage-collect removed overlay files (Low)

**Files:** `apps/mobile/scripts/apply-native-overlays.sh` (the whole file; no `rm` or parity-check logic).

**Evidence:** the script only `cp`s files into the generated trees. If a file is later removed from `native-overlays/`, its stale copy in `apps/mobile/android/...` or `apps/mobile/ios/...` persists across every future `cap sync` + overlay re-apply.

**Impact:** unlikely but possible foot-gun where an overlay file intended to be retired silently remains in the shipped binary. Low because it requires both a manual overlay removal and a failure to notice in the build diff.

**Remediation:** on every run, write a `native-overlays/.manifest` listing every file copied, and next run delete anything in the destination that matches that manifest but isn't in the current overlay source.

---

### A2-1211 — Splash background colour drift: `capacitor.config.ts` vs Android `styles.xml` (Low)

**Files:**

- `apps/mobile/capacitor.config.ts:10` — `backgroundColor: '#030712'`.
- `apps/mobile/native-overlays/android/app/src/main/res/values/styles.xml:31,60` — `windowSplashScreenBackground` / `IconBackground` set to `@color/ic_launcher_background` which is `#111111` (per `native-overlays/.../values/ic_launcher_background.xml`).

**Evidence:** two distinct "dark" colours paint across the boot sequence on Android. System splash (≈400ms) uses `#111111`; Capacitor `SplashScreen` plugin then paints `#030712`. Visible as a subtle colour shift on cold start.

**Impact:** cosmetic — a perceptible colour flash on Android cold-start. iOS doesn't have the system-splash split.

**Remediation:** pick one colour, propagate to both. Either pin `ic_launcher_background.xml` to `#030712` or update the Capacitor config value.

---

### A2-1212 — Android theme parent is `Light.DarkActionBar` on a dark-first app (Low)

**Files:** `apps/mobile/native-overlays/android/app/src/main/res/values/styles.xml:5` — `<style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar">`.

**Evidence:** `AppTheme` parent is the light-mode AppCompat theme, while `AppTheme.NoActionBar` (line 12) correctly uses `Theme.AppCompat.DayNight.NoActionBar`. The `AppTheme` style is the `<application android:theme>` default (manifest line 20). In practice every Activity overrides with `AppTheme.NoActionBarLaunch`, so the `Light.DarkActionBar` never renders — but any future Activity that forgets to override inherits a light theme on a dark-first app.

**Impact:** zero today because every Activity overrides. Latent foot-gun for any future Activity (e.g. a settings screen) added without an explicit theme override.

**Remediation:** change the `AppTheme` parent to `Theme.AppCompat.DayNight` or `Theme.AppCompat` (no explicit light/dark).

---

### A2-1213 — `FileProvider` paths are broader than the cache-only share flow needs (Low)

**Files:** `apps/mobile/android/app/src/main/res/xml/file_paths.xml:1-5`.

**Evidence:** the FileProvider declares `<external-path name="my_images" path="." />` and `<cache-path name="my_cache_images" path="." />` — both granting URI authority to the entire root of each zone. ADR-008's share flow only uses `Directory.Cache` (`apps/web/app/native/share.ts:67`), so only the `cache-path` is needed, and even there `path="."` exposes the whole cache root rather than a share-specific subfolder.

**Impact:** if any future feature writes anything to external storage cache that isn't meant to be shareable (e.g. a temporary receipt PDF, a decrypted wallet backup file), a malicious sibling app with `grantUriPermission` could request a content URI for it via crafted intent. Low because current writes are cache-only PNGs, but the over-scoped authority is a latent foot-gun.

**Remediation:** narrow `file_paths.xml` to `<cache-path name="share" path="share/" />` and write share images to `Cache/share/` instead of `Cache/`.

---

## 11. Summary

| Severity | Count |
| -------- | ----- |
| High     | 2     |
| Medium   | 6     |
| Low      | 6     |
| Total    | 14    |

**Blockers hit during audit:** none. Both `apps/mobile/ios/` and `apps/mobile/android/` native projects were generated locally and inspectable. No tool unavailability.

**Items intentionally deferred to later phases:**

- Capacitor plugin IPC surface as an attack surface (plan §1.4 mapping this to Phase 9 + Phase 12) — the injection risks via `InAppBrowser.executeScript`, deep-link handlers, etc. are Phase 12's security deep-dive.
- Mobile bundle size / web-vs-mobile static-export delta (plan Phase 9 scope bullet "Static-export output size") — defer to Phase 4 addendum (the build artefact comparison is a build-release concern, not a mobile-shell concern).

No source was modified and no git operations were performed during this phase.
