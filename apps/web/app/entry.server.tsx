/**
 * Custom React Router v7 server entry (A2-1604).
 *
 * The default RR entry returns only `Date`, `Connection`, and
 * `Keep-Alive` — no `X-Frame-Options`, `HSTS`, `Referrer-Policy`,
 * `Permissions-Policy`, COOP, CORP. `buildSecurityHeaders` was
 * already defined in utils/ but nothing consumed it at serve time.
 *
 * This entry applies every header from `buildSecurityHeaders` on
 * every SSR response. The `Content-Security-Policy` emitted via
 * `<meta http-equiv>` in root.tsx stays — it carries meta-friendly
 * directives (ADR A-027 / A-032 discussion); this HTTP layer
 * delivers the subset that browsers ignore in meta form
 * (frame-ancestors, X-Frame-Options, HSTS, etc.).
 *
 * Copied from the default node entry in
 * @react-router/dev/dist/config/defaults/entry.server.node.tsx,
 * with header injection added after the headers set is sealed.
 */
import { PassThrough } from 'node:stream';

import type { AppLoadContext, EntryContext } from 'react-router';
import { createReadableStreamFromReadable } from '@react-router/node';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import type { RenderToPipeableStreamOptions } from 'react-dom/server';
import { renderToPipeableStream } from 'react-dom/server';

import { buildSecurityHeaders } from '~/utils/security-headers';

export const streamTimeout = 5_000;

/**
 * Applies `buildSecurityHeaders` to a response headers collection.
 * Overwrites any pre-existing value — the utility is the single source
 * of truth, and the default RR flow never emits these today.
 *
 * A2-1104: emits the full `Content-Security-Policy` HTTP header,
 * including `frame-ancestors 'none'`, which the meta tag in `root.tsx`
 * cannot deliver — the CSP spec requires `frame-ancestors`,
 * `report-uri`, and `sandbox` to come from a header. The meta tag
 * stays for the static-export mobile build (Capacitor webview has no
 * SSR to attach headers to). Browsers enforce both policies as their
 * intersection; since the HTTP CSP is a superset of the meta CSP
 * (only the three header-only directives are added), the effective
 * policy equals the HTTP CSP — no functional regression vs. the
 * previous "skip HTTP CSP" behaviour, but `frame-ancestors` is now
 * actually enforced (defence-in-depth on top of `X-Frame-Options`).
 */
function applySecurityHeaders(responseHeaders: Headers): void {
  const apiOrigin = process.env['VITE_API_URL'] ?? 'https://api.loopfinance.io';
  const headers = buildSecurityHeaders({ apiOrigin });
  for (const [name, value] of Object.entries(headers)) {
    responseHeaders.set(name, value);
  }
}

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
): Promise<Response> | Response {
  applySecurityHeaders(responseHeaders);

  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get('user-agent');

    // Bots and SPA-Mode renders must wait for all content to load
    // before responding so search engines and static generation get
    // complete HTML, not just the shell.
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent !== null && isbot(userAgent)) || routerContext.isSpaMode
        ? 'onAllReady'
        : 'onShellReady';

    // A4-054: clear on every terminal path so the timer never
    // outlives the request. Without this every successful SSR
    // render leaks a pending abort() call that fires later
    // against an already-completed pipe stream — harmless but
    // a fd/timer leak the cleanup contract didn't assert.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearAbortTimer = (): void => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    timeoutId = setTimeout(() => abort(), streamTimeout + 1000);

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set('Content-Type', 'text/html');
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );

          pipe(body);
          clearAbortTimer();
        },
        onShellError(error: unknown) {
          clearAbortTimer();
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) {
            // eslint-disable-next-line no-console
            console.error(error);
          }
        },
      },
    );
  });
}
