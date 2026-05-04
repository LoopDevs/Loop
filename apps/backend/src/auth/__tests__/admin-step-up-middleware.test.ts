import { describe, it, expect, vi } from 'vitest';
import type { Context, Next } from 'hono';

vi.hoisted(() => {
  process.env['LOOP_ADMIN_STEP_UP_SIGNING_KEY'] = 'admin-step-up-test-key-32-chars-min!!';
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

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
      req: { header: (n: string) => headers[n.toLowerCase()] },
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

describe('requireAdminStepUp', () => {
  it('401 STEP_UP_REQUIRED when the X-Admin-Step-Up header is missing', async () => {
    const middleware = requireAdminStepUp();
    const { ctx } = makeCtx({ auth: { kind: 'loop', userId: 'admin-1' } });
    const res = (await middleware(ctx, noopNext)) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_REQUIRED');
  });

  it('401 STEP_UP_INVALID when the token is malformed', async () => {
    const middleware = requireAdminStepUp();
    const { ctx } = makeCtx({
      auth: { kind: 'loop', userId: 'admin-1' },
      headers: { 'X-Admin-Step-Up': 'not.a.valid.token' },
    });
    const res = (await middleware(ctx, noopNext)) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_INVALID');
  });

  it('passes through with a valid step-up token', async () => {
    const { token } = signAdminStepUpToken({ sub: 'admin-1', email: 'admin@example.com' });
    const middleware = requireAdminStepUp();
    const { ctx, store } = makeCtx({
      auth: { kind: 'loop', userId: 'admin-1' },
      headers: { 'X-Admin-Step-Up': token },
    });
    const next = vi.fn(noopNext);
    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
    // Step-up claims stashed for the audit middleware downstream.
    expect(store.get('stepUp')).toMatchObject({ sub: 'admin-1', purpose: 'admin-step-up' });
  });

  it('401 STEP_UP_SUBJECT_MISMATCH when token sub != bearer sub', async () => {
    const { token } = signAdminStepUpToken({ sub: 'admin-A', email: 'a@example.com' });
    const middleware = requireAdminStepUp();
    const { ctx } = makeCtx({
      auth: { kind: 'loop', userId: 'admin-B' },
      headers: { 'X-Admin-Step-Up': token },
    });
    const res = (await middleware(ctx, noopNext)) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('STEP_UP_SUBJECT_MISMATCH');
  });

  it('legacy CTX-proxy admins fall through (ADR-028 exemption)', async () => {
    const middleware = requireAdminStepUp();
    const { ctx } = makeCtx({ auth: { kind: 'ctx' } });
    const next = vi.fn(noopNext);
    await middleware(ctx, next);
    expect(next).toHaveBeenCalled();
  });
});
