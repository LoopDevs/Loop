import { describe, it, expect } from 'vitest';
import { buildPlan } from '../scaffold-endpoint.mjs';

describe('scaffold-endpoint buildPlan', () => {
  it('rejects a non-/api path and a bad method', () => {
    expect(
      buildPlan({ method: 'FOO', path: '/nope', name: 'x', tier: 'authed', domain: 'd' }).errors,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('--method'),
        expect.stringContaining('--path'),
      ]),
    );
  });

  it('rejects a non-camelCase name', () => {
    const p = buildPlan({
      method: 'GET',
      path: '/api/x',
      name: 'Get-Example',
      tier: 'authed',
      domain: 'd',
    });
    expect(p.errors).toEqual(expect.arrayContaining([expect.stringContaining('--name')]));
  });

  it('admin tier declares 404 (not 403) and no 400 for GET', () => {
    const p = buildPlan({
      method: 'GET',
      path: '/api/admin/x/:id',
      name: 'getX',
      tier: 'admin',
      domain: 'admin-x',
      rate: '60',
    });
    expect(p.errors).toHaveLength(0);
    expect(p.statuses).toContain('404');
    expect(p.statuses).not.toContain('403');
    expect(p.statuses).not.toContain('400'); // GET has no body-validation 400
    expect(p.statuses).toContain('429'); // rate-limited
    expect(p.tierMiddleware).toBe("requireStaff('admin')");
  });

  it('POST authed declares 400 + 401 but not 404', () => {
    const p = buildPlan({
      method: 'POST',
      path: '/api/thing',
      name: 'makeThing',
      tier: 'authed',
      domain: 'thing',
    });
    expect(p.statuses).toEqual(expect.arrayContaining(['200', '400', '401', '500']));
    expect(p.statuses).not.toContain('404');
    expect(p.statuses).not.toContain('429'); // no --rate
    expect(p.tierMiddleware).toBe('requireAuth');
  });

  it('public tier has no auth middleware and no 401', () => {
    const p = buildPlan({
      method: 'GET',
      path: '/api/public/thing',
      name: 'getThing',
      tier: 'public',
      domain: 'public-thing',
    });
    expect(p.tierMiddleware).toBeNull();
    expect(p.statuses).not.toContain('401');
  });

  it('derives kebab file paths + a "METHOD /path" rate-limit id', () => {
    const p = buildPlan({
      method: 'DELETE',
      path: '/api/auth/session/all',
      name: 'revokeAllSessions',
      tier: 'authed',
      domain: 'auth',
      rate: '10',
    });
    expect(p.handlerFile).toBe('apps/backend/src/auth/revoke-all-sessions-handler.ts');
    expect(p.testFile).toBe('apps/backend/src/auth/__tests__/revoke-all-sessions-handler.test.ts');
    expect(p.rateLimitId).toBe('DELETE /api/auth/session/all');
    expect(p.honoMethod).toBe('delete');
  });
});
