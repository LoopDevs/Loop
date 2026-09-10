// Async CTX customer provisioning — ADR 013, ADR 030, ADR 051
import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { setUserCtxUserId } from '../db/users.js';
import { ctxFetch } from './api-fetch.js';

const log = logger.child({ area: 'ctx-user-provisioning' });

export interface ProvisionableUser {
  id: string;
  email: string;
  ctxUserId: string | null;
}

const CtxCreateUserResponse = z.object({ id: z.string().min(1) });

const CtxValidationBody = z.object({
  fields: z.record(z.string(), z.array(z.string())),
});

const CtxUserSummary = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  type: z.string().optional(),
  operatorUserId: z.string().optional(),
});

const CtxUserListResponse = z.object({ result: z.array(CtxUserSummary) });

function isEmailExistsRejection(rawBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const validation = CtxValidationBody.safeParse(parsed);
  if (!validation.success) return false;
  return (validation.data.fields['email'] ?? []).includes('already exists');
}

// CTX list filters are unanchored case-insensitive Mongo $regex; escaping makes the query literal,
// but callers must still exact-match results because unanchored regexes over-match substrings.
function escapeCtxRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function provisioningConfigured(): boolean {
  return config.ctx.userProvisioning.enabled;
}

const inFlight = new Set<string>();

export function enqueueCtxUserProvisioning(user: ProvisionableUser): void {
  if (!provisioningConfigured()) return;
  if (user.ctxUserId !== null) return;
  if (inFlight.has(user.id)) return;
  inFlight.add(user.id);
  void provisionCtxUser(user)
    .catch((err: unknown) => {
      log.warn({ err, userId: user.id }, 'CTX user provisioning failed');
    })
    .finally(() => {
      inFlight.delete(user.id);
    });
}

export async function provisionCtxUser(user: ProvisionableUser): Promise<void> {
  const res = await fetch(upstreamUrl('/users'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.ctx.credentials.key,
      'X-Api-Secret': config.ctx.credentials.secret,
    },
    body: JSON.stringify({
      email: user.email,
      type: 'customer',
      operatorUserId: user.id,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    if (res.status === 400 && isEmailExistsRejection(rawBody)) {
      log.info(
        { userId: user.id },
        'CTX email already exists under the company — attempting adoption',
      );
      await adoptExistingCtxUser(user);
      return;
    }
    log.warn(
      { userId: user.id, status: res.status, body: scrubUpstreamBody(rawBody).slice(0, 300) },
      'CTX user provisioning returned non-ok',
    );
    return;
  }

  const parsed = CtxCreateUserResponse.safeParse(await res.json());
  if (!parsed.success) {
    log.error(
      { userId: user.id, issues: parsed.error.issues },
      'CTX create-user response schema drift',
    );
    return;
  }

  const stored = await setUserCtxUserId(user.id, parsed.data.id);
  if (!stored) {
    log.info(
      { userId: user.id, ctxUserId: parsed.data.id },
      'CTX user already mapped; provisioned id discarded',
    );
    return;
  }
  log.info({ userId: user.id, ctxUserId: parsed.data.id }, 'CTX user provisioned');
}

export async function adoptExistingCtxUser(user: ProvisionableUser): Promise<void> {
  const email = user.email.trim().toLowerCase();
  const listRes = await ctxFetch(
    upstreamUrl(`/users?type=customer&email=${encodeURIComponent(escapeCtxRegex(email))}`),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!listRes.ok) {
    const body = scrubUpstreamBody(await listRes.text().catch(() => ''));
    log.warn(
      { userId: user.id, status: listRes.status, body: body.slice(0, 300) },
      'CTX user lookup for adoption returned non-ok',
    );
    return;
  }
  const parsed = CtxUserListResponse.safeParse(await listRes.json());
  if (!parsed.success) {
    log.error(
      { userId: user.id, issues: parsed.error.issues },
      'CTX list-users response schema drift',
    );
    return;
  }

  const matches = parsed.data.result.filter(
    (candidate) => candidate.email?.toLowerCase() === email && candidate.type === 'customer',
  );
  const [ctxUser] = matches;
  if (ctxUser === undefined || matches.length > 1) {
    log.warn(
      { userId: user.id, matchCount: matches.length },
      'CTX adoption found no unambiguous customer for the email',
    );
    return;
  }

  if (ctxUser.operatorUserId !== undefined && ctxUser.operatorUserId !== user.id) {
    log.error(
      { userId: user.id, ctxUserId: ctxUser.id },
      'CTX customer with this email is mapped to a different Loop user — not adopting',
    );
    return;
  }

  if (ctxUser.operatorUserId !== user.id) {
    const updateRes = await ctxFetch(upstreamUrl(`/users/${ctxUser.id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operatorUserId: user.id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!updateRes.ok) {
      const body = scrubUpstreamBody(await updateRes.text().catch(() => ''));
      log.warn(
        {
          userId: user.id,
          ctxUserId: ctxUser.id,
          status: updateRes.status,
          body: body.slice(0, 300),
        },
        'CTX operatorUserId claim returned non-ok',
      );
      return;
    }
  }

  const stored = await setUserCtxUserId(user.id, ctxUser.id);
  if (!stored) {
    log.info(
      { userId: user.id, ctxUserId: ctxUser.id },
      'CTX user already mapped; adopted id discarded',
    );
    return;
  }
  log.info({ userId: user.id, ctxUserId: ctxUser.id }, 'CTX user adopted');
}

// Returns null when mapping is absent; callers must not reach CTX for user-scoped reads without X-User-Id.
export function ctxActAsHeaders(
  ctxUserId: string | null,
  clientId?: string,
): Record<string, string> | null {
  if (ctxUserId === null) return null;
  return {
    'X-Api-Key': config.ctx.credentials.key,
    'X-Api-Secret': config.ctx.credentials.secret,
    'X-User-Id': ctxUserId,
    'X-Client-Id': clientId ?? config.ctx.clientIds.web,
  };
}
