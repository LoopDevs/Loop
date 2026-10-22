// CTX customer provisioning — ADR 013, ADR 030, ADR 051
import { z } from 'zod';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import type { CtxUser } from '../db/users.js';
import { ctxFetch } from './api-fetch.js';
import { CtxUserRolesError, fetchCtxUser } from './user-roles.js';

const FETCH_TIMEOUT_MS = 10_000;

const CTX_USER_CREATION_DISABLED = 'user creation is disabled for this company';

export class CtxUserCreationDisabledError extends Error {
  constructor() {
    super('CTX refused to create the customer: user creation is disabled for the operator company');
    this.name = 'CtxUserCreationDisabledError';
  }
}

const CtxCreateUserResponse = z.object({ id: z.string().min(1) });

const CtxErrorBody = z.object({ error: z.string() });

const CtxValidationBody = z.object({
  fields: z.record(z.string(), z.array(z.string())),
});

const CtxUserSummary = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  type: z.string().optional(),
});

const CtxUserListResponse = z.object({ result: z.array(CtxUserSummary) });

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function isEmailExistsRejection(rawBody: string): boolean {
  const validation = CtxValidationBody.safeParse(parseJson(rawBody));
  if (!validation.success) return false;
  return (validation.data.fields['email'] ?? []).includes('already exists');
}

function isUserCreationDisabled(rawBody: string): boolean {
  const parsed = CtxErrorBody.safeParse(parseJson(rawBody));
  return parsed.success && parsed.data.error === CTX_USER_CREATION_DISABLED;
}

// CTX list filters are unanchored case-insensitive Mongo $regex; escaping makes the query literal,
// but callers must still exact-match results because unanchored regexes over-match substrings.
function escapeCtxRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findCtxCustomerIdByEmail(email: string): Promise<string | null> {
  const res = await ctxFetch(
    upstreamUrl(`/users?type=customer&email=${encodeURIComponent(escapeCtxRegex(email))}`),
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    const body = scrubUpstreamBody(await res.text().catch(() => ''));
    throw new CtxUserRolesError(
      `CTX user lookup by email returned ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  }
  const parsed = CtxUserListResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new CtxUserRolesError(
      `CTX list-users response schema drift: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
      null,
    );
  }
  const matches = parsed.data.result.filter(
    (candidate) => candidate.email?.toLowerCase() === email && candidate.type === 'customer',
  );
  if (matches.length > 1) {
    throw new CtxUserRolesError(`CTX has ${matches.length} customers for one email`, null);
  }
  return matches[0]?.id ?? null;
}

export interface CtxCustomerOptions {
  country?: string | undefined;
  emailVerified?: boolean;
}

async function createCtxCustomer(
  email: string,
  options: CtxCustomerOptions,
): Promise<string | null> {
  const body = JSON.stringify({
    email,
    type: 'customer',
    ...(options.country !== undefined ? { country: options.country.toUpperCase() } : {}),
    ...(options.emailVerified === true ? { status: 'enabled' } : {}),
  });
  const res = await ctxFetch(upstreamUrl('/users'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    if (res.status === 400 && isEmailExistsRejection(rawBody)) return null;
    if (res.status === 403 && isUserCreationDisabled(rawBody)) {
      throw new CtxUserCreationDisabledError();
    }
    throw new CtxUserRolesError(
      `CTX user create returned ${res.status}: ${scrubUpstreamBody(rawBody).slice(0, 300)}`,
      res.status,
    );
  }
  const parsed = CtxCreateUserResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new CtxUserRolesError(
      `CTX create-user response schema drift: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
      null,
    );
  }
  return parsed.data.id;
}

export async function loadOrCreateCtxCustomer(
  email: string,
  options: CtxCustomerOptions = {},
): Promise<CtxUser> {
  const id =
    (await findCtxCustomerIdByEmail(email)) ??
    (await createCtxCustomer(email, options)) ??
    (await findCtxCustomerIdByEmail(email));
  if (id === null) {
    throw new CtxUserRolesError(
      'CTX reported the email as taken but lists no customer for it',
      null,
    );
  }
  return fetchCtxUser(id);
}
