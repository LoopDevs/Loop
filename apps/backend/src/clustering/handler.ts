import type { Context } from 'hono';
import { clusterLocations } from './algorithm.js';
import { getLocations } from './data-store.js';
import { logger } from '../logger.js';

const PROTOBUF_MIME = 'application/x-protobuf';

// GET /api/clusters — protobuf/JSON negotiation
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

  // Reject physically-impossible coordinate ranges to avoid silent empty results or random output.
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
  // west > east is allowed for date-line-crossing bounds; algorithm returns empty (documented limitation).

  const zoom = Math.max(0, Math.min(28, rawZoom));

  // Expand bbox by 50% per side for pre-loading (matches Go reference); clamp to globe to avoid wasted filtering.
  const latBuf = (north - south) * 0.5;
  const lngBuf = (east - west) * 0.5;
  const expandedBounds = {
    west: Math.max(-180, west - lngBuf),
    south: Math.max(-90, south - latBuf),
    east: Math.min(180, east + lngBuf),
    north: Math.min(90, north + latBuf),
  };

  const { locations, loadedAt } = getLocations();

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
    // A4-115: protobuf-es v2 exports schema + helpers, not a class. Lazy import to tolerate missing codegen.
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
          // Vary: Accept prevents CDN/browser cache from serving wrong content type to clients expecting different format.
          Vary: 'Accept',
        },
      });
    }
  }

  c.header('Cache-Control', 'public, max-age=60');
  c.header('Vary', 'Accept');
  return c.json({
    locationPoints: result.locationPoints,
    clusterPoints: result.clusterPoints,
    total: filtered.length,
    zoom,
    loadedAt: Math.floor(loadedAt / 1000),
    bounds: originalBounds,
  });
}
