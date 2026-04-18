# Mobile Native UX Checklist

Making the Capacitor WebView app feel native on iOS and Android.

---

## Phase 1 — App Store submission (must-have)

- [x] **Safe area handling** — `viewport-fit=cover` + CSS `env(safe-area-inset-*)` utility classes. NativeShell adds top safe area + bottom padding for tab bar.
- [x] **Bottom tab bar** — `NativeTabBar` component with Home/Map/Orders/Account tabs. Fixed bottom, safe-area-aware, native only.
- [x] **Status bar styling** — `@capacitor/status-bar` overlay mode + theme-matched style. Set on app mount in NativeShell.
- [x] **Android back button** — `@capacitor/app` backButton listener. Navigates history or exits app.
- [x] **Keyboard handling** — Capacitor Keyboard plugin configured with `resize: 'body'` + `resizeOnFullScreen: true` in capacitor.config.ts.
- [x] **Viewport meta fixes** — `viewport-fit=cover`, `maximum-scale=1`, `user-scalable=no`.
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
<meta
  name="viewport"
  content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no"
/>
```

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
@capacitor/app                       — back button, deep linking
@capacitor/clipboard                 — copy to clipboard
@capacitor/haptics                   — haptic feedback
@capacitor/keyboard                  — keyboard handling + accessory bar
@capacitor/network                   — offline detection
@capacitor/preferences               — token + pending-order + app-lock storage
@capacitor/push-notifications        — order notifications (wired as of Phase 2)
@capacitor/share                     — native share sheet
@capacitor/splash-screen             — splash config
@capacitor/status-bar                — status bar styling + overlay
@capgo/inappbrowser                  — in-app browser for redeem URLs
@aparajita/capacitor-biometric-auth  — Face ID / Touch ID for the app lock
```

> The biometric plugin is `@aparajita/capacitor-biometric-auth`, not the
> older `@capacitor-community/biometric-auth` package some earlier docs
> pointed at — the community plugin has been unmaintained since Capacitor 5.
