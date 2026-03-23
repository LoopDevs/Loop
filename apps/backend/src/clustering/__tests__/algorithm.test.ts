import { describe, it, expect } from 'vitest';
import { clusterLocations, gridSizeForZoom } from '../algorithm.js';
import type { Location, Bounds } from '../algorithm.js';

const BOUNDS: Bounds = { west: -180, south: -90, east: 180, north: 90 };

// ─── Grid sizes ───────────────────────────────────────────────────────────────

describe('gridSizeForZoom', () => {
  it.each([
    [0, 20.0],
    [1, 20.0],
    [3, 20.0],
    [4, 10.0],
    [5, 10.0],
    [6, 5.0],
    [7, 1.5],
    [8, 0.5],
    [9, 0.5],
    [10, 0.1],
    [11, 0.1],
    [12, 0.03],
    [13, 0.03],
    [14, 0.0],
    [18, 0.0],
  ])('zoom %i → %f°', (zoom, expected) => {
    expect(gridSizeForZoom(zoom)).toBe(expected);
  });
});

// ─── Clustering ───────────────────────────────────────────────────────────────

describe('clusterLocations', () => {
  const loc = (id: string, lng: number, lat: number): Location => ({
    merchantId: id,
    mapPinUrl: null,
    longitude: lng,
    latitude: lat,
  });

  it('returns empty result for no locations', () => {
    const result = clusterLocations([], BOUNDS, 10);
    expect(result.locationPoints).toHaveLength(0);
    expect(result.clusterPoints).toHaveLength(0);
  });

  it('returns individual points at zoom ≥ 14', () => {
    const locations = [loc('a', 0, 0), loc('b', 0.001, 0.001)];
    const result = clusterLocations(locations, BOUNDS, 14);
    expect(result.locationPoints).toHaveLength(2);
    expect(result.clusterPoints).toHaveLength(0);
  });

  it('clusters nearby points at low zoom', () => {
    // Two points in the same 20° grid cell at zoom 1
    const locations = [loc('a', 1, 1), loc('b', 2, 2)];
    const result = clusterLocations(locations, BOUNDS, 1);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.locationPoints).toHaveLength(0);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(2);
  });

  it('returns individual point when a grid cell has only one location', () => {
    // At zoom 10 (0.1° grid), points far enough apart to be in different cells
    const locations = [loc('a', 0, 0), loc('b', 10, 10)];
    const result = clusterLocations(locations, BOUNDS, 10);
    expect(result.locationPoints).toHaveLength(2);
    expect(result.clusterPoints).toHaveLength(0);
  });

  it('omits points outside the original bounds', () => {
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    const locations = [loc('a', -1, 5), loc('b', 5, 5)]; // -1,5 outside bounds
    const result = clusterLocations(locations, bounds, 14);
    expect(result.locationPoints).toHaveLength(1);
    expect(result.locationPoints[0]!.properties.merchantId).toBe('b');
  });

  it('cluster centroid is the mean of visible points', () => {
    // Both in the same 20° cell at zoom 1, both visible
    const locations = [loc('a', 0, 0), loc('b', 2, 4)];
    const result = clusterLocations(locations, BOUNDS, 1);
    expect(result.clusterPoints).toHaveLength(1);
    const { coordinates } = result.clusterPoints[0]!.geometry;
    expect(coordinates.longitude).toBeCloseTo(1, 5);
    expect(coordinates.latitude).toBeCloseTo(2, 5);
  });

  it('sets cluster=false on location points', () => {
    const result = clusterLocations([loc('a', 0, 0)], BOUNDS, 14);
    expect(result.locationPoints[0]!.properties.cluster).toBe(false);
  });

  it('sets cluster=true on cluster points', () => {
    const locations = [loc('a', 1, 1), loc('b', 2, 2)];
    const result = clusterLocations(locations, BOUNDS, 1);
    expect(result.clusterPoints[0]!.properties.cluster).toBe(true);
  });

  it('assigns unique sequential ids to clusters', () => {
    // Three points in three separate cells at zoom 14 won't cluster.
    // Put them in cells that will cluster at zoom 1 — two pairs.
    const locations = [
      loc('a', 1, 1),
      loc('b', 2, 2), // same 20° cell
      loc('c', 25, 25),
      loc('d', 26, 26), // different 20° cell
    ];
    const result = clusterLocations(locations, BOUNDS, 1);
    const ids = result.clusterPoints.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([0, 1]);
  });
});
