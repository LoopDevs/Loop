import { z } from 'zod';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { ctxFetch } from './api-fetch.js';
import {
  isCtxCryptoCurrency,
  isCtxFiatCurrency,
  loadCtxCurrencies,
  refreshCtxCurrencies,
} from './currencies.js';
import { registerCtxWsTopic, startCtxWs, stopCtxWs } from './ws-events.js';

const log = logger.child({ area: 'ctx-startup' });

const STARTUP_TIMEOUT_MS = 10_000;

export const LOOP_CONTEXT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const COMPANY_EVENTS = new Set(['system.company.updated', 'system.company.status_changed']);

const CurrencyListSchema = z.array(z.string().min(1)).default([]);

const CtxCompanySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    disableUserEmails: z.boolean(),
    profitShareBasisPoints: z.number().optional(),
    countries: z.array(z.string().length(2)).default([]),
    paymentCurrencies: CurrencyListSchema,
    stableCurrencies: CurrencyListSchema,
  })
  .passthrough();

export type CtxCompany = z.infer<typeof CtxCompanySchema>;

const LoopContextSchema = z
  .object({
    company: CtxCompanySchema,
  })
  .passthrough();

export type LoopContext = z.infer<typeof LoopContextSchema>;

let loopContext: LoopContext | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let companyTopicRegistered = false;

export function getLoopContext(): LoopContext {
  if (loopContext === null) {
    throw new Error('CTX loop context unavailable — startCtx() has not completed');
  }
  return loopContext;
}

export function getLoopCompany(): CtxCompany {
  return getLoopContext().company;
}

export function peekLoopCompany(): CtxCompany | null {
  return loopContext?.company ?? null;
}

export function loopCountries(): string[] {
  return getLoopCompany().countries.map((country) => country.toUpperCase());
}

export function loopPaymentCurrencies(): string[] {
  return getLoopCompany().paymentCurrencies.map((currency) => currency.trim().toUpperCase());
}

export function loopFiatPaymentCurrencies(): string[] {
  return loopPaymentCurrencies().filter(isCtxFiatCurrency);
}

export function loopCryptoPaymentCurrencies(): string[] {
  return loopPaymentCurrencies().filter(isCtxCryptoCurrency);
}

export function loopStableCurrencies(): string[] {
  return getLoopCompany().stableCurrencies.map((currency) => currency.trim().toUpperCase());
}

export async function startCtx(): Promise<void> {
  const { key, secret, privateKey } = config.ctx.credentials;
  const hasProof = (secret ?? '').trim().length > 0 || (privateKey ?? '').trim().length > 0;
  if (key.trim().length === 0 || !hasProof) {
    throw new Error(
      'CTX startup failed: ctx.credentials.key plus a privateKey or secret are not set',
    );
  }

  await loadCtxCurrencies();
  const context = await fetchLoopContext();
  loopContext = await ensureUserEmailsDisabled(context);

  log.info(
    {
      companyId: loopContext.company.id,
      companyName: loopContext.company.name,
      companyType: loopContext.company.type,
      countries: loopContext.company.countries,
      fiatPaymentCurrencies: loopFiatPaymentCurrencies(),
      cryptoPaymentCurrencies: loopCryptoPaymentCurrencies(),
      stableCurrencies: loopContext.company.stableCurrencies,
    },
    'CTX loop context established',
  );

  registerCompanyWsEvents();
  startCtxWs();
  refreshInterval = setInterval(() => {
    void refreshCtxCurrencies().then(refreshLoopContext);
  }, LOOP_CONTEXT_REFRESH_INTERVAL_MS);
}

export function stopCtx(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  stopCtxWs();
}

export async function refreshLoopContext(): Promise<void> {
  try {
    const context = await fetchLoopContext();
    applyCompany(context.company, 'refresh');
  } catch (err) {
    log.warn({ err }, 'CTX loop context refresh failed — keeping the last known company');
  }
}

function registerCompanyWsEvents(): void {
  if (companyTopicRegistered) return;
  companyTopicRegistered = true;
  registerCtxWsTopic({
    topic: 'company',
    events: COMPANY_EVENTS,
    onEvent: handleCompanyEvent,
    onSubscribed: ({ resubscribe }) => {
      if (!resubscribe) return;
      log.info('Refreshing CTX loop context after ws reconnect');
      void refreshLoopContext();
    },
  });
}

function handleCompanyEvent(eventName: string, data: unknown): void {
  const parsed = CtxCompanySchema.safeParse(data);
  if (!parsed.success) {
    log.warn(
      { event: eventName, issues: parsed.error.issues.slice(0, 5) },
      'CTX ws company event payload failed validation — ignoring',
    );
    return;
  }
  if (loopContext !== null && parsed.data.id !== loopContext.company.id) return;
  applyCompany(parsed.data, eventName);
}

function applyCompany(company: CtxCompany, source: string): void {
  if (loopContext === null) return;
  loopContext = { ...loopContext, company };
  log.info(
    {
      source,
      companyId: company.id,
      countries: company.countries,
      paymentCurrencies: company.paymentCurrencies,
      stableCurrencies: company.stableCurrencies,
    },
    'CTX loop company updated',
  );
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
  companyTopicRegistered = false;
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
