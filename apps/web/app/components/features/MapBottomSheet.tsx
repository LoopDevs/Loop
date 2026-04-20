import { useEffect, useRef, useState } from 'react';
import type { Merchant } from '@loop/shared';
import { LazyImage } from '~/components/ui/LazyImage';
import { getImageProxyUrl } from '~/utils/image';
import { PurchaseContainer } from '~/components/features/purchase/PurchaseContainer';

interface MapBottomSheetProps {
  merchant: Merchant;
  onClose: () => void;
}

/**
 * Mobile bottom sheet for map pin taps. Structure matches the full
 * merchant page: cover photo edge-to-edge at the top with the logo +
 * name overlaid, then the shared `PurchaseContainer` below so the
 * entire purchase flow (denomination pick → pay) is available without
 * leaving the map.
 *
 * The cover photo + drag handle accept a drag gesture — swipe the
 * sheet down past the dismiss threshold and it closes. Drags shorter
 * than that snap back into place. Drag listeners are scoped to the
 * cover area so the scrollable PurchaseContainer below still scrolls
 * normally.
 */
export function MapBottomSheet({ merchant, onClose }: MapBottomSheetProps): React.JSX.Element {
  const coverUrl = merchant.cardImageUrl ? getImageProxyUrl(merchant.cardImageUrl, 640) : undefined;
  const logoUrl = merchant.logoUrl ? getImageProxyUrl(merchant.logoUrl, 96) : undefined;

  // Drag-to-close state. `dragY` is how far the sheet has been pulled
  // down from its resting position (in px). `isClosing` flips true
  // when any dismiss path (drag past threshold, backdrop tap, Escape)
  // fires — the sheet then animates down off the viewport before
  // unmounting via onTransitionEnd. Unmounting instantly on dismiss
  // cut the slide-out animation entirely and felt abrupt.
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const dragStartYRef = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const DISMISS_THRESHOLD_PX = 120;
  // Enough to guarantee the sheet leaves the viewport regardless of
  // the device height — browsers clamp to the viewport bottom anyway.
  const OFFSCREEN_TRANSLATE_PX = 1200;

  // All dismiss paths go through this so everything slides out rather
  // than popping. Guard against double-fire — the transition-end
  // listener only cares about the first trigger.
  const startClose = (): void => {
    setIsClosing(true);
  };

  // Keyboard dismiss. No autofocus inside the sheet — PurchaseContainer
  // manages its own focus flow (e.g., amount input) once mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') startClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (isClosing) return;
    dragStartYRef.current = e.clientY;
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragStartYRef.current === null) return;
    const delta = e.clientY - dragStartYRef.current;
    // Only drag downward — upward drags snap back to 0.
    setDragY(Math.max(0, delta));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    setIsDragging(false);
    dragStartYRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (dragY > DISMISS_THRESHOLD_PX) {
      startClose();
    } else {
      setDragY(0);
    }
  };

  // Once the exit transition completes we unmount for real.
  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>): void => {
    if (isClosing && e.propertyName === 'transform') {
      onClose();
    }
  };

  // Effective translate: while closing, push the sheet fully off
  // screen so the transition carries it out; otherwise track the
  // active drag offset (or 0 when idle).
  const translate = isClosing ? OFFSCREEN_TRANSLATE_PX : dragY;

  return (
    <>
      {/* Light backdrop so the map + pin underneath still shows; user
          can dismiss with a tap, Escape, or via the close affordance
          on the sheet itself. */}
      <div
        role="button"
        tabIndex={-1}
        aria-label="Close merchant details"
        className={`fixed inset-0 z-[1000] bg-black/25 transition-opacity duration-300 ${
          isClosing ? 'opacity-0' : 'animate-fade-in opacity-100'
        }`}
        onClick={startClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            startClose();
          }
        }}
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${merchant.name} purchase`}
        className={`fixed left-0 right-0 z-[1050] ${isClosing ? '' : 'animate-slide-up'}`}
        style={{
          // Sit the sheet directly above the bottom tab bar so the
          // tab bar stays visible and the sheet's bottom edge isn't
          // hidden underneath it. `--tab-height` is 0 on lg+, which
          // collapses this back to a plain bottom-0 anchor.
          bottom: 'var(--tab-height, 0px)',
          transform: translate > 0 ? `translateY(${translate}px)` : undefined,
          // Active drag: no transition so the sheet tracks the finger
          // 1:1. Otherwise (snap-back OR close) a timed transition
          // carries it. 0.3s when closing so the off-screen travel
          // reads as intentional motion, 0.2s for snap-back so a
          // short wiggle doesn't feel sluggish.
          transition: isDragging ? 'none' : `transform ${isClosing ? '0.3s' : '0.2s'} ease-out`,
        }}
        onTransitionEnd={handleTransitionEnd}
      >
        <div
          // Subtract the measured Navbar height so the sheet never
          // extends under it — without this, the Navbar overlays the
          // top of the scroll area, intercepts touches, and scroll
          // silently breaks. `--nav-height` is set by a ResizeObserver
          // in root.tsx; the 5rem fallback matches the Navbar's
          // non-safe-area idle height for first paint before the
          // observer fires. dvh honours the dynamic viewport
          // (address-bar hide/show) vs vh's fixed large value.
          className="bg-white dark:bg-gray-900 rounded-t-2xl shadow-2xl overflow-hidden max-w-lg mx-auto flex flex-col"
          style={{
            maxHeight: 'calc(100dvh - var(--nav-height, 5rem) - var(--tab-height, 0px))',
          }}
        >
          {/* Cover photo + drag handle — the draggable area. Owns the
              pointer-event handlers so PurchaseContainer below still
              scrolls normally. `touchAction: none` disables the
              browser's default vertical-scroll gesture on this strip
              so our drag tracking isn't fighting the scroller. */}
          <div
            className="relative h-36 flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
            style={{ touchAction: 'none' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {coverUrl !== undefined ? (
              <LazyImage
                src={coverUrl}
                alt={`${merchant.name} card`}
                className="absolute inset-0 w-full h-full pointer-events-none"
                eager
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600 pointer-events-none" />
            )}
            <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-white/75 shadow-sm pointer-events-none" />
            <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/70 via-black/30 to-transparent pointer-events-none" />
            <div className="absolute bottom-3 left-4 right-4 flex items-center gap-3 pointer-events-none">
              <div className="h-12 w-12 rounded-lg bg-white dark:bg-gray-800 shadow-sm flex items-center justify-center overflow-hidden flex-shrink-0">
                {logoUrl !== undefined ? (
                  <LazyImage
                    src={logoUrl}
                    alt={`${merchant.name} logo`}
                    className="w-full h-full"
                    eager
                  />
                ) : (
                  <span className="text-gray-500 text-sm font-bold">{merchant.name.charAt(0)}</span>
                )}
              </div>
              <h3 className="text-white text-lg font-bold drop-shadow truncate">{merchant.name}</h3>
            </div>
          </div>

          {/* Purchase flow — scrolls internally when the form grows past
              the sheet's 85dvh cap. */}
          <div className="overflow-y-auto flex-1 p-4">
            <PurchaseContainer merchant={merchant} />
          </div>
        </div>
      </div>
    </>
  );
}
