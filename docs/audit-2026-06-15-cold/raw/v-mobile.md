# Cold Audit 2026-06-15 — Vertical: Mobile / Native (V10)

Branch: `fix/stranded-order-hardening`. Auditor pass: adversarial cold read of the
mobile shell, native plugin boundary, overlays, signing, and platform-security posture.

## Coverage

Files examined in full (29 source/config + supporting):

**apps/mobile/**

- `capacitor.config.ts` — appId `io.loopfinance.app`, SplashScreen/Keyboard/PushNotifications plugin config
- `package.json` — 17 Capacitor deps, engines pin
- `README.md`
- `scripts/apply-native-overlays.sh` — full read (395 lines)
- `native-overlays/android/app/signing.gradle`
- `native-overlays/android/keystore.properties.example`
- `native-overlays/android/app/src/main/res/xml/{backup_rules,data_extraction_rules,network_security_config,file_paths}.xml`
- `native-overlays/android/app/src/main/java/io/loopfinance/app/MainActivity.java`
- `native-overlays/ios/release.xcconfig`
- `native-overlays/ios/App/App/PrivacyInfo.xcprivacy`
- `native-overlays/ios/App/App/Info.plist.additions.txt`
- generated `android/app/src/main/AndroidManifest.xml` (verify overlays apply), `android/variables.gradle`, `ios/App/App/Info.plist`, `ios/App/App/capacitor.config.json`

**apps/web/app/native/ (all 15 plugin-boundary modules + tests):**

- `secure-storage.ts`, `purchase-storage.ts`, `app-lock.ts`, `biometrics.ts`,
  `task-switcher-overlay.ts`, `share.ts`, `webview.ts`, `platform.ts`,
  `back-button.ts`, `network.ts`, `clipboard.ts`, `haptics.ts`, `keyboard.ts`,
  `notifications.ts`, `status-bar.ts`
- `__tests__/{native-modules,app-lock.native,secure-storage-native}.test.ts`

**Cross-cutting:**

- `eslint.config.js` — `no-restricted-imports` Capacitor boundary rule
- `apps/web/package.json` vs `apps/mobile/package.json` plugin version parity
- `apps/web/app/root.tsx` (NativeShell lifecycle wiring), `hooks/use-native-platform.ts`
- `apps/web/app/routes/auth.tsx` + `components/features/auth/GoogleSignInButton.tsx` (native social path)
- `apps/web/app/hooks/use-auth.ts` (`signInWithApple` wiring)
- `docs/adr/027-mobile-platform-security.md`, `docs/deployment.md` §Mobile, `docs/roadmap.md`
- `.github/workflows/ci.yml` (mobile build job), `.gitignore` (native trees + keystore)

> Note: per-vertical scope is the native layer. The 15 `app/native/*` modules
> are the boundary; their downstream consumers (purchase flow, stores) are
> owned by V9 (Web) and only spot-checked here for the native seam.

## Summary

Severity counts: **P0: 0 · P1: 2 · P2: 4 · P3: 5**

The native layer is unusually disciplined: the plugin boundary is clean (zero
imports of `@capacitor/*`, `@aparajita/capacitor-*`, `@capgo/*` outside
`app/native/`, ESLint-enforced), all 17 plugin versions match between web and
mobile `package.json`, the overlay script (ADR-007) is idempotent with loud
fail-closed anchors, and the secure-storage / purchase-storage migrations
(ADR-006) are correct. The findings are concentrated in **store-submission
readiness** (Apple 4.8, broken native Google flow), **the ADR-027 binary-tamper
trigger that is now formally met**, and **the absence of any version-skew
safety net** for a static bundle that cannot force-update.

---

## Findings

### M-01 · P1 · Store readiness / Auth — Sign in with Apple offered server-side but no UI button; Google social login shipped without it (App Store Guideline 4.8 rejection risk)

- **File:** `apps/web/app/routes/auth.tsx:545-550` (Google button rendered),
  `apps/web/app/hooks/use-auth.ts:25,94-99` (`signInWithApple` wired but never invoked),
  `apps/web/app/services/config.ts:63` (`appleServiceId` exposed)
- **Evidence:** `GoogleSignInButton` renders whenever a Google client id is
  configured. `signInWithApple` exists in the auth hook and the backend verifies
  Apple `id_token`s, and `config.social.appleServiceId` is plumbed — but
  `grep` finds **no** Apple sign-in button component and **no** caller of
  `signInWithApple` anywhere in `routes/` or `components/`. It is dead client code.
- **Impact:** Apple App Store Review Guideline 4.8 requires "Sign in with Apple"
  as an option whenever an app offers third-party/social login (Google here) that
  collects identifying data. The iOS binary will likely be rejected on first
  submission. Secondary: `signInWithApple` is unreachable dead code.
- **Fix:** Render an Apple sign-in button on iOS native (and ideally web) that
  drives the already-wired `signInWithApple`, or remove the Google button on iOS.
- **Ref:** ADR 014, App Store Guideline 4.8.

### M-02 · P1 · Auth / Native correctness — Google sign-in uses the GSI web SDK inside the Capacitor WebView, which Google blocks ("disallowed_useragent")

- **File:** `apps/web/app/components/features/auth/GoogleSignInButton.tsx:47,55-72`;
  `apps/web/app/routes/auth.tsx:356-360` (selects `googleClientIdIos`/`Android` when native, still renders the same web button)
- **Evidence:** The button loads `https://accounts.google.com/gsi/client` and uses
  Google Identity Services' button/FedCM flow. On native, `auth.tsx` switches the
  _client id_ to the iOS/Android one but renders the **same GSI web script button**.
  There is no native Google auth plugin installed (no `@codetrix-studio/capacitor-google-auth`
  or equivalent in either `package.json`).
- **Impact:** Google refuses OAuth in embedded WebViews (`disallowed_useragent`
  403); the GSI button either fails to render or errors on tap inside Capacitor's
  WKWebView / Android WebView. Native Google sign-in is effectively non-functional.
  Email-OTP remains the working primary path, so this is degraded auth, not a
  lockout — hence P1 not P0.
- **Fix:** Use a native Google auth plugin (ASWebAuthenticationSession / Custom
  Tabs system browser) on native, or gate the Google button to web-only.
- **Ref:** ADR 014; checklist §24 (deep links / native auth), §32 (UX correctness).

### M-03 · P2 · ADR drift — ADR-027 binary-tamper Phase-2 trigger is met (sideload distribution) but the ADR records no dated acceptance or implementation

- **File:** `docs/adr/027-mobile-platform-security.md` (Decision table, "Binary
  tamper detection" row); `docs/roadmap.md:34` (orphaned-work register flags it
  "already met")
- **Evidence:** ADR-027's binary-tamper Phase-2 trigger is _"Distribution path
  moves outside the official stores."_ The roadmap explicitly states the Phase-1
  deliverable includes **APK sideload via direct link / Drive / Diawi**
  (`tranche-1-launch.md`), and roadmap line 34 confirms the trigger is "already
  met" with a pending decision. ADR-027 itself has not been amended with either a
  dated deferral acceptance or an implementation note — its row still reads as a
  clean Phase-1 deferral.
- **Impact:** A documented security control whose own trigger has fired is sitting
  in an undecided state. Sideloaded APKs load whatever JS bundle is on disk with no
  self-check. The deferral is no longer self-consistent with the distribution plan.
- **Fix:** Either implement tamper detection for the sideload build, or record a
  dated acceptance of the deferral directly in ADR-027 (and re-check the other
  three controls on the same review, as roadmap line 34 asks).
- **Ref:** ADR 027; checklist §24, Part 4 (ADR-027 trigger).

### M-04 · P2 · Version skew / resilience — no minimum-app-version / force-update mechanism for a static bundle that cannot self-update

- **File:** (absence) — no `X-App-Version`, `minVersion`, `426 UPGRADE_REQUIRED`,
  or `forceUpdate` anywhere in `apps/web/app` or `apps/backend/src`
- **Evidence:** `grep` for any version-gate / force-update primitive returns
  nothing. The mobile shell loads a static bundle baked at build time
  (`webDir: '../web/build/client'`); it cannot hot-update and the user controls
  when (or whether) they take a store update.
- **Impact:** A breaking backend API change (response-shape removal, new required
  field, auth contract change) silently strands every installed older bundle with
  no in-app "please update" path. The checklist explicitly flags this seam
  (§24 "Version skew: static bundle vs backend API; mobile can't force-update").
- **Fix:** Have the client send an app/build version header and let the backend
  return a soft "update available" / hard "update required" signal the shell can
  surface; or commit to a strict additive-only backend compatibility contract and
  document it.
- **Ref:** checklist §3 (backward compatibility), §24 (version skew), Part 3 seam 13.

### M-05 · P2 · Store readiness / deep links — no universal-link / app-link / custom-scheme config and no `appUrlOpen` handler

- **File:** (absence) — no `apple-app-site-association`, no `assetlinks.json`, no
  `CFBundleURLTypes` in iOS Info.plist, no `<intent-filter android:scheme>` in the
  generated `AndroidManifest.xml` (only the LAUNCHER filter), no `appUrlOpen`
  listener in `app/native/` or `root.tsx`
- **Evidence:** Confirmed by `grep` across `apps/mobile` and `apps/web/public`,
  and by reading the generated `AndroidManifest.xml` (lines 30-33: MAIN/LAUNCHER
  only) and iOS `Info.plist` (no URL types).
- **Impact:** No deep-linking. OAuth redirect callbacks (relevant to M-02's fix),
  email-link entry, and shared-link → app handoff all fall back to the browser.
  Acceptable for an OTP-first Phase-1 app, but it is a gap to record, and it
  forecloses the cleanest fix for native Google/Apple OAuth (system-browser +
  app-link callback).
- **Fix:** Add custom-scheme or universal-link config + an `appUrlOpen` handler in
  `app/native/` if/when native OAuth or deep entry is wanted; otherwise record the
  intentional omission.
- **Ref:** checklist §24 (deep links / universal links).

### M-06 · P2 · UX / Security overlay — privacy + app-lock overlays sit below Navbar dropdowns in z-order

- **File:** `apps/web/app/native/task-switcher-overlay.ts:36` (`z-index:99999`),
  `apps/web/app/native/app-lock.ts:84` (`z-index:99998`),
  `apps/web/app/components/features/Navbar.tsx:53,314` (`z-[999999]`)
- **Evidence:** The task-switcher privacy overlay (99999) and the app-lock overlay
  (99998) both have a _lower_ z-index than the Navbar dropdown menus (999999). If a
  Navbar dropdown is open when the app is backgrounded (privacy overlay) or on the
  cold-start lock check, the dropdown paints **over** the blur/lock overlay.
- **Impact:** The task-switcher snapshot could leak the contents of an open menu;
  the lock overlay could be partially bypassed visually. Low real-world likelihood
  (menus are usually closed on background), hence P2.
- **Fix:** Raise the two native overlays above the app's max app-level z-index
  (e.g. 2147483646), or close transient menus on the `pause` event.
- **Ref:** checklist §24 (task-switcher privacy), §2 (info leakage).

### M-07 · P3 · Robustness — overlay script copies `network_security_config.xml` but never asserts the manifest references it

- **File:** `apps/mobile/scripts/apply-native-overlays.sh:78`
- **Evidence:** The script overwrites `res/xml/network_security_config.xml` (A4-079,
  HTTPS-only) but, unlike the `allowBackup` / `signing.gradle` splices, it never
  verifies that `AndroidManifest.xml` carries
  `android:networkSecurityConfig="@xml/network_security_config"`. A4-079 is currently
  effective _only because_ Capacitor's default template happens to add that exact
  attribute (confirmed in the generated manifest line 17). If a future Capacitor
  template drops or renames it, the cleartext-blocking config silently becomes a
  dead file with no CI signal — the same class of regression the script's other
  steps guard against with loud anchors.
- **Fix:** Add a post-condition `grep` for the `android:networkSecurityConfig`
  attribute (and splice it if absent), mirroring the A2-1209 backup-attr guard.
- **Ref:** A4-079; checklist §7 (config), §24.

### M-08 · P3 · Test gap — no automated guard that the overlays actually land after a sync

- **File:** `.github/workflows/ci.yml` (mobile build job builds the web static
  export only; `apply-native-overlays.sh` is never executed in CI)
- **Evidence:** CI line 559-560 runs `npm run build:mobile`; no job runs
  `cap sync` + `apply-native-overlays.sh` or asserts the resulting manifest/plist.
  The only test touching overlays is `scripts/lint-docs.sh` (doc parity, not
  behavior). The script's own internal post-conditions are the sole safety net,
  and they only fire when an operator runs it locally.
- **Impact:** A regression in the overlay sed/plutil logic (or a Capacitor template
  change) ships silently until an operator notices A-033/A-034 protection missing.
- **Fix:** A CI smoke job that runs `cap sync` against a throwaway native tree +
  `apply-native-overlays.sh` and asserts the backup attrs, NSFaceID key, and
  signing wiring are present.
- **Ref:** checklist §8 (CI), §12 (test coverage).

### M-09 · P3 · Build safety — release builds silently fall back to _unsigned_ when `keystore.properties` is absent

- **File:** `apps/mobile/native-overlays/android/app/signing.gradle:56-63`
- **Evidence:** When `keystore.properties` is missing, `signing.gradle` logs a
  Gradle `warn` and the release variant builds **unsigned** rather than failing.
  Documented behavior ("fine for local smoke"), but a `logger.warn` is easy to miss
  in a long Gradle log, and an unsigned/debug-signed APK handed to a tester or
  uploaded to a sideload channel is a real foot-gun.
- **Impact:** Risk of distributing an unsigned or debug-signed release artifact
  believing it is signed. Low because the store upload path rejects it, but the
  sideload path (M-03) does not.
- **Fix:** Gate on a build property (e.g. `-PrequireSigning=true`) so explicit
  release/CI builds _fail hard_ without a keystore while local smoke stays lenient.
- **Ref:** checklist §24 (signing config, unsigned fallback), §7.

### M-10 · P3 · Doc accuracy — keystore.properties.example mis-attributes its gitignore coverage

- **File:** `apps/mobile/native-overlays/android/keystore.properties.example:6-8`
- **Evidence:** The comment claims `keystore.properties` is ignored "via cap add
  android's .gitignore (`local.properties`-style exclusion)". In fact the
  `android/.gitignore` does **not** list `keystore.properties` (its `*.keystore`
  rule is commented out, lines 56-58); the file is safe only because the **root**
  `.gitignore:16` ignores the entire `apps/mobile/android/` tree (verified via
  `git check-ignore`). The stated mechanism is wrong even though the outcome is safe.
- **Impact:** If someone "fixes" the root ignore or moves the keystore outside the
  android tree trusting the android-level ignore, a keystore password could be
  committed. Documentation integrity / latent secret-leak risk.
- **Fix:** Correct the comment to point at the root `.gitignore` entry, or add an
  explicit `keystore.properties` line to `android/.gitignore` as belt-and-braces.
- **Ref:** checklist §2 (secrets), §5 (doc integrity).

### M-11 · P3 · Design note (not a defect) — app-lock prompts only on cold start, never on resume

- **File:** `apps/web/app/native/app-lock.ts:43-55`
- **Evidence:** Deliberate, well-reasoned design (a gift card can only be bought by
  paying XLM from the user's own wallet, so a thief with a briefly-unlocked handset
  can't transact; re-prompting on every context switch is hostile). Recorded here
  only so the audit's app-lock dimension is consciously closed rather than missed.
- **Impact:** With the wallet model now Privy-MPC (ADR 030), the access token also
  unlocks the Privy session for ≤15 min, and gift-card _codes_ (already-fulfilled
  orders) are viewable on resume without re-auth. Worth re-confirming the tradeoff
  against ADR-030, but consistent with ADR-027's documented posture.
- **Fix:** None required; re-validate the "no resume re-prompt" choice against the
  Privy wallet blast radius at the ADR-027 Phase-2 review (M-03).
- **Ref:** ADR 027 (jailbreak/root row), ADR 030.

---

## Positives (verified clean — no finding)

- **Plugin boundary (checklist §24):** zero `@capacitor/*` / `@aparajita/capacitor-*`
  / `@capgo/*` imports outside `app/native/`; ESLint `no-restricted-imports`
  (`eslint.config.js:109-126`) enforces it with the full plugin-family glob.
- **Version parity (§24, §10):** all 17 shared plugins match exactly between
  `apps/web/package.json` and `apps/mobile/package.json`. `@capacitor/splash-screen`
  is mobile-only and configured natively (not imported in web JS), so the AGENTS.md
  "declare in both" rule correctly does not apply.
- **Secure storage + migration (ADR-006, §16):** refresh token, email, and pending
  order state use `@aparajita/capacitor-secure-storage` (Keychain
  `AfterFirstUnlockThisDeviceOnly` / EncryptedSharedPreferences) with correct
  one-shot Preferences→SecureStorage migration and legacy-residue sweep on
  write/clear. Thenable-Proxy façade bug is handled and commented.
- **Overlays survive regen (ADR-007, §24):** `apply-native-overlays.sh` is
  idempotent (`cp_if_changed`), fail-closed on missing sed anchors (A2-1209 for
  `allowBackup`, signing-gradle anchor check), and confirmed effective against the
  generated manifest (backup attrs, location perms, FileProvider scope, signing
  wiring all present).
- **A-033 / A-034 / A4-079 / A2-1213:** backup exclusions, NSFaceIDUsageDescription,
  HTTPS-only network config, and the share-scoped FileProvider are all correct and
  applied.
- **Bearer-in-memory (§24):** access tokens never touch secure storage; only the
  refresh token + email + pending order are persisted.
- **WebView URL safety (§2):** `webview.ts` rejects non-http(s), embedded
  credentials, and (in prod) plain http; web fallback uses `noopener,noreferrer`
  and surfaces popup-blocker failures. Well tested.
- **PrivacyInfo.xcprivacy (§16):** accurate data-type / no-tracking declaration;
  `NSPrivacyAccessedAPITypes` intentionally empty (aggregated from pod manifests).
- **Native trees gitignored (ADR-007):** `ios/` and `android/` fully untracked
  (0 files); 43 overlay sources tracked; keystore.properties confirmed unignorable-to-commit.
- **Test coverage:** web-fallback branches + the security-critical webview URL
  validation are well covered; app-lock and secure-storage have dedicated
  native-branch tests.
