import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { ctxFetch } from './api-fetch.js';
import { startCtxWs, stopCtxWs } from './ws-events.js';

const log = logger.child({ area: 'ctx-startup' });

const STARTUP_TIMEOUT_MS = 10_000;

const CtxCompanySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    type: z.string().optional(),
    disableUserEmails: z.boolean(),
  })
  .passthrough();

const LoopContextSchema = z
  .object({
    company: CtxCompanySchema,
  })
  .passthrough();

export type LoopContext = z.infer<typeof LoopContextSchema>;

let loopContext: LoopContext | null = null;

export function getLoopContext(): LoopContext {
  if (loopContext === null) {
    throw new Error('CTX loop context unavailable — startCtx() has not completed');
  }
  return loopContext;
}

export async function startCtx(): Promise<void> {
  const { key, secret } = config.ctx.credentials;
  if (key.trim().length === 0 || secret.trim().length === 0) {
    throw new Error('CTX startup failed: ctx.credentials.key / ctx.credentials.secret are not set');
  }

  const context = await fetchLoopContext();
  loopContext = await ensureUserEmailsDisabled(context);

  log.info(
    {
      companyId: loopContext.company.id,
      companyName: loopContext.company.name,
      companyType: loopContext.company.type,
    },
    'CTX loop context established',
  );

  startCtxWs();
}

export function stopCtx(): void {
  stopCtxWs();
}

async function fetchLoopContext(): Promise<LoopContext> {
  let res: Response;
  try {
    res = await ctxFetch(upstreamUrl('/me'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error('CTX startup failed: GET /me failed', { cause: err });
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw new Error(`CTX startup failed: GET /me returned ${res.status}`);
  }
  const parsed = LoopContextSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`CTX startup failed: GET /me response shape invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function ensureUserEmailsDisabled(context: LoopContext): Promise<LoopContext> {
  if (context.company.disableUserEmails) return context;

  log.warn({ companyId: context.company.id }, 'CTX company has disableUserEmails=false — updating');

  let res: Response;
  try {
    res = await ctxFetch(upstreamUrl(`/companies/${encodeURIComponent(context.company.id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ disableUserEmails: true }),
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error('CTX startup failed: company disableUserEmails update failed', {
      cause: err,
    });
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw new Error(
      `CTX startup failed: PUT /companies/${context.company.id} returned ${res.status}`,
    );
  }
  const updated = CtxCompanySchema.safeParse(await res.json());
  if (!updated.success) {
    throw new Error(
      `CTX startup failed: company update response shape invalid: ${updated.error.message}`,
    );
  }
  if (!updated.data.disableUserEmails) {
    throw new Error('CTX startup failed: company disableUserEmails is still false after update');
  }
  return { ...context, company: updated.data };
}

export function __resetCtxStartupForTests(): void {
  loopContext = null;
}
