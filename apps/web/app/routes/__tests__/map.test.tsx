// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

/**
 * UX-08 (docs/ux-pass-2026-07-09.md): the map's initial viewport used to
 * always open on a fixed North-America-wide default regardless of the
 * active ADR-034 locale country. `MapRoute` now derives `initialView`
 * from `mapViewOf(locale.country)` (`@loop/shared`) and threads it into
 * `ClusterMap`; this checks that wiring without exercising the real
 * Leaflet map (stubbed — Leaflet needs browser APIs jsdom doesn't fully
 * provide, and is out of scope for this route-level check).
 */

afterEach(cleanup);

const { capturedProps } = vi.hoisted(() => ({
  capturedProps: {
    current: null as { initialView?: { lat: number; lng: number; zoom: number } } | null,
  },
}));

vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ isNative: false, platform: 'web' }),
}));

vi.mock('~/hooks/use-merchants', () => ({
  useAllMerchants: () => ({ merchants: [], isLoading: false, isError: false }),
}));

vi.mock('~/components/features/Navbar', () => ({ Navbar: () => null }));
vi.mock('~/components/features/MapBottomSheet', () => ({ MapBottomSheet: () => null }));

vi.mock('~/components/features/ClusterMap', () => ({
  default: (props: { initialView?: { lat: number; lng: number; zoom: number } }) => {
    capturedProps.current = props;
    return <div data-testid="cluster-map-stub" />;
  },
}));

import MapRoute from '../map';

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:country/:lang/map" element={<MapRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MapRoute initial view (UX-08)', () => {
  it('passes a GB-centered initial view for /gb/en/map', async () => {
    renderAt('/gb/en/map');
    await waitFor(() => expect(screen.getByTestId('cluster-map-stub')).toBeDefined());
    expect(capturedProps.current?.initialView).toEqual({ lat: 54.0, lng: -2.5, zoom: 5 });
  });

  it('gives /ca/en/map a different initial view than /us/en/map', async () => {
    renderAt('/ca/en/map');
    await waitFor(() => expect(screen.getByTestId('cluster-map-stub')).toBeDefined());
    const ca = capturedProps.current?.initialView;
    expect(ca).toEqual({ lat: 56.1, lng: -106.3, zoom: 3 });

    cleanup();
    renderAt('/us/en/map');
    await waitFor(() => expect(screen.getByTestId('cluster-map-stub')).toBeDefined());
    const us = capturedProps.current?.initialView;
    expect(us).toEqual({ lat: 39.8, lng: -98.6, zoom: 4 });
    expect(us).not.toEqual(ca);
  });
});
