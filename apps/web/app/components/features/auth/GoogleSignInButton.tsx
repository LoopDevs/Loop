import { useEffect, useId, useRef, useState } from 'react';

/**
 * Google Identity Services button (ADR 014).
 *
 * Loads the `accounts.google.com/gsi/client` script once, initialises
 * with the configured web client id, and renders Google's canonical
 * button into a container ref. The id_token that Google hands us via
 * the callback is posted to the backend via `onCredential`.
 *
 * Designed so the parent handles its own loading / error UI — this
 * component only renders the button container and reports failure
 * via `onError`. Not rendered at all when `clientId` is null (the
 * deployment hasn't configured Google sign-in).
 */
interface GoogleAccountsIdConfig {
  client_id: string;
  callback: (response: { credential: string }) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
}

interface GoogleRenderButtonOptions {
  theme?: string;
  size?: string;
  type?: string;
  shape?: string;
  text?: string;
  width?: number | string;
}

interface GoogleGsi {
  accounts: {
    id: {
      initialize: (config: GoogleAccountsIdConfig) => void;
      renderButton: (el: HTMLElement, options: GoogleRenderButtonOptions) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleGsi;
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiLoadPromise: Promise<void> | null = null;

/**
 * Lazy-loads the GSI script exactly once per page, independent of
 * how many buttons mount. Rejects on script load error so callers
 * can surface a retryable error state.
 */
function loadGsi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR: no window'));
  if (window.google?.accounts?.id !== undefined) return Promise.resolve();
  if (gsiLoadPromise !== null) return gsiLoadPromise;
  gsiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiLoadPromise = null;
      reject(new Error('Google Identity Services failed to load'));
    };
    document.head.appendChild(script);
  });
  return gsiLoadPromise;
}

export interface GoogleSignInButtonProps {
  /** OAuth client id from Google Cloud Console (platform-specific). */
  clientId: string;
  /** Called with the raw id_token string Google hands us via the callback. */
  onCredential: (idToken: string) => void;
  /** Called on script-load failure. Optional — parents can ignore. */
  onError?: (err: Error) => void;
}

export function GoogleSignInButton({
  clientId,
  onCredential,
  onError,
}: GoogleSignInButtonProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  // useId keeps duplicate buttons on the same page rendering into
  // their own container without us having to thread an id prop.
  const id = useId();

  useEffect(() => {
    let cancelled = false;
    loadGsi()
      .then(() => {
        if (cancelled) return;
        const gsi = window.google;
        const container = containerRef.current;
        if (gsi === undefined || container === null) return;
        gsi.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (typeof response.credential === 'string' && response.credential.length > 0) {
              onCredential(response.credential);
            }
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        gsi.accounts.id.renderButton(container, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          width: 280,
        });
        setReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onError?.(err instanceof Error ? err : new Error('Google sign-in unavailable'));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, onCredential, onError]);

  return (
    <div className="flex justify-center">
      <div
        ref={containerRef}
        id={`google-sign-in-${id}`}
        className={ready ? '' : 'opacity-0'}
        aria-label="Sign in with Google"
      />
    </div>
  );
}
