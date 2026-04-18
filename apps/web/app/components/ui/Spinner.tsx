export function Spinner({
  size = 'md',
  label = 'Loading',
}: {
  size?: 'sm' | 'md' | 'lg';
  /** Override the AT label when the surrounding context is more specific. */
  label?: string;
}): React.JSX.Element {
  const sizes = { sm: 'h-4 w-4', md: 'h-8 w-8', lg: 'h-12 w-12' };
  // `role="status"` makes the wrapper an implicit polite live region, so
  // AT announces the label when the spinner appears. The SVG itself is
  // decorative (`aria-hidden`) and we emit a visually-hidden `<span>`
  // with the label — SVG `aria-label` support is inconsistent across
  // screen readers; a sr-only text node is universal.
  return (
    <span role="status" className="inline-flex items-center justify-center">
      <svg
        aria-hidden="true"
        className={`animate-spin text-blue-500 ${sizes[size]}`}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
