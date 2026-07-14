/**
 * D1 (derive OpenAPI from handler Zod schemas) — proof + regression
 * guard. For the migrated endpoints, the OpenAPI request-body component
 * is REGISTERED FROM the exact Zod schema the handler `.parse()`s
 * (`auth/request-schemas.ts`, `auth/social-schemas.ts`), so the spec
 * cannot drift from what is validated. This test pins that: every key
 * in the canonical schema appears in the generated spec component, and
 * vice-versa. A future edit that diverges the two (e.g. re-inlining the
 * spec schema and dropping a field) fails here.
 *
 * This is the pattern proven on the auth + auth-social modules; the
 * mechanical tail (the rest of `openapi/*`) follows the same shape:
 * extract the handler's schema to a schema-only module importing `z`
 * from `../openapi-zod.js`, then `registry.register(name, thatSchema)`.
 */
import { describe, it, expect } from 'vitest';
import { generateOpenApiSpec } from '../openapi.js';
import { RequestOtpBody, VerifyOtpBody, RefreshBody } from '../auth/request-schemas.js';
import { SocialLoginBody } from '../auth/social-schemas.js';
import { CreateOrderBody } from '../orders/request-schemas.js';

type SpecSchema = { properties?: Record<string, unknown> };

const spec = generateOpenApiSpec();
const components = (spec.components?.schemas ?? {}) as Record<string, SpecSchema>;

/**
 * DOC-06: the request-body components that are REGISTERED FROM a
 * canonical handler Zod schema — the spec component and the schema the
 * handler `.parse()`s are the same object, so they cannot drift. This
 * list is the complete derived set today; the divergence guard below
 * runs over ALL of it (previously it covered only the four auth bodies
 * and silently omitted `CreateOrderBody`, which was already derived in
 * `openapi/orders.ts` but untested).
 *
 * FOLLOW-UP (not yet derived — hand-written inline in `openapi/*.ts`,
 * so they can drift from the handler that validates them): the ~15
 * admin/user write bodies (credit adjustments, cashback-config upsert,
 * emission mint, order refund/redrive, staff/role writes, deposit
 * refund, vault recovery, favorites, profile, discord-notifier config).
 * Wiring each needs its handler's `.parse()` schema lifted into a
 * shared schema-only module (the `auth/request-schemas.ts` pattern) —
 * a handler-side change out of scope for this openapi-only pass. Until
 * then this test cannot guard them; the count is the follow-up backlog.
 */
const cases: Array<{ name: string; schema: { shape: Record<string, unknown> } }> = [
  { name: 'RequestOtpBody', schema: RequestOtpBody },
  { name: 'VerifyOtpBody', schema: VerifyOtpBody },
  { name: 'RefreshBody', schema: RefreshBody },
  { name: 'SocialLoginBody', schema: SocialLoginBody },
  { name: 'CreateOrderBody', schema: CreateOrderBody },
];

describe('D1: OpenAPI request bodies are DERIVED from the handler Zod schemas', () => {
  for (const { name, schema } of cases) {
    it(`${name}: spec component keys === canonical Zod schema keys`, () => {
      const canonicalKeys = Object.keys(schema.shape).sort();
      const component = components[name];
      expect(component, `spec component ${name} missing`).toBeDefined();
      const specKeys = Object.keys(component!.properties ?? {}).sort();
      expect(specKeys).toEqual(canonicalKeys);
    });
  }

  it('VerifyOtpBody carries the exact fields the handler validates', () => {
    // Concrete pin so a silent field change is obvious in the diff.
    expect(Object.keys(VerifyOtpBody.shape).sort()).toEqual(['email', 'otp', 'platform']);
    expect(Object.keys(SocialLoginBody.shape).sort()).toEqual(['idToken', 'platform']);
    expect(Object.keys(CreateOrderBody.shape).sort()).toEqual(['amount', 'merchantId']);
  });
});
