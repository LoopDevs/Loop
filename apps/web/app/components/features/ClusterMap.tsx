import { useEffect, useRef, useState, useCallback } from 'react';
import type { Map as LeafletMap, Layer } from 'leaflet';
import type * as LeafletNamespace from 'leaflet';
import type { ClusterParams, ClusterResponse } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { fetchClusters } from '~/services/clusters';
import { getImageProxyUrl } from '~/utils/image';
import { useMerchants } from '~/hooks/use-merchants';

const DEBOUNCE_MS = 300;

interface ClusterMapProps {
  onMerchantSelect?: ((merchantId: string) => void) | undefined;
}

/**
 * Full-screen Leaflet map with protobuf cluster data from the Loop backend.
 * This component is lazy-loaded — Leaflet requires browser APIs.
 */
export default function ClusterMap({ onMerchantSelect }: ClusterMapProps): React.JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Layer[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<string>('');
  const { merchants } = useMerchants({ limit: 1000 });
  const merchantsById = useRef(new Map<string, string>());
  const onMerchantSelectRef = useRef(onMerchantSelect);

  useEffect(() => {
    onMerchantSelectRef.current = onMerchantSelect;
  }, [onMerchantSelect]);

  useEffect(() => {
    merchantsById.current = new Map(merchants.map((m) => [m.id, m.name]));
  }, [merchants]);

  const updateMarkers = useCallback(
    async (map: LeafletMap, L: typeof LeafletNamespace): Promise<void> => {
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
          ? `<div style="width:32px;height:32px;border-radius:6px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.3);background-image:url('${getImageProxyUrl(mapPinUrl, 64)}');background-size:cover;background-position:center;background-repeat:no-repeat;"></div>`
          : `<div style="width:32px;height:32px;border-radius:6px;background:#2563eb;border:2px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3)"></div>`;

        const icon = L.divIcon({
          className: '',
          html: iconHtml,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        const marker = L.marker([lat, lng], { icon });
        const merchantName = merchantsById.current.get(merchantId) ?? merchantId;
        const slug = merchantSlug(merchantName);

        // Build rich popup content
        const popupContent = `
          <div style="min-width:250px;font-family:system-ui,sans-serif;">
            ${mapPinUrl ? `<div style="width:100%;height:120px;background-image:url('${getImageProxyUrl(mapPinUrl, 300)}');background-size:cover;background-position:center;border-radius:8px 8px 0 0;"></div>` : ''}
            <div style="padding:12px;">
              <div style="font-weight:600;font-size:15px;margin-bottom:4px;">${merchantName}</div>
              <a href="/gift-card/${encodeURIComponent(slug)}"
                 style="display:inline-block;margin-top:8px;padding:8px 16px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;">
                Buy Gift Card
              </a>
            </div>
          </div>
        `;

        const popup = L.popup({
          minWidth: 260,
          maxWidth: 300,
          className: 'merchant-popup',
          closeButton: true,
        });
        marker.bindPopup(popup);

        marker.on('click', () => {
          popup.setContent(popupContent);
          onMerchantSelectRef.current?.(merchantId);
        });

        marker.addTo(map);
        markersRef.current.push(marker);
      }
    },
    [],
  );

  useEffect(() => {
    if (mapContainerRef.current === null) return;

    let mounted = true;
    let themeObserver: MutationObserver | null = null;

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
        iconRetinaUrl: '/leaflet/marker-icon-2x.png',
        iconUrl: '/leaflet/marker-icon.png',
        shadowUrl: '/leaflet/marker-shadow.png',
      });

      const map = L.map(mapContainerRef.current, {
        center: [40, -98],
        zoom: 4,
        zoomControl: true,
      });

      const isDark =
        document.documentElement.classList.contains('dark') ||
        (!document.documentElement.classList.contains('light') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);

      const tileUrl = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

      const tileLayer = L.tileLayer(tileUrl, {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 20,
        subdomains: 'abcd',
      }).addTo(map);

      // Watch for theme changes and swap tile layer
      themeObserver = new MutationObserver(() => {
        const nowDark =
          document.documentElement.classList.contains('dark') ||
          (!document.documentElement.classList.contains('light') &&
            window.matchMedia('(prefers-color-scheme: dark)').matches);
        const newUrl = nowDark
          ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
          : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        tileLayer.setUrl(newUrl);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });

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
      themeObserver?.disconnect();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [updateMarkers]);

  return (
    <div className="relative w-full h-full">
      <div
        ref={mapContainerRef}
        className="w-full h-full"
        role="region"
        aria-label="Merchant locations map"
      />
      {status !== '' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm pointer-events-none">
          {status}
        </div>
      )}
    </div>
  );
}
