import { useEffect, useRef, useState, useCallback } from 'react';
import type { Map as LeafletMap, Layer } from 'leaflet';
import type * as LeafletNamespace from 'leaflet';
import type { ClusterParams, ClusterResponse } from '@loop/shared';
import { merchantSlug } from '@loop/shared';
import { fetchClusters } from '~/services/clusters';
import { getImageProxyUrl } from '~/utils/image';
import { useMerchants } from '~/hooks/use-merchants';

const DEBOUNCE_MS = 300;

/**
 * Escapes a string for safe interpolation into HTML text content. Leaflet's
 * popup.setContent and divIcon.html both set innerHTML, so any upstream value
 * we interpolate into a popup template (merchant name, anything from the
 * cluster response) has to be escaped. The backend validates these fields
 * as non-empty strings but does not HTML-escape them — if CTX ever returns
 * a merchant with `<script>…</script>` in the name we'd XSS ourselves.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  // Backend caps the limit at MAX_PAGE_SIZE=100. Asking for 1000 was silently
  // clamped, which hid the fact that merchants past index 100 fell back to
  // showing their id in the popup instead of their name. Match the cap.
  const { merchants } = useMerchants({ limit: 100 });
  const merchantsById = useRef(new Map<string, string>());
  const onMerchantSelectRef = useRef(onMerchantSelect);
  // Track open popup so we can re-open it after zoom/pan marker refresh
  const openPopupRef = useRef<{ merchantId: string; lat: number; lng: number } | null>(null);

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
          ? `<div style="width:32px;height:32px;border-radius:6px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.3);background-image:url('${escapeHtml(getImageProxyUrl(mapPinUrl, 64))}');background-size:cover;background-position:center;background-repeat:no-repeat;"></div>`
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
        // Escape before interpolation: Leaflet sets innerHTML on popup content.
        const safeName = escapeHtml(merchantName);
        const safePinLargeUrl = mapPinUrl ? escapeHtml(getImageProxyUrl(mapPinUrl, 400)) : '';
        const safePinSmallUrl = mapPinUrl ? escapeHtml(getImageProxyUrl(mapPinUrl, 80)) : '';
        const safeHref = `/gift-card/${encodeURIComponent(slug)}`;

        // Build rich popup content
        const popupContent = `
          <div style="width:280px;font-family:system-ui,sans-serif;">
            ${mapPinUrl ? `<div style="width:100%;height:140px;background-image:url('${safePinLargeUrl}');background-size:cover;background-position:center;border-radius:8px 8px 0 0;"></div>` : '<div style="width:100%;height:60px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:8px 8px 0 0;"></div>'}
            <div style="padding:16px;">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
                ${mapPinUrl ? `<div style="width:40px;height:40px;border-radius:8px;border:2px solid #e5e7eb;background-image:url('${safePinSmallUrl}');background-size:cover;flex-shrink:0;"></div>` : ''}
                <div>
                  <div style="font-weight:600;font-size:15px;line-height:1.3;">${safeName}</div>
                </div>
              </div>
              <a href="${safeHref}"
                 style="display:block;text-align:center;padding:10px 16px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;transition:background 0.2s;"
                 onmouseover="this.style.background='#1d4ed8'"
                 onmouseout="this.style.background='#2563eb'">
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
          openPopupRef.current = { merchantId, lat, lng };
          onMerchantSelectRef.current?.(merchantId);
        });

        popup.on('remove', () => {
          // Only clear if this popup is still the tracked one
          if (
            openPopupRef.current?.merchantId === merchantId &&
            openPopupRef.current?.lat === lat
          ) {
            openPopupRef.current = null;
          }
        });

        // Re-open popup if this marker matches the previously open one
        if (
          openPopupRef.current !== null &&
          openPopupRef.current.merchantId === merchantId &&
          Math.abs(openPopupRef.current.lat - lat) < 0.0001 &&
          Math.abs(openPopupRef.current.lng - lng) < 0.0001
        ) {
          popup.setContent(popupContent);
          marker.openPopup();
        }

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
