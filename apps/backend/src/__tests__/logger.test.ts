import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

// env.ts throws on module load if GIFT_CARD_API_BASE_URL is missing.
vi.hoisted(() => {
  if (!process.env.GIFT_CARD_API_BASE_URL) {
    process.env.GIFT_CARD_API_BASE_URL = 'https://placeholder-for-import.local';
  }
});

/**
 * Rebuild a pino logger that mirrors the shape of `src/logger.ts` but writes
 * to an in-memory stream so we can inspect the produced JSON. Importing the
 * real logger directly would send output to stdout or pino-pretty and make
 * assertions brittle.
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
      redact: {
        paths: [
          'authorization',
          'Authorization',
          '*.authorization',
          '*.Authorization',
          'req.headers.authorization',
          'headers.authorization',
          'headers.Authorization',
          'headers.cookie',
          'accessToken',
          'refreshToken',
          '*.accessToken',
          '*.refreshToken',
          'otp',
          'code',
          '*.otp',
          'password',
          '*.password',
        ],
        censor: '[REDACTED]',
      },
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
      },
      'test',
    );
    const r = records[0] as Record<string, unknown>;
    expect(r.accessToken).toBe('[REDACTED]');
    expect(r.refreshToken).toBe('[REDACTED]');
    const tokens = r.tokens as Record<string, string>;
    expect(tokens.accessToken).toBe('[REDACTED]');
    expect(tokens.refreshToken).toBe('[REDACTED]');
  });

  it('redacts OTP and password fields', () => {
    const { logger, records } = makeLogger();
    logger.info({ otp: '123456', password: 'hunter2' }, 'test');
    const r = records[0] as Record<string, unknown>;
    expect(r.otp).toBe('[REDACTED]');
    expect(r.password).toBe('[REDACTED]');
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
});
