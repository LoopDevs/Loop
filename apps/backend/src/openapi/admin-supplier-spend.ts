/**
 * Admin treasury credit-flow OpenAPI registration (ADR 009 / 015).
 *
 * The supplier-spend paths this slice originally carried were
 * retired with the money-in rails (ADR 052 — Loop pays CTX nothing;
 * commission accrues CTX-side and is read via
 * `/api/admin/ctx-commission`). The treasury credit-flow path that
 * travelled with them stays.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminTreasuryCreditFlowOpenApi } from './admin-treasury-credit-flow.js';

/**
 * Registers the treasury credit-flow path on the supplied registry.
 * Called once from `registerAdminOpenApi`.
 */
export function registerAdminSupplierSpendOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registerAdminTreasuryCreditFlowOpenApi(registry, errorResponse);
}
