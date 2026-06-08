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
    { elevation = 'none', padding = 'md', interactive = false, className = '', children, ...props },
    ref,
  ) => {
    const base = 'bg-surface border border-line rounded-lg';
    const interactiveClass = interactive
      ? 'transition-[border-color,box-shadow,transform] duration-150 hover:border-line-strong hover:shadow-md hover:-translate-y-0.5 cursor-pointer'
      : '';
    return (
      <div
        ref={ref}
        className={`${base} ${ELEVATION[elevation]} ${PADDING[padding]} ${interactiveClass} ${className}`.trim()}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';
