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

  // Extend each side of the bbox by 50% of its dimension for pre-loading —
  // matching the Go reference behaviour. Each side grows by 0.5 × the
  // viewport's height/width, so the resulting bbox is 2× the original on
  // both axes (4× area). Clamp the expansion to the globe so the filter
  // below doesn't waste work walking through points that couldn't be valid
  // anyway (e.g. south-buffered past -90° with a zoomed-out bbox).
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
    // A4-115: protobuf-es v2 generates a schema descriptor +
    // create/toBinary/fromBinary helpers, NOT a class. The earlier
    // code constructed `new ProtobufClusterResponse(...)` which is
    // a v1-style API; the v2-generated module exports
    // `ProtobufClusterResponseSchema` plus runtime helpers. The
    // earlier `typeof ProtobufClusterResponse === 'function'`
    // check was always false (it's a TYPE-only export under v2),
    // so every protobuf-Accept request silently fell back to JSON
    // — the protobuf rail was dead.
    //
    // Lazy-import: keeps the module out of cold-start path and
    // tolerates a fresh checkout without `npm run proto:generate`
    // having run. The two failure modes:
    //   (a) module not present (codegen never ran) — fall back to JSON.
    //   (b) construction or encoding failure — propagate so a real
    //       schema drift loud-fails rather than silently masquerading.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let create: any = null;
    let toBinary: any = null;
    let ProtobufClusterResponseSchema: any = null;
    try {
      const protobufEs = (await import('@bufbuild/protobuf' as any)) as any;
      create = protobufEs.create;
      toBinary = protobufEs.toBinary;
      const mod = (await import('@loop/shared/src/proto/clustering_pb.js' as any)) as any;
      ProtobufClusterResponseSchema = mod.ProtobufClusterResponseSchema;
    } catch (err) {
      log.warn({ err }, 'Protobuf types not generated, falling back to JSON');
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    if (
      typeof create === 'function' &&
      typeof toBinary === 'function' &&
      ProtobufClusterResponseSchema !== null
    ) {
      const msg = create(ProtobufClusterResponseSchema, {
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

      const bytes = toBinary(ProtobufClusterResponseSchema, msg);
      return new Response(bytes, {
        headers: {
          'Content-Type': PROTOBUF_MIME,
          'Cache-Control': 'public, max-age=60',
          // The endpoint negotiates protobuf vs JSON on `Accept`. Without
          // this, a browser/CDN cache that served one variant would hand
          // the wrong bytes to a client that asked for the other — the
          // protobuf-expecting client would get raw JSON, fail to decode,
          // and the map would silently stop updating.
          Vary: 'Accept',
        },
      });
    }
  }

  c.header('Cache-Control', 'public, max-age=60'); // 1 minute cache for clusters
  c.header('Vary', 'Accept'); // See the protobuf branch above for rationale
  return c.json({
    locationPoints: result.locationPoints,
    clusterPoints: result.clusterPoints,
    total: filtered.length,
    zoom,
    loadedAt: Math.floor(loadedAt / 1000),
    bounds: originalBounds,
  });
}
