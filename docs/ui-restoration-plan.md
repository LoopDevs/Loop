# UI Restoration Plan

Restoring features from the original dash-spend app that were simplified during migration.

---

## 1. Home hero SVG icons

**Status:** Done
**Effort:** 15 min
**Files:** `apps/web/app/routes/home.tsx`

Replace emoji icons (⚡📍💰) with proper SVGs matching the original (lightning bolt, map pin, dollar circle). Change `Feature` component `icon` prop from string to `React.ReactNode`.

> Done: Replaced emoji strings with inline SVGs (lightning bolt, map pin, dollar circle). Changed `Feature` icon prop type from `string` to `React.ReactNode` and updated container from `text-2xl` to `flex justify-center`.

## 2. Toast renderer component

**Status:** Done
**Effort:** 20 min
**Files:** `apps/web/app/components/ui/ToastContainer.tsx` (new), `apps/web/app/root.tsx`, `apps/web/app/app.css`

The `useUiStore` already has `addToast`/`removeToast` with auto-dismiss. Create a visible renderer component mounted in NativeShell. Floating notifications at top-right (desktop) or top-center (mobile).

> Done: Created `ToastContainer` component with success/error/info styles, dismiss button, and slide-in-right animation. Mounted in `NativeShell` after `NativeBackButton`. Added `animate-slide-in` keyframes to `app.css`.

## 3. Purchase card merchant header

**Status:** Done
**Effort:** 15 min
**Files:** `apps/web/app/components/features/purchase/PurchaseContainer.tsx`

Add merchant name + savings badge at the top of the purchase card (when authenticated, before the amount selection). The merchant data is already passed as a prop.

> Done: Added merchant name heading and conditional savings percentage badge above the "Purchasing as" line in the authenticated return block.

## 4. LazyImage component

**Status:** Done
**Effort:** 30 min
**Files:** `apps/web/app/components/ui/LazyImage.tsx` (new), `apps/web/app/components/features/MerchantCard.tsx`, `apps/web/app/routes/gift-card.$name.tsx`

Shimmer placeholder → fade-in on load → error fallback. Replace raw `<img>` tags across the app. Uses React `onLoad`/`onError` state + CSS transitions (not manual DOM manipulation like the original).

> Done: Created `LazyImage` with shimmer placeholder (animate-pulse), fade-in on load, and error fallback. Integrated into `MerchantCard` (card image + logo) and gift card detail page (card image, purchase card logo, desktop logo). Map popups not updated (item 5 scope).

## 5. Map mobile bottom sheet

**Status:** Done
**Effort:** 45 min
**Files:** `apps/web/app/components/features/MapBottomSheet.tsx` (new), `apps/web/app/components/features/ClusterMap.tsx`, `apps/web/app/routes/map.tsx`

On mobile: click pin → bottom sheet slides up with merchant card image, name, savings, denomination range, "Buy Gift Card" button (navigates to detail page). On desktop: keep the existing rich popup.

React component with state + CSS transition (not raw DOM like the original). ClusterMap exposes a `onMerchantSelect` callback, map route manages the bottom sheet state.

> Done: Created `MapBottomSheet` component with card image, logo, merchant name, savings badge, denomination range, and "Buy Gift Card" link. Added `animate-fade-in` (backdrop) and `animate-slide-up` (sheet) keyframes to `app.css`. ClusterMap accepts `onMerchantSelect` prop via ref (avoids re-creating map on callback change). Map route manages `selectedMerchantId` state, looks up merchant from the existing `useMerchants` cache (no extra API call), and renders bottom sheet inside `md:hidden` wrapper so desktop keeps the Leaflet popup only.

---

## Decided NOT to restore

| Component                             | Reason                                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| `VirtualMerchantGrid`                 | 346 merchants renders fine without virtualization. Revisit at 1000+. |
| `Badge/Card/Dialog/Select` primitives | Not needed in 3+ places yet. Using Tailwind directly.                |
| `PerformanceDashboard`                | Dev-only tool                                                        |
| `StreamingDemo`                       | Prototype, not relevant                                              |
| `LazyPurchaseFlow` (code-split)       | Our purchase components are already small. Premature optimization.   |
