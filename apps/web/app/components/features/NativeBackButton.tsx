import { useLocation, useNavigate } from 'react-router';
import { useNativePlatform } from '~/hooks/use-native-platform';

const ROOT_PATHS = new Set(['/', '/map', '/orders', '/auth']);

/** Shows a back button in the top-left on native for non-root routes. */
export function NativeBackButton(): React.JSX.Element | null {
  const { isNative } = useNativePlatform();
  const location = useLocation();
  const navigate = useNavigate();

  if (!isNative || ROOT_PATHS.has(location.pathname)) return null;

  return (
    <button
      type="button"
      onClick={() => void navigate(-1)}
      className="fixed top-0 left-0 z-[1200] flex items-center gap-1 px-4 text-blue-600 dark:text-blue-400 font-medium text-sm native-safe-top"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
      aria-label="Go back"
    >
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Back
    </button>
  );
}
