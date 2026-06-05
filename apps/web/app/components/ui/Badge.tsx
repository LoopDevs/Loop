/**
 * Badge — compact status / metadata pill.
 *
 * Tones map to the semantic palette. Default is a soft-filled chip
 * (tinted background + saturated text) which reads cleaner on a white
 * canvas than a solid fill. `solid` flips to a filled treatment for
 * the rare high-emphasis case (e.g. a "NEW" flag).
 */
type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
type Variant = 'soft' | 'solid' | 'outline';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  variant?: Variant;
}

const SOFT: Record<Tone, string> = {
  neutral: 'bg-gray-100 text-ink-muted',
  brand: 'bg-blue-50 text-blue-700',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
};

const SOLID: Record<Tone, string> = {
  neutral: 'bg-gray-800 text-white',
  brand: 'bg-blue-600 text-white',
  success: 'bg-green-600 text-white',
  warning: 'bg-amber-500 text-white',
  danger: 'bg-red-600 text-white',
};

const OUTLINE: Record<Tone, string> = {
  neutral: 'border border-line-strong text-ink-muted',
  brand: 'border border-blue-200 text-blue-700',
  success: 'border border-green-200 text-green-700',
  warning: 'border border-amber-200 text-amber-700',
  danger: 'border border-red-200 text-red-700',
};

export function Badge({
  tone = 'neutral',
  variant = 'soft',
  className = '',
  children,
  ...props
}: BadgeProps): React.JSX.Element {
  const tones = variant === 'solid' ? SOLID : variant === 'outline' ? OUTLINE : SOFT;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium tracking-[-0.01em] ${tones[tone]} ${className}`.trim()}
      {...props}
    >
      {children}
    </span>
  );
}
