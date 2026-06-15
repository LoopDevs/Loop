import { useCallback, type KeyboardEvent } from 'react';

/**
 * WAI-ARIA radiogroup keyboard contract (CF-35 / A11Y-007 / A11Y-021).
 *
 * `role="radiogroup"` pickers in the purchase + onboarding money paths (home
 * currency, payment rail, wallet rail) had every radio as a simultaneous tab
 * stop with no arrow-key navigation — violating the radio keyboard spec. This
 * hook returns the `tabIndex` for each radio (roving: only the selected one,
 * or the first when none selected, is in the tab order) plus an `onKeyDown`
 * that moves selection with Arrow / Home / End keys.
 *
 * Usage on each radio button:
 *   tabIndex={rovingTabIndex(index)}
 *   onKeyDown={(e) => onKeyDown(e, index)}
 *
 * `options` is the ordered list of selectable values; `selected` is the
 * current value (or null); `onSelect` is called with the new value when an
 * arrow key moves selection. Arrow keys both move focus AND select, per the
 * ARIA radiogroup pattern.
 */
export function useRadioGroupKeys<V>({
  options,
  selected,
  onSelect,
}: {
  options: readonly V[];
  selected: V | null;
  onSelect: (value: V) => void;
}): {
  rovingTabIndex: (index: number) => 0 | -1;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, index: number) => void;
} {
  const selectedIndex = selected === null ? -1 : options.indexOf(selected);
  // The roving tab stop: the selected radio, or the first if none selected.
  const tabStopIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const rovingTabIndex = useCallback(
    (index: number): 0 | -1 => (index === tabStopIndex ? 0 : -1),
    [tabStopIndex],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, index: number): void => {
      const len = options.length;
      if (len === 0) return;
      let nextIndex: number | null = null;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (index + 1) % len;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (index - 1 + len) % len;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = len - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const value = options[nextIndex]!;
      onSelect(value);
      // Move focus to the newly-selected radio (roving tabindex updates on
      // the re-render, but focus must move imperatively to stay in sync).
      const group = e.currentTarget.closest('[role="radiogroup"]');
      const radios = group?.querySelectorAll<HTMLElement>('[role="radio"]');
      radios?.[nextIndex]?.focus();
    },
    [options, onSelect],
  );

  return { rovingTabIndex, onKeyDown };
}
