// per-user merchant favourites — ADR 021, ADR 019
import type { Context } from 'hono';
import { z } from 'zod';
import type {
  AddFavoriteResult,
  FavoriteMerchantView,
  ListFavoritesResponse,
  RemoveFavoriteResult,
} from '@loop/shared';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { getMerchants } from '../merchants/sync.js';
import { logger } from '../logger.js';
import { resolveCallingUser } from './handler.js';

const log = logger.child({ handler: 'user-favorites' });

const MAX_FAVORITES_PER_USER = 50;

// `text` columns make merchant_id arbitrary length; cap it at the
// boundary so a request with a 1MB id can't reach the DB at all.
const MERCHANT_ID_MAX = 256;

const AddFavoriteBody = z.object({
  merchantId: z.string().min(1).max(MERCHANT_ID_MAX),
});

export type {
  AddFavoriteResult,
  FavoriteMerchantView,
  ListFavoritesResponse,
  RemoveFavoriteResult,
};

export async function listFavoritesHandler(c: Context): Promise<Response> {
  const user = await resolveCallingUser(c).catch((err: unknown) => {
    log.error({ err }, 'Failed to resolve calling user');
    return null;
  });
  if (user === null) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
  }

  const rows = await db
    .collection('user_favorite_merchants')
    .findMany({ userId: user.id }, { sort: [['createdAt', 'desc']] });

  const { merchantsById } = getMerchants();
  const favorites: FavoriteMerchantView[] = rows.map((row) => ({
    merchantId: row.merchantId,
    createdAt: row.createdAt.toISOString(),
    merchant: merchantsById.get(row.merchantId) ?? null,
  }));

  return c.json<ListFavoritesResponse>({ favorites, total: rows.length });
}

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

  // Cap-check + insert. Node's single-threaded execution makes the
  // read-then-insert effectively serial per process; the
  // (userId, merchantId) unique spec still backstops a duplicate of
  // the same merchant, replayed as `added: false`.
  const favorites = db.collection('user_favorite_merchants');
  const existing = await favorites.findOne({
    userId: user.id,
    merchantId: parsed.data.merchantId,
  });
  let result: { kind: 'replay' | 'added'; row: { merchantId: string; createdAt: Date } };
  if (existing !== null) {
    result = { kind: 'replay', row: existing };
  } else {
    const count = await favorites.count({ userId: user.id });
    if (count >= MAX_FAVORITES_PER_USER) {
      return c.json(
        {
          code: 'FAVORITES_LIMIT_EXCEEDED',
          message: `You can favourite at most ${MAX_FAVORITES_PER_USER} merchants. Remove one to add another.`,
        },
        409,
      );
    }
    const row = { userId: user.id, merchantId: parsed.data.merchantId, createdAt: new Date() };
    try {
      await favorites.insertOne(row);
      result = { kind: 'added', row };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await favorites.findOne({
        userId: user.id,
        merchantId: parsed.data.merchantId,
      });
      result = { kind: 'replay', row: raced ?? row };
    }
  }

  return c.json<AddFavoriteResult>({
    merchantId: result.row.merchantId,
    createdAt: result.row.createdAt.toISOString(),
    added: result.kind === 'added',
  });
}

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
    .collection('user_favorite_merchants')
    .deleteMany({ userId: user.id, merchantId });

  return c.json<RemoveFavoriteResult>({
    merchantId,
    removed: deleted > 0,
  });
}
