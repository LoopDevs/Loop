/**
 * A2-1706 — CTX upstream contract test.
 *
 * Each fixture in `apps/backend/src/__fixtures__/ctx/` is a recorded
 * (synthetic) representative response from the real CTX API for one
 * surface we proxy. This test parses each fixture through the matching
 * Zod schema. A failure means our schema can no longer accept what
 * CTX sends — i.e. someone tightened our schema in a way the real
 * upstream wouldn't satisfy. Drift in the OPPOSITE direction (CTX
 * actually changes shape) is detected at runtime by the same schemas
 * + the `e2e-real.yml` job; this test is the PR-time gate against
 * our-side narrowings.
 *
 * Refresh procedure: see `__fixtures__/ctx/README.md`. The fixture
 * shape is intentionally not exhaustive — Zod `.passthrough()` on the
 * upstream schemas means extra fields are tolerated; this test is
 * about catching the **happy path no longer parsing**.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { VerifyOtpUpstreamResponse, RefreshUpstreamResponse } from '../auth/handler.js';
import {
  CreateOrderUpstreamResponse,
  GetOrderUpstreamResponse,
  ListOrdersUpstreamResponse,
} from '../orders/handler.js';
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
    schema: GetOrderUpstreamResponse,
    surface: 'GET /gift-cards/:id',
  },
  {
    fixture: 'list-orders-response.json',
    schema: ListOrdersUpstreamResponse,
    surface: 'GET /gift-cards',
  },
];

describe('CTX upstream contract (A2-1706)', () => {
  for (const { fixture, schema, surface } of CASES) {
    it(`recorded fixture parses through the production schema — ${surface}`, () => {
      const data = loadFixture(fixture);
      const result = schema.safeParse(data);
      if (!result.success) {
        // Surface a readable failure — the default Zod issue dump is
        // hard to scan when the failure is in a deeply-nested
        // recorded payload.
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
    // Sanity check: confirm the test is actually a gate, not a
    // green-rubber-stamp. Strip a required field from the
    // verify-otp fixture and confirm the parse fails. If this passes
    // through, the schema is too loose and the contract test gives
    // false confidence.
    const data = loadFixture('verify-otp-response.json') as Record<string, unknown>;
    const broken = { ...data };
    delete broken['accessToken'];
    const result = VerifyOtpUpstreamResponse.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('every fixture in the directory is covered by a contract case', () => {
    // Defensive: catches the "added a fixture but forgot the test
    // case" footgun. If you add `foo.json` to the fixture directory
    // without adding a `CASES` entry referencing it, this test fails
    // and reminds you to wire the schema.
    const present = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const covered = CASES.map((c) => c.fixture).sort();
    expect(present).toEqual(covered);
  });
});
