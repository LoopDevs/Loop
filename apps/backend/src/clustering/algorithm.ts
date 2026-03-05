/** A single merchant location from the in-memory store. */
export interface Location {
  merchantId: string;
  mapPinUrl: string | null;
  latitude: number;
  longitude: number;
}

/** An individual location point (zoom ≥ 14 or single in cell). */
export interface LocationPoint {
  type: 'Feature';
  properties: {
    cluster: false;
    merchantId: string;
    mapPinUrl: string;
  };
  geometry: {
    type: 'Point';
    coordinates: { longitude: number; latitude: number };
  };
}

/** An aggregated cluster of multiple nearby locations. */
export interface ClusterPoint {
  type: 'Feature';
  id: number;
  properties: {
    cluster: true;
    pointCount: number;
  };
  geometry: {
    type: 'Point';
    coordinates: { longitude: number; latitude: number };
  };
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
    // zoom ≥ 14: return each point within the original bounds individually
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

  // Group locations into grid cells keyed by floor(coord / gridSize)
  const cells = new Map<string, Location[]>();
  for (const loc of locations) {
    const gx = Math.floor(loc.longitude / gridSize);
    const gy = Math.floor(loc.latitude / gridSize);
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
