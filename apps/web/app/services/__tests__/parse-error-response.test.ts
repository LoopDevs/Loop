import { describe, it, expect } from 'vitest';
import { parseErrorResponse } from '../parse-error-response';

/**
 * A2-1162 pinned this shared helper's behaviour — previously two
 * services carried byte-for-byte copies of the coerce logic, and the
 * only place it had tests was inside each service's own test suite.
 * With the logic extracted, these tests live once and drive both
 * call sites.
 *
 * Every case below maps to something real an upstream/proxy can send:
 * correct shape, missing fields, HTML error page, empty body, non-
 * JSON body, `null` body. The helper must always return a valid
 * `ApiError` so `ApiException.code` is guaranteed a string for any
 * downstream `switch (err.code)` reader.
 */
describe('parseErrorResponse (A2-1162 shared coerce)', () => {
  it('passes through a well-formed { code, message } body', async () => {
    const res = new Response(JSON.stringify({ code: 'VALIDATION_ERROR', message: 'bad input' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    const err = await parseErrorResponse(res);
    expect(err).toEqual({ code: 'VALIDATION_ERROR', message: 'bad input' });
  });

  it('preserves details + requestId when present', async () => {
    const body = {
      code: 'INTERNAL_ERROR',
      message: 'boom',
      details: { field: 'x' },
      requestId: 'req-123',
    };
    const res = new Response(JSON.stringify(body), { status: 500 });
    const err = await parseErrorResponse(res);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.details).toEqual({ field: 'x' });
    expect(err.requestId).toBe('req-123');
  });

  it('falls back to UPSTREAM_ERROR + statusText on a non-string code', async () => {
    const res = new Response(JSON.stringify({ code: 42, message: 'nope' }), {
      status: 503,
      statusText: 'Service Unavailable',
    });
    const err = await parseErrorResponse(res);
    expect(err.code).toBe('UPSTREAM_ERROR');
    // message is valid per the coerce contract — it was a string
    expect(err.message).toBe('nope');
  });

  it('uses statusText when message is missing / non-string', async () => {
    const res = new Response(JSON.stringify({ code: 'X' }), {
      status: 502,
      statusText: 'Bad Gateway',
    });
    const err = await parseErrorResponse(res);
    expect(err).toEqual({ code: 'X', message: 'Bad Gateway' });
  });

  it('drops details when it is present but not an object', async () => {
    const res = new Response(
      JSON.stringify({ code: 'X', message: 'ok', details: 'not-an-object' }),
      { status: 400 },
    );
    const err = await parseErrorResponse(res);
    expect(err).toEqual({ code: 'X', message: 'ok' });
    expect(err.details).toBeUndefined();
  });

  it('coerces an HTML error page to UPSTREAM_ERROR + statusText', async () => {
    const res = new Response('<html><body>500 oops</body></html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'text/html' },
    });
    const err = await parseErrorResponse(res);
    expect(err).toEqual({ code: 'UPSTREAM_ERROR', message: 'Bad Gateway' });
  });

  it('coerces an empty body to UPSTREAM_ERROR + statusText', async () => {
    const res = new Response('', { status: 500, statusText: 'Internal Server Error' });
    const err = await parseErrorResponse(res);
    expect(err).toEqual({ code: 'UPSTREAM_ERROR', message: 'Internal Server Error' });
  });

  it('coerces a JSON `null` body to UPSTREAM_ERROR + statusText', async () => {
    const res = new Response('null', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
    });
    const err = await parseErrorResponse(res);
    expect(err).toEqual({ code: 'UPSTREAM_ERROR', message: 'Bad Gateway' });
  });

  it('drops requestId when it is non-string', async () => {
    const res = new Response(JSON.stringify({ code: 'X', message: 'ok', requestId: 123 }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    const err = await parseErrorResponse(res);
    expect(err.requestId).toBeUndefined();
  });

  // A2-1323: source the backend X-Request-Id from the response header
  // whenever the body doesn't include it. Most handlers don't attach
  // it to the body — only the catch-all 500 does — so the header is
  // the reliable source.
  describe('A2-1323 — reads X-Request-Id from the response header', () => {
    it('uses the header when the body has no requestId field', async () => {
      const res = new Response(JSON.stringify({ code: 'X', message: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'X-Request-Id': 'req-from-header' },
      });
      const err = await parseErrorResponse(res);
      expect(err.requestId).toBe('req-from-header');
    });

    it('body requestId wins over header when both present', async () => {
      const res = new Response(
        JSON.stringify({ code: 'X', message: 'boom', requestId: 'req-from-body' }),
        {
          status: 500,
          headers: { 'content-type': 'application/json', 'X-Request-Id': 'req-from-header' },
        },
      );
      const err = await parseErrorResponse(res);
      expect(err.requestId).toBe('req-from-body');
    });

    it('carries header requestId onto the HTML/empty-body fallback path', async () => {
      const res = new Response('<html>oops</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/html', 'X-Request-Id': 'req-html' },
      });
      const err = await parseErrorResponse(res);
      expect(err).toEqual({
        code: 'UPSTREAM_ERROR',
        message: 'Bad Gateway',
        requestId: 'req-html',
      });
    });

    it('omits requestId when the header is absent and the body lacks it', async () => {
      const res = new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 });
      const err = await parseErrorResponse(res);
      expect(err.requestId).toBeUndefined();
    });
  });
});
