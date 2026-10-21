// CTX user mirror — ADR 037: Loop admin is CTX's operator-admin role; every CTX user response overwrites the local copy
import { z } from 'zod';
import { CASHBACK_DESTINATIONS, type CashbackDestination } from '@loop/shared';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import type { CtxUser } from '../db/users.js';
import { CTX_USER_STATUSES } from '../db/types.js';
import { ctxFetch } from './api-fetch.js';

export const CTX_OPERATOR_ADMIN_ROLE = 'operator-admin';

const FETCH_TIMEOUT_MS = 5_000;

const CtxUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().default(''),
    status: z.enum(CTX_USER_STATUSES),
    roles: z.array(z.object({ name: z.string() }).passthrough()).default([]),
    stableCurrency: z.string().optional(),
    cashbackDestination: z.enum(CASHBACK_DESTINATIONS).optional(),
    country: z.string().optional(),
  })
  .passthrough();

export type { CtxUser };

export class CtxUserRolesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'CtxUserRolesError';
  }
}

async function parseCtxUser(res: Response, action: string): Promise<CtxUser> {
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
  return {
    id: parsed.data.id,
    email: parsed.data.email.toLowerCase(),
    status: parsed.data.status,
    isAdmin: parsed.data.roles.some((role) => role.name === CTX_OPERATOR_ADMIN_ROLE),
    stableCurrency: parsed.data.stableCurrency?.toUpperCase() ?? '',
    cashbackDestination: parsed.data.cashbackDestination ?? 'account',
    country: parsed.data.country ? parsed.data.country.toUpperCase() : null,
  };
}

export async function fetchCtxUser(ctxUserId: string): Promise<CtxUser> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'lookup');
}

export async function enableCtxUser(ctxUserId: string): Promise<CtxUser> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}/status`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'enabled' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'status update');
}

export async function updateCtxStableCurrency(
  ctxUserId: string,
  stableCurrency: string,
): Promise<CtxUser> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stableCurrency }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'update');
}

export async function updateCtxCountry(ctxUserId: string, country: string): Promise<CtxUser> {
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
): Promise<CtxUser> {
  const res = await ctxFetch(upstreamUrl(`/users/${encodeURIComponent(ctxUserId)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashbackDestination: destination }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseCtxUser(res, 'update');
}
