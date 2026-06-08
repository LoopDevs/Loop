import { Link } from 'react-router';

/**
 * Small back-arrow that lets a user escape the sign-up / login flow
 * back to the main site. Sits at the top of the form column on the
 * auth + onboarding pages.
 */
export function BackToSite({
  to = '/',
  className = '',
}: {
  to?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      aria-label="Back to Loop"
      className={`mb-8 inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-white text-ink-muted transition-colors hover:bg-gray-50 hover:text-ink ${className}`.trim()}
    >
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
    </Link>
  );
}
