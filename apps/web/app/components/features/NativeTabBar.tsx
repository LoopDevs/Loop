import { Link, useLocation } from 'react-router';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAuthStore } from '~/stores/auth.store';
import { triggerHaptic } from '~/native/haptics';

interface Tab {
  path: string;
  label: string;
  Icon: (props: { active: boolean }) => React.JSX.Element;
}

// Inline SVG icons (Heroicons-style) so they render crisply at any DPI
// and pick up the parent's text colour via `currentColor`. Each tab has
// an outline (inactive) and solid (active) variant — the selected tab
// reads clearly at a glance without relying only on colour.

const outlineProps = {
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const solidProps = { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'currentColor' };

function HomeIcon({ active }: { active: boolean }): React.JSX.Element {
  return active ? (
    <svg {...solidProps}>
      <path d="M11.47 3.84a.75.75 0 011.06 0l8.69 8.69a.75.75 0 11-1.06 1.06l-.47-.47V19.5a2.25 2.25 0 01-2.25 2.25h-3a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-1.5a.75.75 0 00-.75.75v4.5a.75.75 0 01-.75.75h-3a2.25 2.25 0 01-2.25-2.25v-6.38l-.47.47a.75.75 0 01-1.06-1.06l8.69-8.69z" />
    </svg>
  ) : (
    <svg {...outlineProps}>
      <path d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10" />
    </svg>
  );
}

function MapIcon({ active }: { active: boolean }): React.JSX.Element {
  return active ? (
    <svg {...solidProps}>
      <path d="M12 2a7 7 0 017 7c0 5.25-7 13-7 13S5 14.25 5 9a7 7 0 017-7zm0 9.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
    </svg>
  ) : (
    <svg {...outlineProps}>
      <path d="M12 22s7-7.75 7-13a7 7 0 10-14 0c0 5.25 7 13 7 13z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}

function OrdersIcon({ active }: { active: boolean }): React.JSX.Element {
  return active ? (
    <svg {...solidProps}>
      <path d="M9 2a2 2 0 00-2 2H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1a2 2 0 00-2-2H9zm0 2h6v2H9V4zm-1 8h8v1.5H8V12zm0 3.5h6V17H8v-1.5z" />
    </svg>
  ) : (
    <svg {...outlineProps}>
      <path d="M9 4h6a1 1 0 011 1v1h2a1 1 0 011 1v13a1 1 0 01-1 1H6a1 1 0 01-1-1V7a1 1 0 011-1h2V5a1 1 0 011-1z" />
      <path d="M9 4v2h6V4M8 12h8M8 16h5" />
    </svg>
  );
}

function AccountIcon({ active }: { active: boolean }): React.JSX.Element {
  return active ? (
    <svg {...solidProps}>
      <path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-8 8.5a8 8 0 0116 0 .5.5 0 01-.5.5h-15a.5.5 0 01-.5-.5z" />
    </svg>
  ) : (
    <svg {...outlineProps}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0116 0" />
    </svg>
  );
}

const TABS: Tab[] = [
  { path: '/', label: 'Home', Icon: HomeIcon },
  { path: '/map', label: 'Map', Icon: MapIcon },
  { path: '/orders', label: 'Orders', Icon: OrdersIcon },
  { path: '/auth', label: 'Account', Icon: AccountIcon },
];

// Match by prefix — gift-card detail pages highlight Home, etc.
function getActiveTabPath(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/gift-card')) return '/';
  for (const tab of TABS) {
    if (tab.path !== '/' && pathname.startsWith(tab.path)) return tab.path;
  }
  return '/';
}

/** Bottom tab bar for native mobile. Hidden on web. */
export function NativeTabBar(): React.JSX.Element | null {
  const { isNative } = useNativePlatform();
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);

  if (!isNative || !isAuthenticated) return null;

  const activeTabPath = getActiveTabPath(location.pathname);

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-[1100] bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800 native-safe-bottom native-safe-x">
      <div className="flex items-center justify-around h-14">
        {TABS.map((tab) => {
          const isActive = tab.path === activeTabPath;
          return (
            <Link
              key={tab.path}
              to={tab.path}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
              onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
                void triggerHaptic();
                if (tab.path === activeTabPath) {
                  e.preventDefault();
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }}
              className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}
            >
              <span className="mb-0.5" aria-hidden="true">
                <tab.Icon active={isActive} />
              </span>
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
