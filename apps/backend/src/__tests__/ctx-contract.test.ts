// A2-1706 — CTX upstream contract test
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { VerifyOtpUpstreamResponse, RefreshUpstreamResponse } from '../auth/handler.js';
import { CreateOrderUpstreamResponse } from '../orders/handler-shared.js';
import { CtxGiftCardSchema } from '../orders/ctx-order.js';
import { UpstreamMerchantSchema, UpstreamListResponseSchema } from '../merchants/sync.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'ctx');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}

interface ContractCase {
  fixture: string;
  schema: z.ZodTypeAny;
  surface: string;
}

const CASES: ContractCase[] = [
  {
    fixture: 'verify-otp-response.json',
    schema: VerifyOtpUpstreamResponse,
    surface: 'POST /verify-email',
  },
  {
    fixture: 'refresh-token-response.json',
    schema: RefreshUpstreamResponse,
    surface: 'POST /refresh-token',
  },
  {
    fixture: 'merchants-list-response.json',
    schema: UpstreamListResponseSchema,
    surface: 'GET /merchants',
  },
  {
    fixture: 'merchant-item.json',
    schema: UpstreamMerchantSchema,
    surface: 'GET /merchants — single result item',
  },
  {
    fixture: 'create-order-response.json',
    schema: CreateOrderUpstreamResponse,
    surface: 'POST /gift-cards',
  },
  {
    fixture: 'get-order-response.json',
    schema: CtxGiftCardSchema,
    surface: 'GET /gift-cards/:id',
  },
];

describe('CTX upstream contract (A2-1706)', () => {
  for (const { fixture, schema, surface } of CASES) {
    it(`recorded fixture parses through the production schema — ${surface}`, () => {
      const data = loadFixture(fixture);
      const result = schema.safeParse(data);
      if (!result.success) {
        const issues = result.error.issues
          .map(
            (issue) =>
              `  - path=[${issue.path.join('.')}] code=${issue.code} message="${issue.message}"`,
          )
          .join('\n');
        throw new Error(
          `Fixture ${fixture} (surface: ${surface}) no longer parses through its schema. Issues:\n${issues}`,
        );
      }
      expect(result.success).toBe(true);
    });
  }

  it('a fixture with a missing required field fails the parse (smoke test for the gate itself)', () => {
    const data = loadFixture('verify-otp-response.json') as Record<string, unknown>;
    const broken = { ...data };
    delete broken['accessToken'];
    const result = VerifyOtpUpstreamResponse.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('every fixture in the directory is covered by a contract case', () => {
    const present = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const covered = CASES.map((c) => c.fixture).sort();
    expect(present).toEqual(covered);
  });
});
