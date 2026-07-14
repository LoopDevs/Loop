import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, Next } from 'hono';
import type * as AdminStepUpModule from '../admin-step-up.js';

vi.hoisted(() => {
  process.env['LOOP_ADMIN_STEP_UP_SIGNING_KEY'] = 'admin-step-up-test-key-32-chars-min!!';
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// SEC-02-stepup: the gate now CONSUMES the token (DB-backed single-use)
// rather than merely verifying it. This is a unit test with no DB, so we
// mock `consumeAdminStepUpToken` and assert the middleware's mapping of
// its result → HTTP code. The real consume behaviour (class binding +
// single-use against real postgres) is proven in
// `__tests__/integration/admin-step-up-consume.test.ts` and end-to-end in
// `admin-writes.test.ts`. `verifyAdminStepUpToken` + `signAdminStepUpToken`
// stay REAL — the stateless subject-pinning path runs before consume, so
// the missing/malformed/subject cases need no mock.
const { consumeMock } = vi.hoisted(() => ({ consumeMock: vi.fn() }));
vi.mock('../admin-step-up.js', async (importActual) => {
  const actual = await importActual<typeof AdminStepUpModule>();
  return { ...actual, consumeAdminStepUpToken: consumeMock };
});

import { requireAdminStepUp } from '../admin-step-up-middleware.js';
import { signAdminStepUpToken } from '../admin-step-up.js';

interface FakeCtx {
  store: Map<string, unknown>;
  ctx: Context;
}

function makeCtx(opts: {
  auth?: { kind: 'loop' | 'ctx'; userId?: string };
  headers?: Record<string, string>;
}): FakeCtx {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  const headers: Record<string, string> = {};
  if (opts.headers !== undefined) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return {
    store,
    ctx: {
      req: { header: (n: string) => headers[n.toLowerCase()], path: '/api/admin/x' },
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

const noopNext: Next = async () => {};

beforeEach(() => {
  consumeMock.mockReset();
});

describe('requireAdminStepUp', () => {
  it('401 STEP_UP_REQUIRED when the X-Admin-Step-Up header is missing', async () => {
    const middleware = requireAdminStepUp('refund');
    const { ctx } = makeCtx({ auth: { kind: 'loop', userId: 'admin-1' } });
    const res = (await middleware(ctx, noopNext)) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_REQUIRED');
    // Nothing to consume — the missing-token path never burns.
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('401 STEP_UP_INVALID when the token is malformed (rejected at stateless verify, not consumed)', async () => {
    const middleware = requireAdminStepUp('refund');
    const { ctx } = makeCtx({
      auth: { kind: 'loop', userId: 'admin-1' },
      headers: { 'X-Admin-Step-Up': 'not.a.valid.token' },
    });
    const res = (await middleware(ctx, noopNext)) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_INVALID');
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('passes through with a valid step-up token and consumes it against the gate action', async () => {
    const { token } = signAdminStepUpToken({
      sub: 'admin-1',
      email: 'admin@example.com',
      scope: 'refund',
    });
    consumeMock.mockResolvedValue({
      ok: true,
      claims: { sub: 'admin-1', purpose: 'admin-step-up', scope: 'refund' },
    });
    const middleware = requireAdminStepUp('refund');
    const { ctx, store } = makeCtx({
      auth: { kind: 'loop', userId: 'admin-1' },
      headers: { 'X-Admin-Step-Up': token },
    });
    const next = vi.fn(noopNext);
    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
    // Consumed single-use against exactly this gate's action.
    expect(consumeMock).toHaveBeenCalledWith({ token, action: 'refund' });
    // The CONSUMED claims are stashed for the audit middleware downstream.
    expect(store.get('stepUp')).toMatchObject({ sub: 'admin-1', purpose: 'admin-step-up' });
  });

  it('401 STEP_UP_SUBJECT_MISMATCH when token sub != bearer sub — and does NOT consume (no burn)', async () => {
    const { token } = signAdminStepUpToken({
      sub: 'admin-A',
      email: 'a@example.com',
      scope: 'refund',
    });
    const middleware = requireAdminStepUp('refund');
    const { ctx } = makeCtx({
      auth: { kind: 'loop', userId: 'admin-B' },
      headers: { 'X-Admin-Step-Up': token },
    });
    const res = (await middleware(ctx, noopNext)) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_SUBJECT_MISMATCH');
    // Subject pinning runs on the stateless verify BEFORE consume, so a
    // wrong-session replay burns nothing.
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('legacy CTX-proxy auth fails closed because there is no Loop subject to pin', async () => {
    const middleware = requireAdminStepUp('refund');
    const { ctx } = makeCtx({ auth: { kind: 'ctx' } });
    const next = vi.fn(noopNext);
    const res = (await middleware(ctx, next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_INVALID');
    expect(consumeMock).not.toHaveBeenCalled();
  });

  describe('hardening B2 — fail-closed subject pinning', () => {
    it('401 when the gate is reached with NO auth context (mount-order bug)', async () => {
      const { token } = signAdminStepUpToken({
        sub: 'admin-1',
        email: 'admin@example.com',
        scope: 'refund',
      });
      const middleware = requireAdminStepUp('refund');
      const { ctx } = makeCtx({ headers: { 'X-Admin-Step-Up': token } });
      const next = vi.fn(noopNext);
      const res = (await middleware(ctx, next)) as Response;
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('STEP_UP_INVALID');
      expect(consumeMock).not.toHaveBeenCalled();
    });

    it('401 when the loop auth context carries no userId', async () => {
      const { token } = signAdminStepUpToken({
        sub: 'admin-1',
        email: 'admin@example.com',
        scope: 'refund',
      });
      const middleware = requireAdminStepUp('refund');
      const { ctx } = makeCtx({
        auth: { kind: 'loop' },
        headers: { 'X-Admin-Step-Up': token },
      });
      const next = vi.fn(noopNext);
      const res = (await middleware(ctx, next)) as Response;
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
    });
  });

  it('is named for the route-inventory walk (hardening B1)', () => {
    // staff-route-gating.test.ts statically asserts every destructive
    // admin mount carries its scoped step-up gate — that only works
    // while the middleware's function name encodes the scope.
    expect(requireAdminStepUp('refund').name).toBe('requireAdminStepUp(refund)');
    expect(requireAdminStepUp('emission').name).toBe('requireAdminStepUp(emission)');
  });

  describe('SEC-02-stepup consume-result mapping', () => {
    function ctxWithToken(): FakeCtx {
      const { token } = signAdminStepUpToken({
        sub: 'admin-1',
        email: 'a@example.com',
        scope: 'refund',
      });
      return makeCtx({
        auth: { kind: 'loop', userId: 'admin-1' },
        headers: { 'X-Admin-Step-Up': token },
      });
    }

    it('401 STEP_UP_PURPOSE_MISMATCH when the token is minted for a DIFFERENT action (scope_mismatch)', async () => {
      // The core SEC-02 protection: a step-up confirmed for one class
      // must NOT be reusable for another — no wildcard bypass.
      consumeMock.mockResolvedValue({ ok: false, reason: 'scope_mismatch' });
      const middleware = requireAdminStepUp('withdrawal');
      const { ctx } = ctxWithToken();
      const res = (await middleware(ctx, noopNext)) as Response;
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('STEP_UP_PURPOSE_MISMATCH');
    });

    it('401 STEP_UP_ALREADY_USED when the token was already consumed (single-use)', async () => {
      consumeMock.mockResolvedValue({ ok: false, reason: 'already_consumed' });
      const middleware = requireAdminStepUp('refund');
      const { ctx } = ctxWithToken();
      const res = (await middleware(ctx, noopNext)) as Response;
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('STEP_UP_ALREADY_USED');
    });

    it('401 STEP_UP_INVALID for a legacy jti-less token (not_consumable → fail closed)', async () => {
      consumeMock.mockResolvedValue({ ok: false, reason: 'not_consumable' });
      const middleware = requireAdminStepUp('refund');
      const { ctx } = ctxWithToken();
      const res = (await middleware(ctx, noopNext)) as Response;
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('STEP_UP_INVALID');
    });
  });
});
