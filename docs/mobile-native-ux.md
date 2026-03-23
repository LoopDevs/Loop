# Mobile Native UX Checklist

Making the Capacitor WebView app feel native on iOS and Android.

---

## Phase 1 — App Store submission (must-have)

- [ ] **Safe area handling** — status bar, home indicator (iPhone), notch, camera cutout (Android). Add `viewport-fit=cover` meta tag + `env(safe-area-inset-*)` CSS padding on root layout, tab bar, and full-screen views (map).
- [ ] **Bottom tab bar** — fixed bottom navigation visible only on native (hidden on web). 4 tabs: Home, Map, Orders, Account/Profile. Replace the hidden web navbar as the mobile navigation.
- [ ] **Status bar styling** — match status bar text color to app theme (light content on dark bg, dark content on light bg). Use `@capacitor/status-bar` plugin. Update on theme toggle.
- [ ] **Android back button** — hardware/gesture back navigates history, confirms exit on home screen. Use `@capacitor/app` `backButton` listener.
- [ ] **Keyboard handling** — inputs scroll into view when keyboard opens, not covered. Configure `KeyboardResize` in Capacitor config or `adjustPan` on Android. Ensure email, OTP, and amount inputs are visible when focused.
- [ ] **Viewport meta fixes** — add `viewport-fit=cover` (safe areas), `maximum-scale=1` (prevent iOS auto-zoom on inputs < 16px), `user-scalable=no` (prevent double-tap zoom breaking app feel).
- [ ] **Copy to clipboard** — "Copy" button on payment address (PaymentStep) and gift card code (PurchaseComplete). Use `navigator.clipboard` with `@capacitor/clipboard` fallback. Haptic feedback on copy.
- [ ] **Touch target audit** — ensure all tappable elements meet minimum 44x44pt (iOS) / 48x48dp (Android). Audit: navbar mobile links (`text-xs`), denomination buttons, search results, map markers.

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
