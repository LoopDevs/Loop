import { useEffect, useRef, useState, useCallback } from 'react';
import type { Map as LeafletMap, Layer } from 'leaflet';
import type { ClusterParams, ClusterResponse } from '@loop/shared';
import { fetchClusters } from '~/services/clusters';
import { getImageProxyUrl } from '~/utils/image';
import { useMerchants } from '~/hooks/use-merchants';

const DEBOUNCE_MS = 300;

/**
 * Full-screen Leaflet map with protobuf cluster data from the Loop backend.
 * This component is lazy-loaded — Leaflet requires browser APIs.
 */
export default function ClusterMap(): React.JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Layer[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<string>('');
  const { merchants } = useMerchants({ limit: 1000 });
  const merchantsById = useRef(new Map<string, string>());

  useEffect(() => {
    merchantsById.current = new Map(merchants.map((m) => [m.id, m.name]));
  }, [merchants]);

  const updateMarkers = useCallback(async (map: LeafletMap, L: typeof import('leaflet')): Promise<void> => {
    const bounds = map.getBounds();
    const zoom = Math.round(map.getZoom());

    const params: ClusterParams = {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
      zoom,
    };

    let data: ClusterResponse;
    try {
      data = await fetchClusters(params);
    } catch {
      return;
    }

    // Remove existing markers
    for (const layer of markersRef.current) {
      map.removeLayer(layer);
    }
    markersRef.current = [];

    const total = data.locationPoints.length + data.clusterPoints.length;
    setStatus(`${total} ${zoom >= 14 ? 'locations' : 'clusters'} • zoom ${zoom}`);

    // Add cluster markers
    for (const cluster of data.clusterPoints) {
      const { longitude: lng, latitude: lat } = cluster.geometry.coordinates;
      const count = cluster.properties.pointCount;

      const icon = L.divIcon({
        className: '',
        html: `<div style="width:40px;height:40px;border-radius:50%;background:rgba(37,99,235,0.85);border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${count}</div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      });

      const marker = L.marker([lat, lng], { icon });
      marker.on('click', () => map.setZoom(zoom + 2));
      marker.addTo(map);
      markersRef.current.push(marker);
    }

    // Add individual location markers
    for (const point of data.locationPoints) {
      const { longitude: lng, latitude: lat } = point.geometry.coordinates;
      const { merchantId, mapPinUrl } = point.properties;

      const iconHtml = mapPinUrl
        ? `<img src="${getImageProxyUrl(mapPinUrl, 64)}" style="width:32px;height:32px;border-radius:50%;border:2px solid white;object-fit:cover;box-shadow:0 2px 6px rgba(0,0,0,0.3)" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:#2563eb;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`;

      const icon = L.divIcon({
        className: '',
        html: iconHtml,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      const marker = L.marker([lat, lng], { icon });
      const merchantName = merchantsById.current.get(merchantId) ?? merchantId;
      marker.bindPopup(`<strong>${merchantName}</strong>`);
      marker.addTo(map);
      markersRef.current.push(marker);
    }
  }, []);

  useEffect(() => {
    if (mapContainerRef.current === null) return;

    let mounted = true;

    void (async () => {
      const [leafletModule] = await Promise.all([
        import('leaflet'),
        import('leaflet/dist/leaflet.css'),
      ]);
      const L = leafletModule.default;

      if (!mounted || mapContainerRef.current === null) return;

      // Fix Leaflet default icon path issue in bundlers
      delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)['_getIconUrl'];
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });

      const map = L.map(mapContainerRef.current, {
        center: [40, -98],
        zoom: 4,
        zoomControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;

      const refresh = (): void => {
        if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          void updateMarkers(map, L);
        }, DEBOUNCE_MS);
      };

      map.on('moveend', refresh);
      map.on('zoomend', refresh);

      // Initial load
      void updateMarkers(map, L);
    })();

    return () => {
      mounted = false;
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [updateMarkers]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainerRef} className="w-full h-full" />
      {status !== '' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm pointer-events-none">
          {status}
        </div>
      )}
    </div>
  );
}
