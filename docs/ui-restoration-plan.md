# UI Restoration Plan

Restoring features from the original dash-spend app that were simplified during migration.

---

## 1. Home hero SVG icons

**Status:** Pending
**Effort:** 15 min
**Files:** `apps/web/app/routes/home.tsx`

Replace emoji icons (⚡📍💰) with proper SVGs matching the original (lightning bolt, map pin, dollar circle). Change `Feature` component `icon` prop from string to `React.ReactNode`.

## 2. Toast renderer component

**Status:** Pending
**Effort:** 20 min
**Files:** `apps/web/app/components/ui/ToastContainer.tsx` (new), `apps/web/app/root.tsx`

The `useUiStore` already has `addToast`/`removeToast` with auto-dismiss. Create a visible renderer component mounted in NativeShell. Floating notifications at top-right (desktop) or top-center (mobile).

## 3. Purchase card merchant header

**Status:** Pending
**Effort:** 15 min
**Files:** `apps/web/app/components/features/purchase/PurchaseContainer.tsx`

Add merchant name + savings badge at the top of the purchase card (when authenticated, before the amount selection). The merchant data is already passed as a prop.

## 4. LazyImage component

**Status:** Pending
**Effort:** 30 min
**Files:** `apps/web/app/components/ui/LazyImage.tsx` (new), then update MerchantCard, gift card detail page, map popups

Shimmer placeholder → fade-in on load → error fallback. Replace raw `<img>` tags across the app. Uses React `onLoad`/`onError` state + CSS transitions (not manual DOM manipulation like the original).

## 5. Map mobile bottom sheet

**Status:** Pending
**Effort:** 45 min
**Files:** `apps/web/app/components/features/MapBottomSheet.tsx` (new), `apps/web/app/components/features/ClusterMap.tsx`, `apps/web/app/routes/map.tsx`

On mobile: click pin → bottom sheet slides up with merchant card image, name, savings, denomination range, "Buy Gift Card" button (navigates to detail page). On desktop: keep the existing rich popup.

React component with state + CSS transition (not raw DOM like the original). ClusterMap exposes a `onMerchantSelect` callback, map route manages the bottom sheet state.

---

## Decided NOT to restore

| Component                             | Reason                                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| `VirtualMerchantGrid`                 | 346 merchants renders fine without virtualization. Revisit at 1000+. |
| `Badge/Card/Dialog/Select` primitives | Not needed in 3+ places yet. Using Tailwind directly.                |
| `PerformanceDashboard`                | Dev-only tool                                                        |
| `StreamingDemo`                       | Prototype, not relevant                                              |
| `LazyPurchaseFlow` (code-split)       | Our purchase components are already small. Premature optimization.   |
