import type { Context, MiddlewareHandler } from 'hono';
import type { StaffRole } from '@loop/shared';
import type { LoopAuthContext } from './handler.js';
import { getUserById, type User } from '../db/users.js';
import { getStaffRole } from '../db/staff-roles.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'requireStaff' });

// Staff middleware factory (ADR 037).
export function requireStaff(minimum: StaffRole): MiddlewareHandler {
  const mw = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const auth = c.get('auth') as LoopAuthContext | undefined;
    if (auth === undefined) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }
    if (auth.kind !== 'loop') {
      return c.json(
        { code: 'UNAUTHORIZED', message: 'Loop-authenticated admin session required' },
        401,
      );
    }

    let role = c.get('staffRole') as StaffRole | undefined;
    const cachedUser = c.get('user') as User | undefined;
    if (role === undefined || cachedUser === undefined) {
      let user: User;
      try {
        const resolved = await getUserById(auth.userId);
        if (resolved === null) {
          return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
        }
        user = resolved;
      } catch (err) {
        log.error({ err, userId: auth.userId }, 'Failed to resolve staff user');
        return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
      }

      let staffRow: { role: StaffRole } | null = null;
      let lookupFailed = false;
      try {
        staffRow = await getStaffRole(user.id);
      } catch (err) {
        lookupFailed = true;
        log.warn(
          { err, userId: user.id },
          'staff_roles lookup failed — falling back to the users.isAdmin allowlist shim',
        );
      }
      const resolvedRole: StaffRole | null = staffRow?.role ?? (user.isAdmin ? 'admin' : null);
      if (resolvedRole === null) {
        return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
      }
      if (lookupFailed && resolvedRole === 'admin') {
        log.warn(
          { userId: user.id },
          'Admin access granted via the allowlist shim during a staff_roles outage',
        );
      }
      role = resolvedRole;
      c.set('user', user);
      c.set('staffRole', role);
    }

    if (minimum === 'admin' && role !== 'admin') {
      return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    }

    await next();
  };
  Object.defineProperty(mw, 'name', { value: `requireStaff(${minimum})` });
  return mw;
}
