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

  it('pointCount reflects full cell membership, not just visible subset', () => {
    // Documented behaviour (matches Go reference impl): callers pre-load an
    // expanded bbox, so a cell can contain points outside the visible bounds.
    // The cluster's pointCount shows the TOTAL, while the centroid is the
    // mean of only the visible points.
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    const locations = [
      loc('visible-1', 1, 1),
      loc('visible-2', 2, 2),
      loc('hidden-1', 15, 15), // outside bounds but same 20° cell at zoom 1
    ];
    const result = clusterLocations(locations, bounds, 1);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(3);
    // Centroid is mean of ONLY visible points: (1+2)/2, (1+2)/2
    expect(result.clusterPoints[0]!.geometry.coordinates.longitude).toBeCloseTo(1.5, 5);
    expect(result.clusterPoints[0]!.geometry.coordinates.latitude).toBeCloseTo(1.5, 5);
  });

  it('omits clusters whose every point is outside bounds', () => {
    // Cell has 2+ points but none are visible → cluster is suppressed.
    // Prevents rendering a cluster pin that would appear in empty map space.
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    const locations = [loc('hidden-1', 25, 25), loc('hidden-2', 26, 26)];
    const result = clusterLocations(locations, bounds, 1);
    expect(result.clusterPoints).toHaveLength(0);
    expect(result.locationPoints).toHaveLength(0);
  });

  it('clusters negative coordinates correctly (southern/western hemispheres)', () => {
    // Western hemisphere regression — Math.floor on negative numbers can be
    // subtle. Two points at (-5, -5) and (-6, -6) must land in the same
    // 20° cell at zoom 1: floor(-5/20) = floor(-6/20) = -1.
    const locations = [loc('a', -5, -5), loc('b', -6, -6)];
    const result = clusterLocations(locations, BOUNDS, 1);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(2);
  });

  it('includes points on the exact bounds edge (inclusive ≤)', () => {
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    // Points sitting exactly on each edge must be visible (the check is ≤).
    const locations = [
      loc('north-edge', 5, 10),
      loc('south-edge', 5, 0),
      loc('east-edge', 10, 5),
      loc('west-edge', 0, 5),
    ];
    const result = clusterLocations(locations, bounds, 14);
    expect(result.locationPoints).toHaveLength(4);
  });
});
