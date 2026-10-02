import { z } from 'zod';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { ctxFetch } from './api-fetch.js';

const log = logger.child({ area: 'ctx-currencies' });

const FETCH_TIMEOUT_MS = 10_000;

const CtxCurrencySchema = z
  .object({
    code: z.string().min(1),
    name: z.string(),
    decimals: z.number().int().nonnegative(),
    crypto: z.boolean(),
    chain: z.string().optional(),
  })
  .passthrough();

const CtxCurrencyListSchema = z
  .object({
    result: z.array(CtxCurrencySchema),
  })
  .passthrough();

export type CtxCurrency = z.infer<typeof CtxCurrencySchema>;

let currencies: Map<string, CtxCurrency> | null = null;

export function getCtxCurrencies(): Map<string, CtxCurrency> {
  if (currencies === null) {
    throw new Error('CTX currencies unavailable — loadCtxCurrencies() has not completed');
  }
  return currencies;
}

export function ctxCurrency(code: string): CtxCurrency | undefined {
  return getCtxCurrencies().get(code.trim().toUpperCase());
}

export function isCtxFiatCurrency(code: string): boolean {
  const currency = ctxCurrency(code);
  return currency !== undefined && !currency.crypto;
}

export function isCtxCryptoCurrency(code: string): boolean {
  return ctxCurrency(code)?.crypto === true;
}

export async function loadCtxCurrencies(): Promise<void> {
  let res: Response;
  try {
    res = await ctxFetch(upstreamUrl('/currencies'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error('CTX startup failed: GET /currencies failed', { cause: err });
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw new Error(`CTX startup failed: GET /currencies returned ${res.status}`);
  }
  const parsed = CtxCurrencyListSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `CTX startup failed: GET /currencies response shape invalid: ${parsed.error.message}`,
    );
  }
  currencies = new Map(parsed.data.result.map((c) => [c.code.toUpperCase(), c]));
  log.info({ count: currencies.size }, 'CTX currencies loaded');
}

export async function refreshCtxCurrencies(): Promise<void> {
  try {
    await loadCtxCurrencies();
  } catch (err) {
    log.warn({ err }, 'CTX currencies refresh failed — keeping the last known registry');
  }
}

export function __resetCtxCurrenciesForTests(): void {
  currencies = null;
}
