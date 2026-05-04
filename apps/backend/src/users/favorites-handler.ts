/**
 * Per-user merchant favourites — `/api/users/me/favorites`.
 *
 * Three small handlers backed by `user_favorite_merchants`:
 *
 *   - `GET    /api/users/me/favorites`             — list, newest first
 *   - `POST   /api/users/me/favorites`             — add (idempotent)
 *   - `DELETE /api/users/me/favorites/:merchantId` — remove
 *
 * The list response joins the catalog (`MerchantCatalogStore`) at
 * read-time so the client gets ready-to-render `Merchant` rows
 * without a follow-up by-id fetch. Favourites pinned for merchants
 * that have temporarily evicted from the catalog (ADR 021) are
 * filtered out of the list response — the row stays in the table so
 * the favourite re-appears once the merchant is back, but a stale
 * id never crashes the UI render path.
 *
 * `merchantId` validation reuses the catalog's `merchantsById` Map:
 * an unknown id returns `MERCHANT_NOT_FOUND`. We deliberately don't
 * fetch from upstream — favouriting a merchant that doesn't exist in
 * our catalog is a guaranteed UX dead-end and would let attackers
 * pin garbage strings.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Merchant } from '@loop/shared';
import { db } from '../db/client.js';
import { userFavoriteMerchants } from '../db/schema.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';
import { resolveCallingUser } from './handler.js';

const log = logger.child({ handler: 'user-favorites' });

const MAX_FAVORITES_PER_USER = 50;

// `text` columns make merchant_id arbitrary length; cap it at the
// boundary so a request with a 1MB id can't reach the DB at all. The
// catalog's CTX-issued ids are ~25 chars in practice; 256 is far
// above that and below any pathological size.
const MERCHANT_ID_MAX = 256;

const AddFavoriteBody = z.object({
  merchantId: z.string().min(1).max(MERCHANT_ID_MAX),
});

export interface FavoriteMerchantView {
  merchantId: string;
  /** ISO-8601, when the user added the favourite. Used for newest-first ordering on the client. */
  createdAt: string;
  /**
   * The catalog row at read-time. Null when the favourited merchant is
   * temporarily evicted from the in-memory catalog (ADR 021). The UI
   * filters these out, but exposing the field lets the client distinguish
   * "favourite is gone forever" from "we don't know yet" if we ever want
   * to surface that.
   */
  merchant: Merchant | null;
}

export interface ListFavoritesResponse {
  favorites: FavoriteMerchantView[];
  /**
   * Total favourite rows on the user's account (including evicted-merchant
   * rows). Lets the UI render "X / 50" without a separate count call.
   */
  total: number;
}

/**
 * `GET /api/users/me/favorites` — list the caller's favourite merchants
 * newest first, joined to the in-memory catalog.
 */
export async function listFavoritesHandler(c: Context): Promise<Response> {
  const user = await resolveCallingUser(c).catch((err: unknown) => {
    log.error({ err }, 'Failed to resolve calling user');
    return null;
  });
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const rows = await db
    .select({
      merchantId: userFavoriteMerchants.merchantId,
      createdAt: userFavoriteMerchants.createdAt,
    })
    .from(userFavoriteMerchants)
    .where(eq(userFavoriteMerchants.userId, user.id))
    .orderBy(desc(userFavoriteMerchants.createdAt));

  const { merchantsById } = getMerchants();
  const favorites: FavoriteMerchantView[] = rows.map((row) => ({
    merchantId: row.merchantId,
    createdAt: row.createdAt.toISOString(),
    merchant: merchantsById.get(row.merchantId) ?? null,
  }));

  return c.json<ListFavoritesResponse>({ favorites, total: rows.length });
}

export interface AddFavoriteResult {
  merchantId: string;
  createdAt: string;
  /** True when this call inserted a new row; false if the favourite already existed. */
  added: boolean;
}

/**
 * `POST /api/users/me/favorites` — add a merchant to the caller's
 * favourites. Idempotent on `(user_id, merchant_id)`: a re-add returns
 * the existing row's `createdAt` and `added: false`.
 *
 * 404 if the merchant id isn't in the in-memory catalog. 409 if the
 * user is already at the per-account cap.
 */
export async function addFavoriteHandler(c: Context): Promise<Response> {
  const user = await resolveCallingUser(c).catch((err: unknown) => {
    log.error({ err }, 'Failed to resolve calling user');
    return null;
  });
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const parsed = AddFavoriteBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid body' },
      400,
    );
  }

  const { merchantsById } = getMerchants();
  if (!merchantsById.has(parsed.data.merchantId)) {
    return c.json(
      { code: 'MERCHANT_NOT_FOUND', message: 'No merchant with that id is in the catalog' },
      404,
    );
  }

  // Cap-check + insert in a txn so two concurrent adds at the
  // boundary can't race past the cap.
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        merchantId: userFavoriteMerchants.merchantId,
        createdAt: userFavoriteMerchants.createdAt,
      })
      .from(userFavoriteMerchants)
      .where(
        and(
          eq(userFavoriteMerchants.userId, user.id),
          eq(userFavoriteMerchants.merchantId, parsed.data.merchantId),
        ),
      );
    if (existing[0] !== undefined) {
      return { kind: 'replay' as const, row: existing[0] };
    }

    const countRows = await tx
      .select({ count: sql<string>`count(*)::text` })
      .from(userFavoriteMerchants)
      .where(eq(userFavoriteMerchants.userId, user.id));
    const count = Number(countRows[0]?.count ?? '0');
    if (count >= MAX_FAVORITES_PER_USER) {
      return { kind: 'cap_exceeded' as const, count };
    }

    const inserted = await tx
      .insert(userFavoriteMerchants)
      .values({ userId: user.id, merchantId: parsed.data.merchantId })
      .returning({
        merchantId: userFavoriteMerchants.merchantId,
        createdAt: userFavoriteMerchants.createdAt,
      });
    if (inserted[0] === undefined) {
      throw new Error('insert returned no row');
    }
    return { kind: 'added' as const, row: inserted[0] };
  });

  if (result.kind === 'cap_exceeded') {
    return c.json(
      {
        code: 'FAVORITES_LIMIT_EXCEEDED',
        message: `You can favourite at most ${MAX_FAVORITES_PER_USER} merchants. Remove one to add another.`,
      },
      409,
    );
  }
  return c.json<AddFavoriteResult>({
    merchantId: result.row.merchantId,
    createdAt: result.row.createdAt.toISOString(),
    added: result.kind === 'added',
  });
}

export interface RemoveFavoriteResult {
  merchantId: string;
  /** True when this call deleted a row; false if there was nothing to remove. */
  removed: boolean;
}

/**
 * `DELETE /api/users/me/favorites/:merchantId` — remove a merchant from
 * the caller's favourites. Idempotent: removing a non-existent
 * favourite is `removed: false`, not a 404.
 */
export async function removeFavoriteHandler(c: Context): Promise<Response> {
  const merchantId = c.req.param('merchantId');
  if (merchantId === undefined || merchantId.length === 0 || merchantId.length > MERCHANT_ID_MAX) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: 'merchantId path param must be 1..256 characters' },
      400,
    );
  }

  const user = await resolveCallingUser(c).catch((err: unknown) => {
    log.error({ err }, 'Failed to resolve calling user');
    return null;
  });
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const deleted = await db
    .delete(userFavoriteMerchants)
    .where(
      and(
        eq(userFavoriteMerchants.userId, user.id),
        eq(userFavoriteMerchants.merchantId, merchantId),
      ),
    )
    .returning({ merchantId: userFavoriteMerchants.merchantId });

  return c.json<RemoveFavoriteResult>({
    merchantId,
    removed: deleted[0] !== undefined,
  });
}
