/**
 * Card — the workhorse surface of the Loop design language.
 *
 * A near-flat white panel with a hairline border + 2px corners.
 * Elevation is opt-in (`elevation="sm" | "md"`) and intentionally
 * restrained — clean/minimal leans on the border, not the shadow.
 * `interactive` adds a hover lift for clickable cards (merchant
 * tiles, list rows).
 */
import { forwardRef } from 'react';

type Elevation = 'none' | 'sm' | 'md';
type Padding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevation?: Elevation;
  padding?: Padding;
  interactive?: boolean;
}

const ELEVATION: Record<Elevation, string> = {
  none: '',
  sm: 'shadow-xs',
  md: 'shadow-sm',
};

const PADDING: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6 sm:p-8',
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      elevation = 'none',
      padding = 'md',
      interactive = false,
      className = '',
      children,
      onClick,
      onKeyDown,
      role,
      tabIndex,
      ...props
    },
    ref,
  ) => {
    const base = 'bg-surface border border-line rounded-lg';
    const interactiveClass = interactive
      ? 'transition-[border-color,box-shadow,transform] duration-150 hover:border-line-strong hover:shadow-md hover:-translate-y-0.5 cursor-pointer'
      : '';

    // An `interactive` Card is meant to behave like a control (the hover
    // lift + `cursor-pointer` advertise clickability, and callers wire an
    // onClick). A bare <div onClick> is invisible to keyboard and screen-
    // reader users, so give it button semantics + activate on Enter/Space —
    // the WAI-ARIA button pattern. `.click()` re-dispatches a real click so
    // the same onClick path (and any bubbling) runs, exactly as a mouse tap.
    // Explicit role/tabIndex/onKeyDown from the caller still win, so a Card
    // that is really a link (or already wraps a native <button>) can opt out.
    const handleKeyDown = interactive
      ? (event: React.KeyboardEvent<HTMLDivElement>) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.currentTarget.click();
          }
        }
      : onKeyDown;

    return (
      <div
        ref={ref}
        className={`${base} ${ELEVATION[elevation]} ${PADDING[padding]} ${interactiveClass} ${className}`.trim()}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        role={interactive ? (role ?? 'button') : role}
        tabIndex={interactive ? (tabIndex ?? 0) : tabIndex}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';
