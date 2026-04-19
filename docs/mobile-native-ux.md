# Mobile Native UX Checklist

Making the Capacitor WebView app feel native on iOS and Android.

---

## Phase 1 — App Store submission (must-have)

- [x] **Safe area handling** — `viewport-fit=cover` + CSS `env(safe-area-inset-*)` utility classes. NativeShell adds top safe area + bottom padding for tab bar.
- [x] **Bottom tab bar** — `NativeTabBar` component with Home/Map/Orders/Account tabs. Fixed bottom, safe-area-aware, native only.
- [x] **Status bar styling** — `@capacitor/status-bar` overlay mode + theme-matched style. Set on app mount in NativeShell.
- [x] **Android back button** — `@capacitor/app` backButton listener. Navigates history or exits app.
- [x] **Keyboard handling** — Capacitor Keyboard plugin configured with `resize: 'body'` + `resizeOnFullScreen: true` in capacitor.config.ts.
- [x] **Viewport meta fixes** — `width=device-width, initial-scale=1, viewport-fit=cover`. `maximum-scale=1` / `user-scalable=no` were intentionally removed (PR #143) so mobile web satisfies WCAG 1.4.4 (Resize Text); the Capacitor webview doesn't need them either.
- [x] **Copy to clipboard** — Copy buttons on payment address (PaymentStep) and gift card code (PurchaseComplete). Capacitor Clipboard on native, navigator.clipboard on web. Haptic on copy.
- [x] **Touch target audit** — `min-h-[44px]` on all Buttons, `py-3 min-h-[44px]` on denomination buttons. Navbar mobile links are web-only (hidden on native). Tab bar tabs are 56px tall.

## Phase 1 — Polish (before launch)

- [x] **Pull-to-refresh** — TanStack Query `refetchOnWindowFocus: true` on merchant hooks. Data refreshes when user returns to the app.
- [x] **System font on mobile** — `html.native` class activates `system-ui` font stack. Inter kept on web.
- [x] **Loading skeletons** — `MerchantCardSkeleton` (8-card grid on home) and `OrderRowSkeleton` (5-row list on orders) replace Spinner components.
- [x] **Network status indicator** — `OfflineBanner` component + `watchNetwork()` native module. Shows red banner when offline, auto-hides on reconnect.

## Phase 2 — Advanced native features

- [x] **Page transitions** — CSS `slide-in` animation on route change (native only). Triggered via `key={location.pathname}` on content wrapper.
- [x] **Biometric app lock** — Face ID / Touch ID via `@aparajita/capacitor-biometric-auth`. Toggle on Account page. Lock screen on app resume with biometric prompt. Preference persisted in Capacitor Preferences.
- [ ] **Deep linking** — `loopfinance.io/gift-card/:slug` opens the app directly to that merchant. iOS Universal Links + Android App Links. Configure in Capacitor `@capacitor/app` + server-side `apple-app-site-association` / `assetlinks.json`.
- [ ] **Push notifications** — order status updates (payment received, gift card ready). Wire up `@capacitor/push-notifications`: register on app open, send token to backend, backend triggers push on order status change.
- [ ] **App badge** — show pending order count on app icon via push notification badge.
- [x] **Prevent screenshots on sensitive screens** — blur overlay on app background (iOS task switcher). Applied on PurchaseComplete screen via `enableScreenshotGuard()`.
- [x] **Native share sheet** — "Share" button on PurchaseComplete. Uses `@capacitor/share` on native, Web Share API on web.

---

## Implementation notes

### Safe areas

```css
/* Root layout padding */
padding-top: env(safe-area-inset-top);
padding-bottom: env(safe-area-inset-bottom);
padding-left: env(safe-area-inset-left);
padding-right: env(safe-area-inset-right);
```

### Viewport meta (in root.tsx)

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

`maximum-scale=1` / `user-scalable=no` were intentionally dropped in
PR #143 for WCAG 1.4.4 (Resize Text) compliance on the mobile web
build — iOS has respected `maximum-scale=1` since iOS 10 regardless
of `user-scalable=no`, so leaving them in actively blocked low-vision
users from zooming text. Capacitor's native webview is fine without
the restriction.

### Bottom tab bar structure

```
┌─────────────────────────────────┐
│        App content area         │
│                                 │
├─────────────────────────────────┤
│  🏠 Home  🗺️ Map  📋 Orders  👤 Account │
└─────────────────────────────────┘
```

- Fixed to bottom, above safe area inset
- Visible only when `isNativePlatform()` is true
- Highlights active tab based on current route
- Account tab: shows auth state (sign in / email)

### Capacitor plugins installed

All plugins referenced anywhere in the app are already installed — see
`apps/mobile/package.json` + `apps/web/package.json` for the pinned
versions.

```
@capacitor/app                         — back button, deep linking
@capacitor/clipboard                   — copy to clipboard
@capacitor/haptics                     — haptic feedback
@capacitor/keyboard                    — keyboard handling + accessory bar
@capacitor/network                     — offline detection
@capacitor/preferences                 — pending-order + app-lock-enabled flag storage
@capacitor/push-notifications          — order notifications (wired as of Phase 2)
@capacitor/share                       — native share sheet
@capacitor/splash-screen               — splash config
@capacitor/status-bar                  — status bar styling + overlay
@capgo/inappbrowser                    — in-app browser for redeem URLs
@aparajita/capacitor-biometric-auth    — Face ID / Touch ID for the app lock
@aparajita/capacitor-secure-storage    — refresh token + user email (Keychain / EncryptedSharedPreferences, audit A-024, ADR-006)
```

> The biometric plugin is `@aparajita/capacitor-biometric-auth`, not the
> older `@capacitor-community/biometric-auth` package some earlier docs
> pointed at — the community plugin has been unmaintained since Capacitor 5.

### Native-config overlays

`apps/mobile/android/` and `apps/mobile/ios/` are gitignored (see audit
A-012 in `docs/audit-tracker.md`), so any config that must land in a
native file is versioned instead under `apps/mobile/native-overlays/`
and applied by `apps/mobile/scripts/apply-native-overlays.sh`. Run the
script after `npx cap add` or whenever `cap sync` may have regenerated
config. It is idempotent — it checks before writing.

Current overlays:

| File                                        | Target                                                   | Why                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `android/.../xml/backup_rules.xml`          | `android/app/src/main/res/xml/backup_rules.xml`          | Audit A-033: pre-Android-12 `fullBackupContent` rule excluding the Capacitor Preferences SharedPreferences.   |
| `android/.../xml/data_extraction_rules.xml` | `android/app/src/main/res/xml/data_extraction_rules.xml` | Audit A-033: Android-12+ `dataExtractionRules` excluding the same file from cloud-backup and device-transfer. |
| `ios/.../Info.plist.additions.txt`          | `ios/App/App/Info.plist` (PlistBuddy merge)              | Audit A-034: adds `NSFaceIDUsageDescription` required by the biometric-auth plugin + App Store review.        |

The Android overlay also patches `AndroidManifest.xml` to reference the
two new XML files via `fullBackupContent` / `dataExtractionRules`
attributes on `<application>`.

Rerun after each `npx cap add android` / `npx cap add ios` (audit A-012
leaves those native projects ungenerated in fresh checkouts), or if you
bump the Capacitor CLI and `cap sync` rewrites a config file.
