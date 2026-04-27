/**
 * User profile + Stellar OpenAPI registrations
 * (ADR 015).
 *
 * Lifted out of `apps/backend/src/openapi/users.ts`. Four caller-
 * scoped paths covering the user profile + home-currency setter
 * and the linked-wallet pair (set address, read trustlines):
 *
 *   - GET  /api/users/me                        (profile)
 *   - POST /api/users/me/home-currency          (onboarding setter)
 *   - PUT  /api/users/me/stellar-address        (link wallet)
 *   - GET  /api/users/me/stellar-trustlines     (Horizon trustline read)
 *
 * Five locally-scoped schemas travel with the slice:
 *
 *   - `UserMeView`
 *   - `SetHomeCurrencyBody`
 *   - `SetStellarAddressBody`
 *   - `StellarTrustlineRow` / `StellarTrustlinesResponse`
 *
 * Only `errorResponse` crosses the slice boundary. The
 * `STELLAR_PUBKEY_REGEX` import is moved with the slice — it\'s
 * referenced only by `SetStellarAddressBody` and is no longer
 * needed in the parent factory.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';
import { registerUsersStellarTrustlinesOpenApi } from './users-stellar-trustlines.js';

/**
 * Registers the user profile + Stellar paths + their locally-
 * scoped schemas on the supplied registry. Called once from
 * `registerUsersOpenApi`.
 */
export function registerUsersProfileOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  loopAssetCode: z.ZodTypeAny,
): void {
  const UserMeView = registry.register(
    'UserMeView',
    z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      isAdmin: z.boolean(),
      homeCurrency: z.enum(['USD', 'GBP', 'EUR']).openapi({
        description:
          'Fiat the account is denominated in (ADR 015). Drives order pricing + the LOOP-asset cashback payout.',
      }),
      stellarAddress: z.string().nullable().openapi({
        description:
          "User's linked Stellar wallet for on-chain payouts. Null = unlinked; cashback accrues off-chain only.",
      }),
      homeCurrencyBalanceMinor: z.string().openapi({
        description:
          'Off-chain cashback balance in `homeCurrency` minor units (pence / cents), as a bigint-string so JSON round-trips don\'t truncate precision. `"0"` when the user has no ledger row yet (first-order users, pre-cashback).',
      }),
    }),
  );

  const SetHomeCurrencyBody = registry.register(
    'SetHomeCurrencyBody',
    z.object({
      currency: z.enum(['USD', 'GBP', 'EUR']),
    }),
  );

  const SetStellarAddressBody = registry.register(
    'SetStellarAddressBody',
    z.object({
      address: z.string().regex(STELLAR_PUBKEY_REGEX).nullable().openapi({
        description: 'Stellar public key (G…). Passing null unlinks the current wallet.',
      }),
    }),
  );

  // ─── User profile (ADR 015) ──────────────────────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/api/users/me',
    summary: 'Current user profile (ADR 015).',
    description:
      'Returns id / email / admin flag / home currency / linked Stellar address. Home currency drives order denomination + cashback-asset selection; the linked address is the destination for on-chain LOOP-asset payouts (null = off-chain accrual only).',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Profile', content: { 'application/json': { schema: UserMeView } } },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/home-currency',
    summary: "Set the user's home currency (ADR 015).",
    description:
      'Onboarding-time picker. Writes `users.home_currency` when the user has zero orders. After the first order lands, the ledger is pinned to that currency and the endpoint returns 409 `HOME_CURRENCY_LOCKED` — support has a separate path to correct it.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: SetHomeCurrencyBody } } } },
    responses: {
      200: {
        description: 'Updated profile',
        content: { 'application/json': { schema: UserMeView } },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User row disappeared between resolve + update',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'HOME_CURRENCY_LOCKED — user has already placed orders',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/users/me/stellar-address',
    summary: "Link or unlink the user's Stellar wallet (ADR 015).",
    description:
      'Pass a Stellar public key (G…) to opt into on-chain cashback payouts; pass `null` to unlink. Relinking is allowed at any time — the column is a routing hint, not a ledger-pinned value.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: SetStellarAddressBody } } } },
    responses: {
      200: {
        description: 'Updated profile',
        content: { 'application/json': { schema: UserMeView } },
      },
      400: {
        description: 'Malformed Stellar pubkey',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User row disappeared between resolve + update',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error resolving the user',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // The Horizon-trustline path
  // (`/api/users/me/stellar-trustlines`) and its two locally-scoped
  // schemas (`StellarTrustlineRow`, `StellarTrustlinesResponse`)
  // live in `./users-stellar-trustlines.ts`. Same path-registration
  // position as the original block.
  registerUsersStellarTrustlinesOpenApi(registry, errorResponse, loopAssetCode);
}
