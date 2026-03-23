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

- [ ] **Pull-to-refresh** — native pull-down gesture on merchant list (home) and order list (orders) that triggers TanStack Query refetch. CSS `overscroll-behavior` + touch event handling or Capacitor plugin.
- [ ] **System font on mobile** — swap Inter (Google Fonts network request) for `system-ui` font stack on mobile builds. SF Pro on iOS, Roboto on Android. Faster load, feels native. Keep Inter on web.
- [ ] **Loading skeletons** — replace Spinner with skeleton placeholders for merchant cards, order rows, merchant detail. Feels more native than centered spinners.
- [ ] **Network status indicator** — show banner when offline ("No internet connection"). Use `@capacitor/network` plugin to detect connectivity changes. Hide banner on reconnect.

## Phase 2 — Advanced native features

- [ ] **Page transitions** — animate route changes (slide left/right for push/pop navigation). CSS transitions on route change or Framer Motion. Match iOS/Android native transition patterns.
- [ ] **Biometric app lock** — optional Face ID / Touch ID to open the app or authorize purchases. Use `@capacitor-community/biometric-auth`. Required for Phase 2 Stellar transaction signing.
- [ ] **Deep linking** — `loopfinance.io/gift-card/:slug` opens the app directly to that merchant. iOS Universal Links + Android App Links. Configure in Capacitor `@capacitor/app` + server-side `apple-app-site-association` / `assetlinks.json`.
- [ ] **Push notifications** — order status updates (payment received, gift card ready). Wire up `@capacitor/push-notifications`: register on app open, send token to backend, backend triggers push on order status change.
- [ ] **App badge** — show pending order count on app icon via push notification badge.
- [ ] **Prevent screenshots on sensitive screens** — gift card code screen. Android: `FLAG_SECURE` window flag. iOS: detect app backgrounding and blur sensitive content.
- [ ] **Native share sheet** — share gift card code via `@capacitor/share` plugin on PurchaseComplete screen.

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

### Capacitor plugins needed

```
Already installed:
  @capacitor/app          — back button, deep linking
  @capacitor/haptics      — haptic feedback
  @capacitor/preferences  — token storage
  @capacitor/push-notifications — push (not wired)
  @capacitor/splash-screen — splash config

Need to install:
  @capacitor/status-bar   — status bar styling
  @capacitor/keyboard     — keyboard handling
  @capacitor/clipboard    — copy to clipboard
  @capacitor/network      — offline detection
  @capacitor/share        — native share sheet (Phase 2)
  @capacitor-community/biometric-auth — biometrics (Phase 2)
```
