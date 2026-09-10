// `GET /api/orders/:id/barcode-image` — authed barcode-image proxy (ADR 050)
import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../logger.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { upstreamHeaders } from './handler-shared.js';
import { extractBarcodeImageUrl } from './barcode-fields.js';
import {
  fetchAndTransformImage,
  imageResponse,
  clampDimension,
  clampQuality,
} from '../images/proxy.js';
import { validateResolvedImageUrl } from '../images/ssrf-guard.js';

const log = logger.child({ handler: 'orders-barcode-image' });

const UpstreamGiftCardRecord = z.record(z.string(), z.unknown());

export async function orderBarcodeImageHandler(c: Context): Promise<Response> {
  const orderId = c.req.param('id') ?? '';

  if (!/^[\w-]+$/.test(orderId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid order ID' }, 400);
  }

  const headers = await upstreamHeaders(c);
  if (headers === null) {
    return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
  }

  try {
    const response = await upstreamFetch(upstreamUrl(`/gift-cards/${orderId}`), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404) {
      return c.json({ code: 'NOT_FOUND', message: 'Order not found' }, 404);
    }
    if (response.status === 401) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }
    if (!response.ok) {
      const body = scrubUpstreamBody(await response.text());
      log.error({ status: response.status, body, orderId }, 'Upstream order fetch failed');
      return c.json({ code: 'UPSTREAM_ERROR', message: 'Failed to fetch order' }, 502);
    }

    const parsed = UpstreamGiftCardRecord.safeParse(await response.json());
    if (!parsed.success) {
      return c.json(
        { code: 'UPSTREAM_ERROR', message: 'Unexpected response from order provider' },
        502,
      );
    }

    const imageUrl = extractBarcodeImageUrl(parsed.data);
    if (imageUrl === undefined) {
      return c.json({ code: 'NOT_FOUND', message: 'Order has no barcode image' }, 404);
    }

    const urlError = await validateResolvedImageUrl(imageUrl);
    if (urlError !== null) {
      log.warn({ orderId, reason: urlError }, 'Resolved barcode image URL rejected');
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
    log.error({ err, orderId }, 'Barcode image proxy error');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch barcode image' }, 500);
  }
}
