/**
 * Avatar — the signed-in identity mark used in the navbar account
 * menu. Renders an image when available, otherwise a blue initials
 * disc derived from the user's email/name. Circular by design
 * (`rounded-full`) so it stays a recognisable "account" affordance.
 */
type Size = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** Source string (email or name) the initials are derived from. */
  name?: string | null;
  /** Optional avatar image URL. */
  src?: string | null;
  size?: Size;
  className?: string;
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
};

/** First letter of the local-part for an email, else first letter(s). */
function initials(source: string | null | undefined): string {
  if (source === null || source === undefined || source.trim() === '') return '?';
  const local = source.includes('@') ? source.split('@')[0]! : source;
  const parts = local.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export function Avatar({ name, src, size = 'md', className = '' }: AvatarProps): React.JSX.Element {
  const base = `inline-flex items-center justify-center rounded-full font-semibold select-none ${SIZES[size]} ${className}`;
  if (src !== null && src !== undefined && src !== '') {
    return (
      <img
        src={src}
        alt={name ?? 'Account'}
        className={`${base} object-cover border border-line`}
      />
    );
  }
  return (
    <span aria-hidden="true" className={`${base} bg-blue-600 text-white ring-2 ring-blue-100`}>
      {initials(name)}
    </span>
  );
}
