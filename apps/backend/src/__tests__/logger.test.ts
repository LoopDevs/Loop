import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

// env.ts throws on module load if GIFT_CARD_API_BASE_URL is missing.
vi.hoisted(() => {
  if (!process.env.GIFT_CARD_API_BASE_URL) {
    process.env.GIFT_CARD_API_BASE_URL = 'https://placeholder-for-import.local';
  }
});

import { REDACT_PATHS } from '../logger.js';

/**
 * Rebuild a pino logger that uses the *same* REDACT_PATHS as the production
 * logger, but writes to an in-memory stream so we can inspect the produced
 * JSON. Importing the real logger directly would send output to stdout or
 * pino-pretty and make assertions brittle.
 *
 * Critical: we import REDACT_PATHS from `../logger.js` rather than keeping a
 * copy here. If the production list grows or shrinks, these tests follow —
 * no drift.
 */
function makeLogger(): { logger: pino.Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      try {
        records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      } catch {
        // ignore non-JSON lines
      }
      cb();
    },
  });

  const logger = pino(
    {
      level: 'info',
      base: { service: 'loop-backend', env: 'test' },
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    },
    stream,
  );

  return { logger, records };
}

describe('logger redaction', () => {
  it('redacts Authorization headers at top level and under req/headers', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer secret-token', 'user-agent': 'test' } },
        headers: { Authorization: 'Bearer secret-token-2' },
      },
      'test',
    );
    const r = records[0] as Record<string, unknown>;
    const req = r.req as { headers: Record<string, string> };
    expect(req.headers.authorization).toBe('[REDACTED]');
    expect(req.headers['user-agent']).toBe('test');
    const headers = r.headers as Record<string, string>;
    expect(headers.Authorization).toBe('[REDACTED]');
  });

  it('redacts accessToken and refreshToken at any depth', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        accessToken: 'AAA.BBB',
        refreshToken: 'rtok',
        tokens: { accessToken: 'nested', refreshToken: 'nested-rt' },
        auth: { tokens: { accessToken: 'deep', refreshToken: 'deep-rt' } },
      },
      'test',
    );
    const r = records[0] as Record<string, unknown>;
    expect(r.accessToken).toBe('[REDACTED]');
    expect(r.refreshToken).toBe('[REDACTED]');
    const tokens = r.tokens as Record<string, string>;
    expect(tokens.accessToken).toBe('[REDACTED]');
    expect(tokens.refreshToken).toBe('[REDACTED]');
    const auth = r.auth as { tokens: Record<string, string> };
    expect(auth.tokens.accessToken).toBe('[REDACTED]');
    expect(auth.tokens.refreshToken).toBe('[REDACTED]');
  });

  it('redacts OTP and password fields', () => {
    const { logger, records } = makeLogger();
    logger.info({ otp: '123456', password: 'hunter2' }, 'test');
    const r = records[0] as Record<string, unknown>;
    expect(r.otp).toBe('[REDACTED]');
    expect(r.password).toBe('[REDACTED]');
  });

  it('redacts API credentials at top level and nested', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        apiKey: 'top-key',
        apiSecret: 'top-secret',
        config: { apiKey: 'nested-key', apiSecret: 'nested-secret' },
        headers: { 'X-Api-Key': 'hdr-key', 'X-Api-Secret': 'hdr-secret' },
      },
      'test',
    );
    const r = records[0] as Record<string, unknown>;
    expect(r.apiKey).toBe('[REDACTED]');
    expect(r.apiSecret).toBe('[REDACTED]');
    const config = r.config as Record<string, string>;
    expect(config.apiKey).toBe('[REDACTED]');
    expect(config.apiSecret).toBe('[REDACTED]');
    const headers = r.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('[REDACTED]');
    expect(headers['X-Api-Secret']).toBe('[REDACTED]');
  });

  it('redacts Stellar wallet material (Phase 2 defence-in-depth)', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        secret: 'SAXXX',
        privateKey: 'pk-1',
        secretKey: 'sk-1',
        seedPhrase: 'word word word',
        mnemonic: 'abandon ability able',
        wallet: {
          secret: 'SAYYY',
          privateKey: 'pk-2',
          secretKey: 'sk-2',
          seedPhrase: 'nested seed',
          mnemonic: 'nested mnemonic',
        },
      },
      'test',
    );
    const r = records[0] as Record<string, unknown>;
    expect(r.secret).toBe('[REDACTED]');
    expect(r.privateKey).toBe('[REDACTED]');
    expect(r.secretKey).toBe('[REDACTED]');
    expect(r.seedPhrase).toBe('[REDACTED]');
    expect(r.mnemonic).toBe('[REDACTED]');
    const wallet = r.wallet as Record<string, string>;
    expect(wallet.secret).toBe('[REDACTED]');
    expect(wallet.privateKey).toBe('[REDACTED]');
    expect(wallet.secretKey).toBe('[REDACTED]');
    expect(wallet.seedPhrase).toBe('[REDACTED]');
    expect(wallet.mnemonic).toBe('[REDACTED]');
  });

  it('redacts cookie headers at common nesting depths', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        headers: { cookie: 'sid=abc' },
        req: { headers: { cookie: 'sid=def' } },
        session: { cookie: 'sid=ghi' },
      },
      'test',
    );
    const r = records[0] as Record<string, unknown>;
    const headers = r.headers as Record<string, string>;
    const req = r.req as { headers: Record<string, string> };
    const session = r.session as Record<string, string>;
    expect(headers.cookie).toBe('[REDACTED]');
    expect(req.headers.cookie).toBe('[REDACTED]');
    expect(session.cookie).toBe('[REDACTED]');
  });

  it('does not redact email (operators need it for debugging)', () => {
    const { logger, records } = makeLogger();
    logger.info({ email: 'ash@example.com' }, 'test');
    expect((records[0] as Record<string, unknown>).email).toBe('ash@example.com');
  });

  it('includes service and env in every record', () => {
    const { logger, records } = makeLogger();
    logger.info('hello');
    const r = records[0] as Record<string, unknown>;
    expect(r.service).toBe('loop-backend');
    expect(r.env).toBe('test');
  });

  it('propagates redaction through child loggers', () => {
    const { logger, records } = makeLogger();
    const child = logger.child({ module: 'auth' });
    child.info({ accessToken: 'AAA', email: 'u@example.com' }, 'login');
    const r = records[0] as Record<string, unknown>;
    expect(r.accessToken).toBe('[REDACTED]');
    expect(r.email).toBe('u@example.com');
    expect(r.module).toBe('auth');
  });

  it('A2-655/A2-1601: redacts env-named secret fields (full env-key names)', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        env: {
          LOOP_JWT_SIGNING_KEY: 'hot-key-32-chars-aaaaaaaaaaaaaaaa',
          LOOP_JWT_SIGNING_KEY_PREVIOUS: 'cold-key-32-chars-bbbbbbbbbbbbbbbb',
          GIFT_CARD_API_KEY: 'gc-key',
          GIFT_CARD_API_SECRET: 'gc-secret',
          DATABASE_URL: 'postgres://u:hunter2@host/db',
          SENTRY_DSN: 'https://x@o.ingest.sentry.io/42',
          DISCORD_WEBHOOK_ORDERS: 'https://discord.com/api/webhooks/123/abc',
          DISCORD_WEBHOOK_MONITORING: 'https://discord.com/api/webhooks/456/def',
          DISCORD_WEBHOOK_ADMIN_AUDIT: 'https://discord.com/api/webhooks/789/ghi',
          // A non-secret field should still pass through.
          PORT: 8080,
        },
      },
      'env dump',
    );
    const e = (records[0] as Record<string, unknown>).env as Record<string, unknown>;
    expect(e['LOOP_JWT_SIGNING_KEY']).toBe('[REDACTED]');
    expect(e['LOOP_JWT_SIGNING_KEY_PREVIOUS']).toBe('[REDACTED]');
    expect(e['GIFT_CARD_API_KEY']).toBe('[REDACTED]');
    expect(e['GIFT_CARD_API_SECRET']).toBe('[REDACTED]');
    expect(e['DATABASE_URL']).toBe('[REDACTED]');
    expect(e['SENTRY_DSN']).toBe('[REDACTED]');
    expect(e['DISCORD_WEBHOOK_ORDERS']).toBe('[REDACTED]');
    expect(e['DISCORD_WEBHOOK_MONITORING']).toBe('[REDACTED]');
    expect(e['DISCORD_WEBHOOK_ADMIN_AUDIT']).toBe('[REDACTED]');
    // PORT survives — only secret-bearing env keys are redacted.
    expect(e['PORT']).toBe(8080);
  });

  it('A2-655/A2-1601: also redacts env-named secrets at top level (log(env) direct)', () => {
    const { logger, records } = makeLogger();
    logger.info(
      {
        LOOP_JWT_SIGNING_KEY: 'hot',
        DATABASE_URL: 'postgres://…',
        DISCORD_WEBHOOK_ORDERS: 'https://…',
      },
      'direct env log',
    );
    const r = records[0] as Record<string, unknown>;
    expect(r['LOOP_JWT_SIGNING_KEY']).toBe('[REDACTED]');
    expect(r['DATABASE_URL']).toBe('[REDACTED]');
    expect(r['DISCORD_WEBHOOK_ORDERS']).toBe('[REDACTED]');
  });
});
