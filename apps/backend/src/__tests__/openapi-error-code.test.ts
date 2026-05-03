import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiErrorCode } from '@loop/shared';
import { generateOpenApiSpec } from '../openapi.js';

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectSourceFiles(nextPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(nextPath);
  }
  return files;
}

function collectBackendErrorLiterals(): string[] {
  const backendSrcRoot = fileURLToPath(new URL('..', import.meta.url));
  const files = collectSourceFiles(backendSrcRoot);
  const literals = new Set<string>();
  const regex = /c\.json\(\s*\{[\s\S]{0,220}?code:\s*'([^']+)'/g;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const literal = match[1];
      if (literal !== undefined) literals.add(literal);
    }
  }

  return [...literals].sort();
}

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

  it('covers every backend-emitted error code literal', () => {
    const backendCodes = collectBackendErrorLiterals();
    const sharedCodes = new Set<string>(Object.values(ApiErrorCode));
    expect(backendCodes.filter((code) => !sharedCodes.has(code))).toEqual([]);
  });

  it('documents dual-path auth and the request-otp 503 contract truthfully', () => {
    const spec = generateOpenApiSpec();
    const paths = spec.paths ?? {};
    expect(spec.info.description).toContain('Auth runs in two modes');

    const bearerAuth = spec.components?.securitySchemes?.['bearerAuth'] as
      | { description?: string }
      | undefined;
    expect(bearerAuth?.description).toContain('Loop-native auth is enabled');

    const requestOtpPost = (
      paths['/api/auth/request-otp'] as {
        post?: { responses?: Record<string, { description?: string }> };
      }
    ).post;
    expect(requestOtpPost?.responses?.['503']?.description).toContain('SUBSYSTEM_DISABLED');
    expect(requestOtpPost?.responses?.['503']?.description).not.toContain('circuit open');

    const googleSocialPost = (
      paths['/api/auth/social/google'] as {
        post?: { responses?: Record<string, { description?: string }> };
      }
    ).post;
    expect(googleSocialPost?.responses?.['404']?.description).toContain('NOT_FOUND');
  });
});
