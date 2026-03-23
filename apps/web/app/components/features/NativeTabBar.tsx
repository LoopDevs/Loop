import { useLocation } from 'react-router';
import { useNativePlatform } from '~/hooks/use-native-platform';

interface Tab {
  path: string;
  label: string;
  icon: string;
  activeIcon: string;
}

const TABS: Tab[] = [
  { path: '/', label: 'Home', icon: '🏠', activeIcon: '🏠' },
  { path: '/map', label: 'Map', icon: '🗺️', activeIcon: '🗺️' },
  { path: '/orders', label: 'Orders', icon: '📋', activeIcon: '📋' },
  { path: '/auth', label: 'Account', icon: '👤', activeIcon: '👤' },
];

/** Bottom tab bar for native mobile. Hidden on web. */
export function NativeTabBar(): React.JSX.Element | null {
  const { isNative } = useNativePlatform();
  const location = useLocation();

  if (!isNative) return null;

  const activeTab = TABS.find((t) => t.path === location.pathname) ?? TABS[0]!;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-[1100] bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800 native-safe-bottom native-safe-x">
      <div className="flex items-center justify-around h-14">
        {TABS.map((tab) => {
          const isActive = tab.path === activeTab.path;
          return (
            <a
              key={tab.path}
              href={tab.path}
              className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}
            >
              <span className="text-xl leading-none mb-0.5">
                {isActive ? tab.activeIcon : tab.icon}
              </span>
              <span className="text-[10px] font-medium">{tab.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
