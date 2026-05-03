/**
 * Clusters / images section of the OpenAPI spec — schemas + path
 * registrations for the two map / asset endpoints:
 *
 * - `GET /api/clusters` — clustered merchant locations for a viewport
 *   (protobuf preferred via Accept header, JSON fallback for debug)
 * - `GET /api/image`   — server-side image proxy with SSRF allowlist,
 *   resize + re-encode (libvips)
 *
 * Eighth (and final) per-domain module of the openapi.ts
 * decomposition (after #1153 auth, #1154 merchants, #1155 orders,
 * #1156 users, #1157 public, #1158 admin, #1159 health).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 *
 * Generated spec is byte-identical to before this slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the clustering + image-proxy endpoints + their schemas
 * on the supplied registry. Called once from openapi.ts during
 * module init.
 */
export function registerClustersOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Clustering ─────────────────────────────────────────────────────────────

  const ClusterBounds = z.object({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  });

  const GeoJsonFeature = z.object({}).openapi({ type: 'object', description: 'GeoJSON feature.' });

  const ClusterResponse = registry.register(
    'ClusterResponse',
    z.object({
      locationPoints: z.array(GeoJsonFeature),
      clusterPoints: z.array(GeoJsonFeature),
      total: z.number(),
      zoom: z.number(),
      loadedAt: z.number(),
      bounds: ClusterBounds,
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/clusters',
    summary: 'Clustered merchant locations for the given viewport.',
    tags: ['Clustering'],
    request: {
      query: z.object({
        west: z.coerce.number().min(-180).max(180),
        south: z.coerce.number().min(-90).max(90),
        east: z.coerce.number().min(-180).max(180),
        north: z.coerce.number().min(-90).max(90),
        zoom: z.coerce.number().int().min(0).max(28),
      }),
    },
    responses: {
      200: {
        description: 'Clusters (protobuf preferred via Accept header)',
        content: {
          'application/json': { schema: ClusterResponse },
          'application/x-protobuf': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      400: {
        description: 'Validation error',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/image',
    summary: 'Fetch, resize, and re-encode a remote image (SSRF-validated).',
    tags: ['Images'],
    request: {
      query: z.object({
        url: z.string().url(),
        width: z.coerce.number().int().min(1).max(2000).optional(),
        height: z.coerce.number().int().min(1).max(2000).optional(),
        quality: z.coerce.number().int().min(1).max(100).optional(),
        mode: z.enum(['public', 'private']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Image bytes',
        content: {
          'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) },
          'image/webp': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      400: {
        description: 'Validation / SSRF rejection',
        content: { 'application/json': { schema: errorResponse } },
      },
      413: {
        description: 'Image exceeds 10MB limit',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (300/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'Upstream image error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
