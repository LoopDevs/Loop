import { useTranslation } from 'react-i18next';
import { useAppConfig } from '~/hooks/use-app-config';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { getPlatform } from '~/native/platform';
import { CLIENT_VERSION } from '~/services/api-client';
import { isOutdated } from '~/utils/version';
import { LoopLogo } from '~/components/ui/LoopLogo';

/**
 * P2-14 — min-app-version / forced-update gate.
 *
 * A shipped/sideloaded Capacitor bundle can't be OTA-corrected, so a
 * build carrying a since-fixed bug (a money-path regression, a broken
 * auth contract) can't be refused today — the client stamps
 * `X-Client-Version` and the backend only logs it. This gate closes
 * that: `/api/config` carries a server-controlled `minSupportedVersion`
 * per platform, and when the running native build is older than its
 * platform's floor we render a hard, non-dismissible "update required"
 * screen over everything instead of the app.
 *
 * Scope + fail-safety:
 *  - NATIVE ONLY. Web is always served fresh, so it has no version floor
 *    and passes through untouched. `getPlatform()` picks the ios/android
 *    floor.
 *  - FAILS OPEN. `useAppConfig` defaults `minSupportedVersion` to
 *    `{ios:null, android:null}` while loading / on a config error, and
 *    `isOutdated` returns false for a null/blank/malformed floor — so a
 *    config outage can never lock a working build out of the app. The
 *    gate only ever blocks on a definite "current < configured floor".
 *
 * Mounted inside each native branch of `root.tsx` (it needs the
 * QueryClientProvider for `useAppConfig`), wrapping the shell/onboarding
 * so the block supersedes every route including onboarding — a build too
 * old to trust shouldn't run auth either.
 */
export function ForceUpdateGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { isNative } = useNativePlatform();
  // Web is never gated and shouldn't even subscribe to the config query
  // from here — short-circuit before the native-only inner component
  // mounts (which calls `useAppConfig`). Hooks can't be conditional, so
  // the config read lives in a child that only renders on native.
  if (!isNative) return <>{children}</>;
  return <NativeForceUpdateGate>{children}</NativeForceUpdateGate>;
}

function NativeForceUpdateGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { config } = useAppConfig();
  const platform = getPlatform();
  const floor =
    platform === 'ios'
      ? config.minSupportedVersion.ios
      : platform === 'android'
        ? config.minSupportedVersion.android
        : null;

  if (!isOutdated(CLIENT_VERSION, floor)) return <>{children}</>;

  return <ForceUpdateScreen platform={platform} />;
}

/**
 * Best-known store listing per platform. Android is a direct Play Store
 * link keyed on the app id. iOS has no by-bundle-id public URL, so until
 * the numeric App Store ID is assigned (`APP_STORE_APP_ID`, filled at
 * L1-7 App Store Connect setup — see the handoff doc), the button opens
 * the App Store app to a Loop search, which still gets the user to the
 * listing. Replace the placeholder with the direct id URL once known.
 */
const ANDROID_PACKAGE = 'io.loopfinance.app';
const APP_STORE_APP_ID = ''; // TODO(L1-7): fill numeric App Store ID.

function storeUrl(platform: string): string {
  if (platform === 'android') {
    return `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
  }
  if (platform === 'ios') {
    return APP_STORE_APP_ID === ''
      ? 'itms-apps://apps.apple.com/search?term=Loop'
      : `itms-apps://apps.apple.com/app/id${APP_STORE_APP_ID}`;
  }
  return 'https://loopfinance.io';
}

function ForceUpdateScreen({ platform }: { platform: string }): React.JSX.Element {
  const { t } = useTranslation('common');

  const openStore = (): void => {
    // `_system` routes to the OS handler (Play Store / App Store app) in
    // the Capacitor WebView, rather than an in-app browser.
    window.open(storeUrl(platform), '_system');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="force-update-title"
      className="fixed inset-0 z-[99997] flex flex-col items-center justify-center gap-6 px-8 bg-gray-50 dark:bg-gray-950 text-center"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 16px), 28px)' }}
    >
      <LoopLogo className="h-10 w-auto text-gray-950 dark:text-white" />
      <h1
        id="force-update-title"
        className="text-[24px] font-bold leading-[1.15] text-gray-950 dark:text-white max-w-[20rem]"
      >
        {t('forceUpdate.title')}
      </h1>
      <p className="text-[15px] leading-[1.5] text-gray-600 dark:text-gray-300 max-w-[20rem]">
        {t('forceUpdate.body')}
      </p>
      <button
        type="button"
        onClick={openStore}
        className="w-full max-w-[20rem] h-[54px] rounded-2xl border-0 text-[17px] font-semibold cursor-pointer bg-blue-600 text-white hover:bg-blue-700 active:scale-[0.98] transition-[transform,background-color] motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        {t('forceUpdate.cta')}
      </button>
    </div>
  );
}
