import { useEffect, type RefObject } from 'react';

/**
 * Accessibility primitive (CF-35 / A11Y-004 / A11Y-005): trap keyboard focus
 * inside an open dialog/listbox, move focus in on open, restore it to the
 * triggering element on close, and close on Escape.
 *
 * Modals before this hook let Tab/Shift+Tab escape to the background page and
 * never returned focus to the trigger — disorienting for keyboard and
 * screen-reader users on the country picker and the map bottom sheet, the two
 * surfaces that gate the purchase flow.
 *
 * Pass `active=false` to disable (the trap is a no-op while the dialog is
 * closed). `containerRef` must point at the dialog root once it mounts.
 *
 * - On activate: stashes `document.activeElement`, then focuses
 *   `initialFocusRef` if supplied, else the first tabbable child, else the
 *   container itself.
 * - While active: Tab from the last tabbable wraps to the first and
 *   Shift+Tab from the first wraps to the last; Escape calls `onClose`.
 * - On deactivate/unmount: restores focus to the stashed element.
 */
export function useFocusTrap<T extends HTMLElement>({
  active,
  containerRef,
  onClose,
  initialFocusRef,
}: {
  active: boolean;
  containerRef: RefObject<T | null>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
}): void {
  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (container === null) return undefined;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const isVisible = (el: HTMLElement): boolean => {
      if (el === document.activeElement) return true;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
      // `getComputedStyle` is reliable in both browsers and jsdom; `offsetParent`
      // is always null in jsdom (no layout), so don't gate on it.
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const tabbables = (): HTMLElement[] => {
      const nodes = container.querySelectorAll<HTMLElement>(
        'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter(isVisible);
    };

    // Move focus in on open. Prefer an explicit initial target (e.g. the
    // search input), then the first tabbable child, then the container.
    const initial = initialFocusRef?.current ?? tabbables()[0] ?? container;
    // The container may need tabindex=-1 to be programmatically focusable.
    if (initial === container && !container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }
    initial.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = tabbables();
      if (focusable.length === 0) {
        // Nothing tabbable — keep focus pinned to the container.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !container.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to whatever was focused before the trap opened.
      previouslyFocused?.focus();
    };
    // initialFocusRef is a stable ref object; onClose/containerRef are
    // expected stable for the lifetime of the open state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
