import type { Context } from 'hono';
import { clusterLocations } from './algorithm.js';
import { getLocations } from './data-store.js';
import { logger } from '../logger.js';

const PROTOBUF_MIME = 'application/x-protobuf';

/**
 * GET /api/clusters
 *
 * Query params: west, south, east, north (float), zoom (int)
 * Responds with protobuf when Accept header includes application/x-protobuf,
 * otherwise JSON.
 */
export async function clustersHandler(c: Context): Promise<Response> {
  const log = logger.child({ handler: 'clusters' });

  const west = parseFloat(c.req.query('west') ?? '');
  const south = parseFloat(c.req.query('south') ?? '');
  const east = parseFloat(c.req.query('east') ?? '');
  const north = parseFloat(c.req.query('north') ?? '');
  const rawZoom = parseInt(c.req.query('zoom') ?? '', 10);

  if ([west, south, east, north, rawZoom].some((v) => !Number.isFinite(v))) {
    return c.json(
      {
        code: 'VALIDATION_ERROR',
        message: 'west, south, east, north, zoom are required and must be finite',
      },
      400,
    );
  }

  // Reject physically-impossible coordinate ranges. These would otherwise pass
  // through and silently produce an empty result (south > north) or random
  // output (lat/lng outside the globe) without telling the client why.
  if (
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90 ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180
  ) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'bounds are outside the globe' }, 400);
  }
  if (south > north) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'south must be <= north' }, 400);
  }
  // Note: west > east is not rejected here — some map clients legitimately
  // send date-line-crossing bounds. The current algorithm returns empty for
  // that case (documented limitation); see algorithm.ts audit notes.

  const zoom = Math.max(0, Math.min(28, rawZoom));

  // Expand bbox by 50% for pre-loading — matching Go reference behaviour.
  // Clamp the expansion to the globe so the filter below doesn't waste work
  // walking through points that couldn't be valid anyway (e.g. south-buffered
  // past -90° with a zoomed-out bbox).
  const latBuf = (north - south) * 0.5;
  const lngBuf = (east - west) * 0.5;
  const expandedBounds = {
    west: Math.max(-180, west - lngBuf),
    south: Math.max(-90, south - latBuf),
    east: Math.min(180, east + lngBuf),
    north: Math.min(90, north + latBuf),
  };

  const { locations, loadedAt } = getLocations();

  // Filter to expanded bounds
  const filtered = locations.filter(
    (loc) =>
      loc.latitude >= expandedBounds.south &&
      loc.latitude <= expandedBounds.north &&
      loc.longitude >= expandedBounds.west &&
      loc.longitude <= expandedBounds.east,
  );

  const originalBounds = { west, south, east, north };
  const start = Date.now();
  const result = clusterLocations(filtered, originalBounds, zoom);
  log.debug(
    {
      zoom,
      input: filtered.length,
      locationPoints: result.locationPoints.length,
      clusterPoints: result.clusterPoints.length,
      ms: Date.now() - start,
    },
    'Clustering complete',
  );

  const wantsProtobuf = c.req.header('Accept')?.includes(PROTOBUF_MIME) ?? false;

  if (wantsProtobuf) {
    // Lazy-import generated protobuf types to avoid hard startup dependency
    // before buf generate has been run. The two failure modes are:
    //   (a) module not present (expected in fresh checkouts, dev pre-codegen)
    //   (b) construction/encoding failure (real bug in our mapping)
    // We must not treat (b) as "fall back to JSON" — that silently hides a
    // schema drift. Only the dynamic import itself is caught here; any error
    // from `new ProtobufClusterResponse(...)` or `toBinary()` propagates out.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let ProtobufClusterResponse: any = null;
    try {
      const mod = (await import('@loop/shared/src/proto/clustering_pb.js' as any)) as any;
      ProtobufClusterResponse = mod.ProtobufClusterResponse;
    } catch (err) {
      log.warn({ err }, 'Protobuf types not generated, falling back to JSON');
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Guard against the import succeeding but the symbol being undefined —
    // which happens in tests that mock the module without providing it, and
    // in a partially-generated proto output. Either way, fall back to JSON.
    if (typeof ProtobufClusterResponse === 'function') {
      const msg = new ProtobufClusterResponse({
        locationPoints: result.locationPoints.map((p) => ({
          type: p.type,
          properties: {
            cluster: false,
            merchantId: p.properties.merchantId,
            mapPinUrl: p.properties.mapPinUrl,
          },
          geometry: {
            type: 'Point',
            coordinates: {
              longitude: p.geometry.coordinates.longitude,
              latitude: p.geometry.coordinates.latitude,
            },
          },
        })),
        clusterPoints: result.clusterPoints.map((p) => ({
          type: p.type,
          id: p.id,
          properties: { cluster: true, pointCount: p.properties.pointCount },
          geometry: {
            type: 'Point',
            coordinates: {
              longitude: p.geometry.coordinates.longitude,
              latitude: p.geometry.coordinates.latitude,
            },
          },
        })),
        total: filtered.length,
        zoom,
        loadedAt: BigInt(Math.floor(loadedAt / 1000)),
        bounds: { west, south, east, north },
      });

      const bytes = msg.toBinary();
      return new Response(bytes, {
        headers: {
          'Content-Type': PROTOBUF_MIME,
          'Cache-Control': 'public, max-age=60',
        },
      });
    }
  }

  c.header('Cache-Control', 'public, max-age=60'); // 1 minute cache for clusters
  return c.json({
    locationPoints: result.locationPoints,
    clusterPoints: result.clusterPoints,
    total: filtered.length,
    zoom,
    loadedAt: Math.floor(loadedAt / 1000),
    bounds: originalBounds,
  });
}
