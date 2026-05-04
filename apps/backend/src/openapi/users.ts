/**
 * Users section of the OpenAPI spec — schemas + path
 * registrations for `/api/users/me/*` (the caller-scoped self-
 * view surface: profile, cashback ledger, credits, trustlines,
 * pending payouts, flywheel stats, DSR exports).
 *
 * Fourth per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 * - `loopAssetCode` — LOOP-asset code enum (USDLOOP / GBPLOOP /
 *   EURLOOP). Defined inline in openapi.ts because the Admin
 *   section uses it too — passing it in keeps the spec byte-
 *   identical without duplicating the definition.
 * - `payoutState` — pending_payouts lifecycle enum (pending /
 *   submitted / confirmed / failed). Same cross-section share as
 *   loopAssetCode.
 *
 * Every schema + path is preserved verbatim (per-status response
 * descriptions, per-route comments, the cross-cutting note about
 * the pending-payouts schemas being declared down-section so the
 * PayoutState enum from Admin is available at the top of the
 * file). Generated spec is byte-identical to before this slice.
 */
import type { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerUsersCashbackDrillOpenApi } from './users-cashback-drill.js';
import { registerUsersDsrOrdersOpenApi } from './users-dsr-orders.js';
import { registerUsersFavoritesOpenApi } from './users-favorites.js';
import { registerUsersHistoryCreditsOpenApi } from './users-history-credits.js';
import { registerUsersPendingPayoutsOpenApi } from './users-pending-payouts.js';
import { registerUsersProfileOpenApi } from './users-profile.js';

/**
 * Registers all `/api/users/me/*` schemas + paths on the
 * supplied registry. Called once from openapi.ts during module
 * init.
 */
export function registerUsersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
  payoutState: z.ZodTypeAny,
): void {
  // ─── User profile + Stellar (ADR 015) ──────────────────────────────────────
  //
  // Four caller-scoped paths backing the profile page + linked
  // Stellar wallet (/me, /me/home-currency, /me/stellar-address,
  // /me/stellar-trustlines) plus their five locally-scoped
  // schemas (UserMeView, SetHomeCurrencyBody, SetStellarAddressBody,
  // StellarTrustlineRow/Response) live in ./users-profile.ts.
  // Only `errorResponse` crosses the boundary.
  registerUsersProfileOpenApi(registry, errorResponse, loopAssetCode);

  // ─── Users cashback-history + credits (ADR 009 / 015) ──────────────────────
  //
  // The three credit-ledger read paths (cashback-history,
  // cashback-history.csv, credits) plus their four locally-scoped
  // schemas (CashbackHistoryEntry/Response, UserCreditRow/Response)
  // live in ./users-history-credits.ts. Only `errorResponse`
  // crosses the boundary.
  registerUsersHistoryCreditsOpenApi(registry, errorResponse);

  // ─── Users pending-payouts cluster (ADR 015/016/024) ───────────────────────
  //
  // The four caller-scoped pending-payouts paths
  // (/pending-payouts list + /summary, /pending-payouts/{id},
  // and the nested /orders/{orderId}/payout lookup) plus their
  // four locally-scoped schemas (UserPendingPayoutView/Response,
  // UserPendingPayoutsSummaryRow/Response) live in
  // ./users-pending-payouts.ts. Threaded deps: shared
  // `errorResponse` and `payoutState`.
  registerUsersPendingPayoutsOpenApi(registry, errorResponse, payoutState);

  // ─── Users — cashback drill (ADR 009/010/015/022) ──────────────────────────
  //
  // Five caller-side cashback views — summary, by-merchant,
  // monthly, flywheel-stats, payment-method-share — plus their
  // four locally-scoped schemas live in
  // ./users-cashback-drill.ts. Only `errorResponse` crosses the
  // boundary.
  registerUsersCashbackDrillOpenApi(registry, errorResponse);

  // ─── Users DSR + orders-summary (GDPR / ADR 009/010/015) ───────────────────
  //
  // Three small tail paths that don't fit the cashback,
  // pending-payouts, or profile clusters: DSR delete (A2-1905),
  // DSR export (A2-1906), and the lifetime + MTD orders/summary
  // counter. Lifted into ./users-dsr-orders.ts. Only
  // `errorResponse` crosses the boundary.
  registerUsersDsrOrdersOpenApi(registry, errorResponse);

  // ─── Users — favourite merchants ───────────────────────────────────────────
  //
  // Three caller-scoped paths backing the per-user merchant pin
  // list (list / add / remove). Schemas are locally scoped — the
  // list response carries an inline merchant subset rather than
  // re-registering the canonical Merchant. Only `errorResponse`
  // crosses the boundary.
  registerUsersFavoritesOpenApi(registry, errorResponse);
}
