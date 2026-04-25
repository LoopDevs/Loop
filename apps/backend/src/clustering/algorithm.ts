// A2-814: `LocationPoint` + `ClusterPoint` come from `@loop/shared/merchants`.
// The two declarations were structurally identical; the shared
// version is the wire contract the web client + the openapi schema
// already consume, so the backend clusterer now imports rather
// than re-declaring them.
import type { LocationPoint, ClusterPoint } from '@loop/shared';

export type { LocationPoint, ClusterPoint };

/** A single merchant location from the in-memory store. */
export interface Location {
  merchantId: string;
  mapPinUrl: string | null;
  latitude: number;
  longitude: number;
}

export interface ClusteringResult {
  locationPoints: LocationPoint[];
  clusterPoints: ClusterPoint[];
}

/** Bounding box for a cluster request. */
export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Returns the grid cell size in degrees for a given map zoom level.
 * Larger cells → fewer, bigger clusters.
 */
export function gridSizeForZoom(zoom: number): number {
  if (zoom <= 3) return 20.0;
  if (zoom <= 5) return 10.0;
  if (zoom === 6) return 5.0;
  if (zoom <= 7) return 1.5;
  if (zoom <= 9) return 0.5;
  if (zoom <= 11) return 0.1;
  if (zoom <= 13) return 0.03;
  return 0.0; // zoom ≥ 14: individual points, no clustering
}

/**
 * Clusters locations within the given bounding box at the specified zoom level.
 *
 * The caller is expected to pass an *expanded* set of locations (bbox inflated
 * by 50% for pre-loading), but only points within the *original* bounds appear
 * in the output — matching the Go reference implementation's behaviour.
 */
export function clusterLocations(
  locations: Location[],
  bounds: Bounds,
  zoom: number,
): ClusteringResult {
  const { west, south, east, north } = bounds;
  const gridSize = gridSizeForZoom(zoom);

  const locationPoints: LocationPoint[] = [];
  const clusterPoints: ClusterPoint[] = [];

  if (gridSize === 0.0) {
    // zoom ≥ 14: return each point within the original bounds individually.
    // `>=` comparisons return false for NaN, so NaN coords are filtered out
    // here for free — no extra guard needed.
    for (const loc of locations) {
      if (
        loc.longitude >= west &&
        loc.longitude <= east &&
        loc.latitude >= south &&
        loc.latitude <= north
      ) {
        locationPoints.push(makeLocationPoint(loc));
      }
    }
    return { locationPoints, clusterPoints };
  }

  // Group locations into grid cells keyed by floor(coord * invGridSize).
  //
  // We multiply by the reciprocal instead of dividing because float precision
  // in IEEE-754 bites on the divide: `0.3 / 0.1 === 2.9999999999999996`, so
  // `Math.floor(0.3 / 0.1)` is `2` — putting a merchant at exactly 0.3°
  // into cell 2 instead of cell 3. Multiplying by 10 gives an exact result
  // for every cell size we actually use (0.03, 0.1, 0.5, 1.5, 5, 10, 20).
  // Verified by node -e 'Math.floor(0.3 * 10) === 3'.
  const invGridSize = 1 / gridSize;
  const cells = new Map<string, Location[]>();
  for (const loc of locations) {
    // Reject non-finite coords up front — NaN/Infinity would produce bogus
    // keys ('NaN,NaN' etc.) and cluster every invalid point together.
    if (!Number.isFinite(loc.longitude) || !Number.isFinite(loc.latitude)) continue;
    const gx = Math.floor(loc.longitude * invGridSize);
    const gy = Math.floor(loc.latitude * invGridSize);
    const key = `${gx},${gy}`;
    const existing = cells.get(key);
    if (existing !== undefined) {
      existing.push(loc);
    } else {
      cells.set(key, [loc]);
    }
  }

  let clusterIdCounter = 0;

  for (const cellLocs of cells.values()) {
    if (cellLocs.length === 1) {
      const loc = cellLocs[0]!;
      // Single point — include only if within original bounds
      if (
        loc.longitude >= west &&
        loc.longitude <= east &&
        loc.latitude >= south &&
        loc.latitude <= north
      ) {
        locationPoints.push(makeLocationPoint(loc));
      }
    } else {
      // Multiple points — compute centroid of visible (within original bounds) points
      let sumLng = 0;
      let sumLat = 0;
      let visibleCount = 0;

      for (const loc of cellLocs) {
        if (
          loc.longitude >= west &&
          loc.longitude <= east &&
          loc.latitude >= south &&
          loc.latitude <= north
        ) {
          sumLng += loc.longitude;
          sumLat += loc.latitude;
          visibleCount++;
        }
      }

      if (visibleCount > 0) {
        clusterPoints.push({
          type: 'Feature',
          id: clusterIdCounter++,
          properties: {
            cluster: true,
            pointCount: cellLocs.length,
          },
          geometry: {
            type: 'Point',
            coordinates: {
              longitude: sumLng / visibleCount,
              latitude: sumLat / visibleCount,
            },
          },
        });
      }
    }
  }

  return { locationPoints, clusterPoints };
}

function makeLocationPoint(loc: Location): LocationPoint {
  return {
    type: 'Feature',
    properties: {
      cluster: false,
      merchantId: loc.merchantId,
      mapPinUrl: loc.mapPinUrl ?? '',
    },
    geometry: {
      type: 'Point',
      coordinates: { longitude: loc.longitude, latitude: loc.latitude },
    },
  };
}
