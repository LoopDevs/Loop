import type { Context } from 'hono';
import { db } from '../db/client.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { LoopAuthContext } from '../auth/handler.js';
import { fetchCtxCardAsOperator } from './ctx-order.js';
import { extractBarcodeImageUrl } from './barcode-fields.js';
import {
  fetchAndTransformImage,
  imageResponse,
  clampDimension,
  clampQuality,
} from '../images/proxy.js';
import { validateResolvedImageUrl } from '../images/ssrf-guard.js';

const log = logger.child({ handler: 'loop-order-barcode-image' });

export async function loopOrderBarcodeImageHandler(c: Context): Promise<Response> {
  if (!config.auth.native.enabled) {
    return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') {
    return c.json({ code: 'UNAUTHORIZED', message: 'Loop-native authentication required' }, 401);
  }
  const id = c.req.param('id');
  if (id === undefined || id.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'id is required' }, 400);
  }

  const row = await db.collection('orders').findOne({ id, userId: auth.userId });
  if (row === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }
  if (row.state !== 'fulfilled' || row.ctxOrderId === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order has no barcode image' }, 404);
  }

  try {
    const card = await fetchCtxCardAsOperator(row.ctxOrderId);
    const imageUrl = extractBarcodeImageUrl(card);
    if (imageUrl === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'Order has no barcode image' }, 404);
    }

    const urlError = await validateResolvedImageUrl(imageUrl);
    if (urlError !== null) {
      log.warn({ orderId: id, reason: urlError }, 'Resolved barcode image URL rejected');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Upstream image URL is not usable' }, 502);
    }

    const width = clampDimension(parseInt(c.req.query('width') ?? '640', 10));
    const quality = clampQuality(parseInt(c.req.query('quality') ?? '80', 10));

    const result = await fetchAndTransformImage(imageUrl, {
      width,
      height: 0,
      quality,
      forceJpeg: true,
    });
    if (!result.ok) {
      return c.json({ code: result.code, message: result.message }, result.status);
    }
    return imageResponse(result.data, result.mimeType, 'private');
  } catch (err) {
    log.error({ err, orderId: id }, 'Loop order barcode image proxy error');
    return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch barcode image' }, 502);
  }
}
