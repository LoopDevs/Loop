import { useCallback, useEffect, useState } from 'react';

/**
 * Sign in with Apple button (ADR 014; CF-27 / audit M-01).
 *
 * Apple App Store Guideline 4.8 requires "Sign in with Apple" be
 * offered wherever a third-party social login (Google here) is. The
 * backend already verifies Apple `id_token`s (`/api/auth/social/apple`)
 * and `signInWithApple` is wired in `use-auth` — this component supplies
 * the missing UI entry point.
 *
 * Unlike Google's GSI button (which Google blocks inside embedded
 * WebViews — `disallowed_useragent`), Apple's own JS SDK runs in the
 * Capacitor WKWebView, so this button is rendered on web AND native.
 *
 * Loads `appleid.auth.js` once, initialises with the configured Apple
 * Service ID, and on tap drives `AppleID.auth.signIn()` (popup mode).
 * The `id_token` Apple returns is handed back via `onCredential`; the
 * parent posts it to the backend social-verify path. Mirrors
 * `GoogleSignInButton`'s structure (parent owns loading/error UI).
 *
 * Not rendered when `serviceId` is null (deployment hasn't configured
 * Apple sign-in) — the parent gates on that.
 */
interface AppleAuthInitConfig {
  clientId: string;
  scope: string;
  redirectURI: string;
  usePopup: boolean;
}

interface AppleAuthorizationResponse {
  authorization: {
    id_token?: string;
    code?: string;
    state?: string;
  };
}

interface AppleIdAuth {
  init: (config: AppleAuthInitConfig) => void;
  signIn: () => Promise<AppleAuthorizationResponse>;
}

interface AppleIdGlobal {
  auth: AppleIdAuth;
}

declare global {
  interface Window {
    AppleID?: AppleIdGlobal;
  }
}

const APPLE_JS_SRC =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
let appleLoadPromise: Promise<void> | null = null;

/**
 * Lazy-loads the Apple JS SDK exactly once per page. Rejects on script
 * load error so callers can surface a retryable error state.
 */
function loadAppleSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR: no window'));
  if (window.AppleID?.auth !== undefined) return Promise.resolve();
  if (appleLoadPromise !== null) return appleLoadPromise;
  appleLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = APPLE_JS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      appleLoadPromise = null;
      reject(new Error('Sign in with Apple failed to load'));
    };
    document.head.appendChild(script);
  });
  return appleLoadPromise;
}

export interface AppleSignInButtonProps {
  /** Apple Service ID (web) / bundle id — the OAuth client id / audience. */
  serviceId: string;
  /** Called with the raw id_token string Apple hands us via the authorization. */
  onCredential: (idToken: string) => void;
  /** Called on script-load / sign-in failure. Optional — parents can ignore. */
  onError?: (err: Error) => void;
}

export function AppleSignInButton({
  serviceId,
  onCredential,
  onError,
}: AppleSignInButtonProps): React.JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAppleSdk()
      .then(() => {
        if (cancelled) return;
        const apple = window.AppleID;
        if (apple === undefined) return;
        apple.auth.init({
          clientId: serviceId,
          scope: 'name email',
          // Popup mode returns the authorization to JS directly (no
          // server redirect handler needed). `redirectURI` is still
          // required by the SDK and must be an allowed return URL in
          // the Apple Service ID config — the current origin works for
          // both web and the Capacitor `capacitor://localhost` shell.
          redirectURI: window.location.origin,
          usePopup: true,
        });
        setReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onError?.(err instanceof Error ? err : new Error('Sign in with Apple unavailable'));
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId, onError]);

  const handleClick = useCallback(() => {
    const apple = window.AppleID;
    if (apple === undefined) {
      onError?.(new Error('Sign in with Apple unavailable'));
      return;
    }
    apple.auth
      .signIn()
      .then((response) => {
        const idToken = response.authorization.id_token;
        if (typeof idToken === 'string' && idToken.length > 0) {
          onCredential(idToken);
        }
      })
      .catch((err: unknown) => {
        // The SDK rejects with `{ error: 'popup_closed_by_user' }` when
        // the user dismisses the popup — that's a cancel, not a failure,
        // so don't surface it as an error.
        const code =
          typeof err === 'object' && err !== null && 'error' in err
            ? (err as { error?: unknown }).error
            : undefined;
        if (code === 'popup_closed_by_user' || code === 'user_cancelled_authorize') return;
        onError?.(err instanceof Error ? err : new Error('Sign in with Apple failed'));
      });
  }, [onCredential, onError]);

  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={!ready}
        aria-label="Sign in with Apple"
        className="flex w-[280px] items-center justify-center gap-2 rounded-full bg-black px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
      >
        {/* Apple logo glyph (currentColor inherits the button text colour). */}
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
        </svg>
        Continue with Apple
      </button>
    </div>
  );
}
