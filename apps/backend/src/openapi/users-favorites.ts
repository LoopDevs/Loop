/**
 * User favourite-merchants OpenAPI registrations.
 *
 * Three caller-scoped paths backing the per-user merchant pin list:
 *   - GET    /api/users/me/favorites
 *   - POST   /api/users/me/favorites
 *   - DELETE /api/users/me/favorites/{merchantId}
 *
 * Schemas are locally scoped to this slice — the `merchant` field
 * on the list response carries a structural reference to the
 * `Merchant` registered by `registerMerchantsOpenApi` rather than
 * re-registering. Generators that walk the `$ref`s resolve it
 * against the merchant schema in the same document.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export function registerUsersFavoritesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // The list response carries an inline merchant subset — the
  // canonical `Merchant` schema is registered by
  // `registerMerchantsOpenApi`. We deliberately don't re-register
  // it here to avoid a duplicate-name collision; clients that need
  // every Merchant field can read the dedicated Merchant schema.
  const FavoriteMerchantView = registry.register(
    'FavoriteMerchantView',
    z.object({
      merchantId: z.string(),
      createdAt: z.string().datetime(),
      merchant: z
        .union([
          z.object({
            id: z.string(),
            name: z.string(),
            logoUrl: z.string().optional(),
            cardImageUrl: z.string().optional(),
            savingsPercentage: z.number().optional(),
            enabled: z.boolean(),
          }),
          z.null(),
        ])
        .openapi({
          description:
            'Catalog row subset at read-time (see Merchant schema for the full shape); null if the merchant is temporarily evicted from the catalog (ADR 021).',
        }),
    }),
  );

  const ListFavoritesResponse = registry.register(
    'ListFavoritesResponse',
    z.object({
      favorites: z.array(FavoriteMerchantView),
      total: z.number(),
    }),
  );

  const AddFavoriteBody = registry.register(
    'AddFavoriteBody',
    z.object({ merchantId: z.string().min(1).max(256) }),
  );

  const AddFavoriteResult = registry.register(
    'AddFavoriteResult',
    z.object({
      merchantId: z.string(),
      createdAt: z.string().datetime(),
      added: z.boolean().openapi({
        description: 'true when this call inserted; false when the favourite already existed.',
      }),
    }),
  );

  const RemoveFavoriteResult = registry.register(
    'RemoveFavoriteResult',
    z.object({
      merchantId: z.string(),
      removed: z.boolean(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/users/me/favorites',
    summary: "List the caller's favourite merchants (newest first).",
    description:
      'Returns up to 50 favourite merchants joined to the in-memory catalog. Favourites pinned for catalog-evicted merchants (ADR 021) appear with `merchant: null` so the row stays restorable while the UI hides the entry.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Favourites list (possibly empty)',
        content: { 'application/json': { schema: ListFavoritesResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/users/me/favorites',
    summary: "Add a merchant to the caller's favourites.",
    description:
      'Idempotent on `(user_id, merchant_id)` — repeating the call returns the existing row with `added: false`. Refuses with 404 `MERCHANT_NOT_FOUND` for ids not in the catalog and 409 `FAVORITES_LIMIT_EXCEEDED` once the user has 50 favourites.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { 'application/json': { schema: AddFavoriteBody } } },
    },
    responses: {
      200: {
        description: 'Favourite added (or already existed)',
        content: { 'application/json': { schema: AddFavoriteResult } },
      },
      400: {
        description: 'Invalid body or non-string merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Merchant id not in the in-memory catalog',
        content: { 'application/json': { schema: errorResponse } },
      },
      409: {
        description: 'Per-user favourites cap reached',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/users/me/favorites/{merchantId}',
    summary: "Remove a merchant from the caller's favourites.",
    description:
      'Idempotent: removing a non-existent favourite returns `removed: false`, not 404. The `merchantId` param is the same string id used by the catalog.',
    tags: ['Users'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string().min(1).max(256) }) },
    responses: {
      200: {
        description: 'Favourite removed (or not present)',
        content: { 'application/json': { schema: RemoveFavoriteResult } },
      },
      400: {
        description: 'Invalid merchantId path param',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (20/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
