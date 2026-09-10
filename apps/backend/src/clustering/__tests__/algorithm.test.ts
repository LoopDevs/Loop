import { describe, it, expect } from 'vitest';
import { clusterLocations, gridSizeForZoom } from '../algorithm.js';
import type { Location, Bounds } from '../algorithm.js';

const BOUNDS: Bounds = { west: -180, south: -90, east: 180, north: 90 };

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
    const locations = [loc('a', 1, 1), loc('b', 2, 2)];
    const result = clusterLocations(locations, BOUNDS, 1);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.locationPoints).toHaveLength(0);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(2);
  });

  it('returns individual point when a grid cell has only one location', () => {
    const locations = [loc('a', 0, 0), loc('b', 10, 10)];
    const result = clusterLocations(locations, BOUNDS, 10);
    expect(result.locationPoints).toHaveLength(2);
    expect(result.clusterPoints).toHaveLength(0);
  });

  it('omits points outside the original bounds', () => {
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    const locations = [loc('a', -1, 5), loc('b', 5, 5)];
    const result = clusterLocations(locations, bounds, 14);
    expect(result.locationPoints).toHaveLength(1);
    expect(result.locationPoints[0]!.properties.merchantId).toBe('b');
  });

  it('cluster centroid is the mean of visible points', () => {
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
    // Callers pre-load an expanded bbox, so a cell can contain points outside the visible bounds.
    // pointCount shows the TOTAL, while the centroid is the mean of only the visible points.
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    const locations = [
      loc('visible-1', 1, 1),
      loc('visible-2', 2, 2),
      loc('hidden-1', 15, 15), // outside bounds but same 20° cell at zoom 1
    ];
    const result = clusterLocations(locations, bounds, 1);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(3);
    expect(result.clusterPoints[0]!.geometry.coordinates.longitude).toBeCloseTo(1.5, 5);
    expect(result.clusterPoints[0]!.geometry.coordinates.latitude).toBeCloseTo(1.5, 5);
  });

  it('omits clusters whose every point is outside bounds', () => {
    // Prevents rendering a cluster pin that would appear in empty map space.
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
    const locations = [loc('hidden-1', 25, 25), loc('hidden-2', 26, 26)];
    const result = clusterLocations(locations, bounds, 1);
    expect(result.clusterPoints).toHaveLength(0);
    expect(result.locationPoints).toHaveLength(0);
  });

  it('clusters negative coordinates correctly (southern/western hemispheres)', () => {
    // Math.floor on negative numbers can be subtle.
    const locations = [loc('a', -5, -5), loc('b', -6, -6)];
    const result = clusterLocations(locations, BOUNDS, 1);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(2);
  });

  it('assigns a point at exactly 0.3° to the correct cell at zoom 10 (FP precision)', () => {
    // Math.floor(0.3 / 0.1) is 2 in IEEE-754, but the correct cell is 3.
    // The algorithm uses Math.floor(lng * invGridSize) to dodge the issue.
    const bounds: Bounds = { west: 0, south: 0, east: 1, north: 1 };
    const locations = [loc('at-30', 0.3, 0.3), loc('near-31', 0.31, 0.31)];
    const result = clusterLocations(locations, bounds, 10);
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(2);
  });

  it('filters out locations with non-finite coordinates', () => {
    const locations = [
      loc('good', 1, 1),
      loc('nan-lng', Number.NaN, 1),
      loc('nan-lat', 1, Number.NaN),
      loc('inf-lng', Number.POSITIVE_INFINITY, 1),
      loc('neg-inf-lat', 1, Number.NEGATIVE_INFINITY),
      loc('good2', 2, 2),
    ];
    const result = clusterLocations(locations, BOUNDS, 1);
    // NaN/Infinity points must not form a bogus "NaN,NaN" cell that would cluster every invalid record together.
    expect(result.clusterPoints).toHaveLength(1);
    expect(result.clusterPoints[0]!.properties.pointCount).toBe(2);
  });

  it('includes points on the exact bounds edge (inclusive ≤)', () => {
    const bounds: Bounds = { west: 0, south: 0, east: 10, north: 10 };
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
