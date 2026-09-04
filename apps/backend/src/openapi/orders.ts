/**
 * Orders section of the OpenAPI spec — schemas + path
 * registrations for `/api/orders/*` (legacy CTX-proxy paths) and
 * `/api/orders/loop/*` (ADR 015 Loop-native paths).
 *
 * Third per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `pagination` — registered Pagination schema (also used by
 *   the merchants section).
 *
 * The 6 endpoints + ~12 zod schemas + every per-status response
 * description preserved verbatim — generated spec is byte-
 * identical to before this slice (validated via the existing
 * 1844 backend tests).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerOrdersLoopOpenApi } from './orders-loop.js';
import { registerOrdersReadsOpenApi } from './orders-reads.js';

/**
 * Registers all `/api/orders/*` and `/api/orders/loop/*` schemas
 * + paths on the supplied registry.
 */
export function registerOrdersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  pagination: ReturnType<OpenAPIRegistry['register']>,
): void {
  // The two CTX-proxy read paths (list + detail) and their three
  // locally-scoped schemas (`Order`, `OrderListResponse`,
  // `OrderDetailResponse`) live in `./orders-reads.ts`. Same
  // path-registration position as the original block.

  // Loop-native order surface — POST/GET/GET on /api/orders/loop
  // (ADR 010 / 015). Lifted into ./orders-loop.ts; the slice carries
  // its own LoopOrderView / LoopCreateOrderBody / LoopPayment*
  // schemas. Zero schema overlap with the legacy CTX-proxy flow above.
  registerOrdersLoopOpenApi(registry, errorResponse);

  // The CTX-proxy read paths (list + detail) live in
  // `./orders-reads.ts` along with their three locally-scoped
  // schemas. Registered after the create path above so OpenAPI
  // path-registration order is preserved.
  registerOrdersReadsOpenApi(registry, errorResponse, pagination);
}
