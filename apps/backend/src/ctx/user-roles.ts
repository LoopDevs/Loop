// CTX user mirror — ADR 037: Loop admin is CTX's operator-admin role; home currency is CTX's stableCurrency
import { z } from 'zod';
import {
  CASHBACK_DESTINATIONS,
  fiatForHeldStable,
  heldStableForCurrency,
  type CashbackDestination,
  type HomeCurrency,
} from '@loop/shared';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import {
  getUserCtxUserId,
  setUserCountry,
  setUserHomeCurrency,
  setUserIsAdmin,
} from '../db/users.js';
import { ctxFetch } from './api-fetch.js';

const log = logger.child({ area: 'ctx-user-roles' });

export const CTX_OPERATOR_ADMIN_ROLE = 'operator-admin';

const FETCH_TIMEOUT_MS = 5_000;

const CtxUserSchema = z
  .object({
    id: z.string().min(1),
    roles: z.array(z.object({ name: z.string() }).passthrough()).default([]),
    stableCurrency: z.string().optional(),
    cashbackDestination: z.enum(CASHBACK_DESTINATIONS).optional(),
    country: z.string().optional(),
  })
  .passthrough();

export interface CtxUserMirror {
  isAdmin: boolean;
  homeCurrency: HomeCurrency | null;
  cashbackDestination: CashbackDestination;
  country: string | null;
}

export class CtxUserRolesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'CtxUserRolesError';
  }
}

async function parseCtxUser(res: Response, action: string): Promise<CtxUserMirror> {
  if (!res.ok) {
    const body = scrubUpstreamBody(await res.text().catch(() => ''));
    throw new CtxUserRolesError(
      `CTX user ${action} returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }
  const parsed = CtxUserSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new CtxUserRolesError(
      `CTX user response schema drift: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
      null,
    );
  }
  const stable = parsed.data.stableCurrency?.toUpperCase();
  return {
    isAdmin: parsed.data.roles.some((role) => role.name === CTX_OPERATOR_ADMIN_ROLE),
    homeCurrency: stable === undefined ? null : fiatForHeldStable(stable),
    cashbackDestination: parsed.data.cashbackDestination ?? 'account',
    country: parsed.data.country ? parsed.data.country.toUpperCase() : null,
  };
}

export async function fetchCtxUserMirror(ctxUserId: string): Promise<CtxUserMirror> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'lookup');
}

export async function updateCtxStableCurrency(
  ctxUserId: string,
  homeCurrency: HomeCurrency,
): Promise<CtxUserMirror> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stableCurrency: heldStableForCurrency(homeCurrency) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'update');
}

export async function updateCtxCountry(ctxUserId: string, country: string): Promise<CtxUserMirror> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'update');
}

export async function updateCtxCashbackDestination(
  ctxUserId: string,
  destination: CashbackDestination,
): Promise<CtxUserMirror> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashbackDestination: destination }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'update');
}

// Fails soft: the mirror keeps its last values while CTX is unreachable.
export async function syncCtxAdminRole(user: {
  id: string;
  ctxUserId: string | null;
}): Promise<void> {
  if (user.ctxUserId === null) return;
  try {
    const mirror = await fetchCtxUserMirror(user.ctxUserId);
    const changed = await setUserIsAdmin(user.id, mirror.isAdmin);
    if (changed) {
      log.info(
        { userId: user.id, isAdmin: mirror.isAdmin },
        'Loop admin flag updated from the CTX operator-admin role',
      );
    }
    if (mirror.homeCurrency !== null) {
      const currencyChanged = await setUserHomeCurrency(user.id, mirror.homeCurrency);
      if (currencyChanged) {
        log.info(
          { userId: user.id, homeCurrency: mirror.homeCurrency },
          'Loop home currency updated from the CTX stableCurrency',
        );
      }
    }
    if (mirror.country !== null) {
      const countryChanged = await setUserCountry(user.id, mirror.country);
      if (countryChanged) {
        log.info(
          { userId: user.id, country: mirror.country },
          'Loop home country updated from the CTX user country',
        );
      }
    }
  } catch (err) {
    log.warn({ err, userId: user.id }, 'CTX user sync failed — keeping the last mirrored values');
  }
}

export function enqueueCtxAdminRoleSync(userId: string): void {
  void (async () => {
    const ctxUserId = await getUserCtxUserId(userId);
    await syncCtxAdminRole({ id: userId, ctxUserId });
  })().catch((err: unknown) => {
    log.warn({ err, userId }, 'CTX user sync failed — keeping the last mirrored values');
  });
}
