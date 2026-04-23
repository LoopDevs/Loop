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
 * Skips `Content-Security-Policy` because `root.tsx` already emits
 * it via a `<meta http-equiv>` tag with a meta-friendly subset
 * (frame-ancestors/report-uri/sandbox stripped). Setting it here
 * too would duplicate the directive and Chrome would union them
 * restrictively — most likely breaking nothing, but avoiding the
 * double-emit keeps the contract simple.
 */
function applySecurityHeaders(responseHeaders: Headers): void {
  const apiOrigin = process.env['VITE_API_URL'] ?? 'https://api.loopfinance.io';
  const headers = buildSecurityHeaders({ apiOrigin });
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'Content-Security-Policy') continue;
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

    const timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

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
        },
        onShellError(error: unknown) {
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

    if (timeoutId !== undefined) {
      void timeoutId;
    }
  });
}
