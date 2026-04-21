import { useNavigate } from 'react-router';
import { useNativePlatform } from '~/hooks/use-native-platform';

interface PageHeaderProps {
  title: string;
  /**
   * Custom back handler. Defaults to `navigate(-1)` when history is
   * non-empty, otherwise `navigate('/')` — matches the floating
   * back button on the gift-card detail route.
   */
  onBack?: () => void;
  /**
   * Where to go when history is empty. Defaults to `/`, but
   * `/orders/:id` for example wants `/orders` so users don't get
   * bounced to home when they arrived via a shared link.
   */
  fallbackHref?: string;
}

/**
 * Shared native header for interior pages — Orders list, Orders
 * detail, Account. Fixed at the top, backdrop-blurred bar with a
 * back chevron on the left and the page title centred. Only renders
 * on native; on web the existing `Navbar` already carries home
 * navigation + browser back, so a second chevron would be clutter.
 *
 * Pages pair this with a content `pt-[calc(var(--safe-top)+56px)]`
 * so the header doesn't overlap. Height is intentionally constant
 * (`h-14`, 3.5rem) so the padding formula is predictable.
 */
export function PageHeader({
  title,
  onBack,
  fallbackHref = '/',
}: PageHeaderProps): React.JSX.Element | null {
  const { isNative } = useNativePlatform();
  const navigate = useNavigate();

  if (!isNative) return null;

  const handleBack = (): void => {
    if (onBack !== undefined) {
      onBack();
      return;
    }
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate(fallbackHref);
    }
  };

  return (
    <header
      data-nav="top"
      // Frosted-bar treatment to match the web Navbar so the visual
      // language carries across platforms. Theme-aware bg + border
      // via Tailwind dark: variants.
      className="fixed top-0 left-0 right-0 z-[1100] bg-white/80 dark:bg-gray-950/60 backdrop-blur-md border-b border-black/10 dark:border-white/10"
      style={{ paddingTop: 'var(--safe-top, 0px)' }}
    >
      <div className="relative flex items-center h-14 px-3">
        <button
          type="button"
          onClick={handleBack}
          aria-label="Back"
          className="h-10 w-10 rounded-full flex items-center justify-center text-gray-900 dark:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M15 18 9 12l6-6" />
          </svg>
        </button>
        {/* Absolutely-centred title so it doesn't drift when the
            back button's width flexes (it's a fixed 40px square,
            but defensive against future additions on either side). */}
        <h1 className="absolute left-0 right-0 mx-auto w-fit max-w-[60vw] truncate text-center text-base font-semibold text-gray-900 dark:text-white pointer-events-none">
          {title}
        </h1>
      </div>
    </header>
  );
}
