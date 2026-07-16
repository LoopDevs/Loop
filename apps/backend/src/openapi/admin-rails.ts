/**
 * NS-04 — admin rail kill-switch OpenAPI registration.
 *
 * Registers the three `/api/admin/rails/*` paths (list + halt + resume)
 * plus their locally-scoped schemas. Re-invoked from
 * `registerAdminOpenApi`. Mirrors the ADR-017/028-shaped body / headers /
 * envelope pattern of `./admin-order-refund.ts`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

const RAIL_ENUM = ['deposit', 'payout', 'vault', 'refund'] as const;

/**
 * Registers the rail kill-switch list/halt/resume paths + schemas on the
 * supplied registry. `adminWriteAudit` is the shared audit-envelope half
 * threaded in from `registerAdminOpenApi` (same as the credit writes).
 */
export function registerAdminRailsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminWriteAudit: ReturnType<OpenAPIRegistry['register']>,
): void {
  const RailHaltState = registry.register(
    'RailHaltState',
    z.object({
      rail: z.enum(RAIL_ENUM),
      halted: z
        .boolean()
        .openapi({ description: 'True while the rail is halted (rejects new ops).' }),
      reason: z
        .string()
        .nullable()
        .openapi({ description: 'Operator reason for the current state.' }),
      actorUserId: z
        .string()
        .uuid()
        .nullable()
        .openapi({ description: 'Admin who last toggled this rail; null if never toggled.' }),
      updatedAt: z.string().datetime(),
    }),
  );

  const RailKillSwitchesList = registry.register(
    'RailKillSwitchesList',
    z.object({ rails: z.array(RailHaltState) }),
  );

  const RailToggleBody = registry.register(
    'RailToggleBody',
    z.object({ reason: z.string().min(2).max(500) }),
  );

  const RailToggleEnvelope = registry.register(
    'RailToggleEnvelope',
    z.object({ result: RailHaltState, audit: adminWriteAudit }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/rails/kill-switches',
    summary: 'List the four money rails and their current halt state (NS-04).',
    description:
      'Returns the durable halt state of every money rail (deposit / payout / vault / refund). A missing row reads as "not halted" (the default). Admin-tier read.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Current state of all four rails',
        content: { 'application/json': { schema: RailKillSwitchesList } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not admin-tier staff (concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading rail state',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // Shared request/response shapes for the two toggle writes. The
  // parity checker does STATIC text analysis and needs literal
  // method/path on each `registerPath`, so the two calls are unrolled
  // (not looped over a template-literal path).
  const toggleRequest = {
    params: z.object({ rail: z.enum(RAIL_ENUM) }),
    headers: z.object({
      'idempotency-key': z.string().min(16).max(128).openapi({
        description:
          'Required. Scoped to (admin_user_id, key); repeats replay the stored snapshot.',
      }),
      'x-admin-step-up': z.string().openapi({
        description: 'ADR-028 step-up JWT minted by `POST /api/admin/step-up`. 5-minute TTL.',
      }),
    }),
    body: { content: { 'application/json': { schema: RailToggleBody } } },
  };
  registry.registerPath({
    method: 'post',
    path: '/api/admin/rails/{rail}/halt',
    summary: 'Halt a money rail (NS-04).',
    description:
      'Halts a money rail — its entry point rejects NEW operations (block-new-only; in-flight work runs to completion, queued rows re-drain on resume). Admin-tier + ADR-028 step-up (`rail-halt` scope). ADR-017 compliant: `Idempotency-Key` header + `reason` body (2..500 chars) required; a repeat call returns the stored snapshot with `audit.replayed: true`. Blocked operations on the enforced rail surface return 503 `RAIL_HALTED`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: toggleRequest,
    responses: {
      200: {
        description: 'Rail state updated (or replayed from snapshot)',
        content: { 'application/json': { schema: RailToggleEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or unknown rail',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not admin-tier staff (concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error toggling the rail, or an unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/rails/{rail}/resume',
    summary: 'Resume a halted money rail (NS-04).',
    description:
      'Resumes a halted money rail — its entry point accepts new operations again. Admin-tier + ADR-028 step-up (`rail-resume` scope). ADR-017 compliant: `Idempotency-Key` header + `reason` body (2..500 chars) required; a repeat call returns the stored snapshot with `audit.replayed: true`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: toggleRequest,
    responses: {
      200: {
        description: 'Rail state updated (or replayed from snapshot)',
        content: { 'application/json': { schema: RailToggleEnvelope } },
      },
      400: {
        description: 'Missing idempotency key, invalid reason, or unknown rail',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer / missing or invalid step-up token',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Caller is not admin-tier staff (concealment)',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description:
          'Internal error toggling the rail, or an unreadable replay snapshot (`IDEMPOTENCY_SNAPSHOT_CORRUPT`)',
        content: { 'application/json': { schema: errorResponse } },
      },
      503: {
        description: 'Step-up auth unavailable on this deployment (`STEP_UP_UNAVAILABLE`)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
