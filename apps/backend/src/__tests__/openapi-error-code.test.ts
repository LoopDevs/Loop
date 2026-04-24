import { describe, it, expect } from 'vitest';

import { ApiErrorCode } from '@loop/shared';
import { generateOpenApiSpec } from '../openapi.js';

/**
 * A2-1003: ErrorResponse.code is now a zod-enum derived from the shared
 * `ApiErrorCode` const. This test pins the relationship — adding a code to
 * `packages/shared/src/api.ts` MUST widen the OpenAPI schema, removing one
 * MUST tighten it, and the two must always be set-equal.
 *
 * Without this assertion the only enforcement happens at handler emit
 * sites (where `c.json({ code: '...' }, ...)` is typed against
 * `ApiErrorCodeValue`) — but the OpenAPI doc could silently fall behind.
 */
describe('OpenAPI ErrorResponse.code (A2-1003)', () => {
  it('enumerates every value in shared ApiErrorCode and nothing else', () => {
    const spec = generateOpenApiSpec();
    const errorResponse = spec.components?.schemas?.['ErrorResponse'];
    expect(errorResponse).toBeDefined();
    const codeProp = (errorResponse as { properties?: { code?: { enum?: unknown } } }).properties
      ?.code;
    expect(codeProp).toBeDefined();
    const enumValues = (codeProp as { enum: string[] }).enum;
    expect(Array.isArray(enumValues)).toBe(true);
    expect([...enumValues].sort()).toEqual([...Object.values(ApiErrorCode)].sort());
  });
});
