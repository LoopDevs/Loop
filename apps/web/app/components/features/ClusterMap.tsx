import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import type { Map as LeafletMap, Layer } from 'leaflet';
import type * as LeafletNamespace from 'leaflet';
import type { ClusterParams, ClusterResponse } from '@loop/shared';
import { ApiException, merchantSlug } from '@loop/shared';
import * as Sentry from '@sentry/react';
import { fetchClusters } from '~/services/clusters';
import { getImageProxyUrl } from '~/utils/image';
import { useAllMerchants } from '~/hooks/use-merchants';

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
  // Cancels the previous in-flight cluster fetch when a new move/zoom fires
  // after the 300ms debounce. Without this, two fast pans could have two
  // fetches in flight and the slower one (stale for the old viewport) would
  // clobber the markers from the fresh one. fetchClusters signal support
  // added in PR #55 surfaces the abort as a swallowed TIMEOUT-coded error.
  const fetchAbortRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<string>('');
  const [creditsOpen, setCreditsOpen] = useState(false);
  // Geolocation — one-shot "find me" that drops a marker + pans.
  // Kept as refs (not state) because the marker and Leaflet module
  // are imperative APIs; no render-side consumers care.
  const leafletRef = useRef<typeof LeafletNamespace | null>(null);
  const userMarkerRef = useRef<Layer | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  // Track viewport width once, kept in a ref so the Leaflet marker
  // click closures (which are attached once per marker) pick up the
  // latest value. md: breakpoint in Tailwind = 768px.
  const isMobileRef = useRef<boolean>(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767.98px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 767.98px)');
    const handler = (e: MediaQueryListEvent): void => {
      isMobileRef.current = e.matches;
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  // Full catalog via /api/merchants/all (audit A-002) — the paginated endpoint
  // would silently truncate past 100 merchants and popups would fall back to
  // showing the raw merchant id instead of the name.
  const { merchants } = useAllMerchants();
  const merchantsById = useRef(new Map<string, string>());
  const onMerchantSelectRef = useRef(onMerchantSelect);
  // Leaflet popup click handlers run outside React — capture navigate in a
  // ref so the 'popupopen' listener can invoke client-side nav without
  // forcing a full page reload on every "Buy Gift Card" tap.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  // Track open popup so we can re-open it after zoom/pan marker refresh
  const openPopupRef = useRef<{ merchantId: string; lat: number; lng: number } | null>(null);

  useEffect(() => {
    onMerchantSelectRef.current = onMerchantSelect;
  }, [onMerchantSelect]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    merchantsById.current = new Map(merchants.map((m) => [m.id, m.name]));
  }, [merchants]);

  const updateMarkers = useCallback(
    async (map: LeafletMap, L: typeof LeafletNamespace): Promise<void> => {
      const bounds = map.getBounds();
      const zoom = Math.round(map.getZoom());

      // Clamp to valid lon/lat ranges. Leaflet's getBounds() can return
      // values past the date line (e.g. west=-190) when the viewport is
      // wider than the world at low zooms — the backend Zod schema
      // rejects anything outside [-180,180] / [-85,85] with a 400, so
      // no pins on first load. Clamp here before dispatching.
      const params: ClusterParams = {
        west: Math.max(-180, bounds.getWest()),
        south: Math.max(-85, bounds.getSouth()),
        east: Math.min(180, bounds.getEast()),
        north: Math.min(85, bounds.getNorth()),
        zoom,
      };

      // Abort any previous in-flight fetch — a fast sequence of pans used
      // to stack requests, and the slowest-completing one could clobber
      // fresher markers.
      fetchAbortRef.current?.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;

      let data: ClusterResponse;
      try {
        data = await fetchClusters(params, controller.signal);
      } catch (err) {
        // Audit A-015: previously the catch swallowed everything silently
        // and claimed errors "fell through to the error boundary" — they
        // couldn't, because the catch was here. Distinguish now:
        //
        //   - aborts (newer fetch superseded this one) are expected; stay silent.
        //   - everything else is a real failure. Surface a status banner so
        //     the user knows the map isn't live and report to Sentry so we
        //     notice systemic failures in prod.
        const isAbort = err instanceof ApiException && err.code === 'TIMEOUT';
        if (!isAbort) {
          setStatus(
            `Map data unavailable (${err instanceof ApiException ? err.code : 'unknown'}). Pan or zoom to retry.`,
          );
          if (err instanceof Error) {
            Sentry.captureException(err, {
              tags: { area: 'map.cluster-fetch' },
              extra: { params },
            });
          }
        }
        return;
      }
      // If another fetch started while we were awaiting, let it render.
      if (fetchAbortRef.current !== controller) return;

      // Remove existing markers
      for (const layer of markersRef.current) {
        map.removeLayer(layer);
      }
      markersRef.current = [];

      // Clear any previous error state now that we have fresh data.
      // The success-path "N locations / clusters • zoom" readout was
      // debug-only and flashed on every pan / zoom; dropped.
      setStatus('');

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
        // `setZoom` keeps the current centre, so clicking a cluster just
        // zoomed in on wherever the user was looking. Pan to the cluster
        // AND zoom via `setView` so the interaction feels like drilling
        // into the cluster the user tapped.
        marker.on('click', () => map.setView([lat, lng], zoom + 2));
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
        // Only bind on desktop — on mobile the drawer is the single
        // affordance, so we never want Leaflet's popup to open.
        if (!isMobileRef.current) {
          marker.bindPopup(popup);
        }

        marker.on('click', () => {
          onMerchantSelectRef.current?.(merchantId);

          if (isMobileRef.current) {
            // Pan the map so the tapped pin lands in the top third of
            // the visible viewport, leaving the bottom two thirds free
            // for the sheet that's about to slide up. Shift the pin
            // point downward by 1/6 of the map height so the map
            // centre moves below the pin and the pin renders higher.
            const size = map.getSize();
            const zoom = map.getZoom();
            const pinPoint = map.project([lat, lng], zoom);
            pinPoint.y += size.y / 6;
            map.panTo(map.unproject(pinPoint, zoom), { animate: true });
            return;
          }

          // Desktop: set popup content before Leaflet opens it via the
          // bindPopup binding above.
          popup.setContent(popupContent);
          openPopupRef.current = { merchantId, lat, lng };
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
        // (desktop only — mobile never opens a Leaflet popup).
        if (
          !isMobileRef.current &&
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

  const handleLocate = useCallback(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (map === null || leaflet === null) return;
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setLocateError('Geolocation is not available on this device.');
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const L = leaflet;
        // Remove the previous marker before creating a new one —
        // otherwise repeat-locate drops a pile of blue dots on the
        // same spot as accuracy drifts slightly.
        if (userMarkerRef.current !== null) {
          userMarkerRef.current.remove();
          userMarkerRef.current = null;
        }
        // Custom blue-dot icon — matches the iOS/Google "you are
        // here" style (solid blue disc with white ring + soft halo).
        // Rendered as a `divIcon` so the pulsing halo is pure CSS
        // and we don't need to ship a second image asset.
        const icon = L.divIcon({
          className: 'loop-user-location',
          html: `
            <div class="loop-user-location__halo"></div>
            <div class="loop-user-location__dot"></div>
          `,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        const marker = L.marker([latitude, longitude], {
          icon,
          // Sit the user marker under any merchant popups — the
          // blue dot is orientation, not the content the user is
          // trying to click through to.
          zIndexOffset: -500,
          keyboard: false,
          interactive: false,
        }).addTo(map);
        userMarkerRef.current = marker;
        // Keep their existing zoom if they've already zoomed in;
        // otherwise jump to a city-level zoom so the dot and any
        // nearby merchant clusters both read on screen.
        const targetZoom = Math.max(map.getZoom(), 13);
        map.flyTo([latitude, longitude], targetZoom, { duration: 0.7 });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocateError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'Couldn\u2019t determine your location.'
              : 'Timed out finding your location.',
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

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
      // Stash the Leaflet module for the locate button's callback —
      // it runs outside the init effect and needs `L.divIcon` /
      // `L.marker` to plot the user's position.
      leafletRef.current = L;

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
        // Gestures (pinch / double-tap) are the primary zoom affordance
        // on mobile; the +/- buttons duplicate that and take screen
        // real estate. Web users can still pinch on a trackpad.
        zoomControl: false,
        // Default Leaflet attribution bar takes a visible strip along
        // the bottom. Suppress it here; the license-required credits
        // are still surfaced via the "ⓘ" button rendered below the map
        // container, which opens a popover with the same links.
        attributionControl: false,
      });

      const isDark =
        document.documentElement.classList.contains('dark') ||
        (!document.documentElement.classList.contains('light') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);

      // CARTO basemap tiles are a documented and accepted third-party
      // runtime dependency — see `docs/adr/005-known-limitations.md` §10.
      // CSP allowlists `basemaps.cartocdn.com` in `buildSecurityHeaders`.
      // Audit A-032.
      const tileUrl = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

      const tileLayer = L.tileLayer(tileUrl, {
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

      // Intercept "Buy Gift Card" link clicks so they stay within the SPA.
      // Leaflet injects popup HTML via innerHTML, so the <a href> would
      // otherwise trigger a full page reload — losing the map viewport,
      // re-downloading the JS bundle, and re-fetching clusters on return.
      map.on('popupopen', (e) => {
        const container = (
          e as { popup: { getElement: () => HTMLElement | undefined } }
        ).popup.getElement();
        if (container === undefined) return;
        const anchor = container.querySelector<HTMLAnchorElement>('a[href^="/gift-card/"]');
        if (anchor === null) return;
        anchor.addEventListener(
          'click',
          (clickEvent) => {
            // Preserve the user's ability to open in a new tab via modifier
            // keys / middle-click; only intercept the plain-click case.
            if (
              clickEvent.defaultPrevented ||
              clickEvent.button !== 0 ||
              clickEvent.metaKey ||
              clickEvent.ctrlKey ||
              clickEvent.shiftKey ||
              clickEvent.altKey
            ) {
              return;
            }
            clickEvent.preventDefault();
            void navigateRef.current(anchor.getAttribute('href') ?? '/');
          },
          { once: true },
        );
      });

      // Initial load
      void updateMarkers(map, L);
    })();

    return () => {
      mounted = false;
      themeObserver?.disconnect();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      fetchAbortRef.current?.abort();
      fetchAbortRef.current = null;
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

      {/* Locate-me button — floating pill, top-right. One-shot
          geolocation: drops a user marker, flies the camera to it.
          Error message surfaces below as a small toast; permission-
          denied is the most common result on first tap. */}
      <button
        type="button"
        onClick={handleLocate}
        disabled={locating}
        aria-label="Locate me"
        className="absolute right-3 bottom-16 h-10 w-10 rounded-full bg-white/90 dark:bg-gray-900/90 text-gray-900 dark:text-white shadow-lg flex items-center justify-center backdrop-blur-sm z-[400] active:scale-[0.96] transition-transform disabled:opacity-50"
      >
        {locating ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="animate-spin"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 11-9-9" />
          </svg>
        ) : (
          // Material "near_me" — the conventional diagonal
          // paper-plane glyph every map app uses for "locate me".
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21 3L3 10.53v.98l6.84 2.65L12.48 21h.98L21 3z" />
          </svg>
        )}
      </button>
      {locateError !== null && (
        <div className="absolute right-3 bottom-28 max-w-[16rem] bg-white/95 dark:bg-gray-900/95 text-[12px] text-gray-700 dark:text-gray-200 px-3 py-2 rounded-md shadow backdrop-blur-sm z-[400]">
          {locateError}
        </div>
      )}
      {/* License-required attribution for OpenStreetMap + CARTO, tucked
          behind an info button so it doesn't permanently occupy the
          corner. Same pattern Mapbox / Google Maps / Apple Maps use.
          Links open in a new tab with noopener to avoid reverse
          tabnabbing (PR #128). */}
      <button
        type="button"
        aria-label={creditsOpen ? 'Hide map credits' : 'Show map credits'}
        aria-expanded={creditsOpen}
        onClick={() => setCreditsOpen((v) => !v)}
        className="absolute bottom-3 right-3 h-7 w-7 rounded-full bg-white/85 dark:bg-gray-900/85 text-gray-700 dark:text-gray-200 shadow flex items-center justify-center text-xs font-semibold backdrop-blur-sm z-[400]"
      >
        i
      </button>
      {creditsOpen && (
        <div
          role="dialog"
          aria-label="Map credits"
          className="absolute bottom-12 right-3 max-w-[16rem] bg-white/95 dark:bg-gray-900/95 text-[11px] text-gray-700 dark:text-gray-300 px-3 py-2 rounded-md shadow backdrop-blur-sm z-[400]"
        >
          &copy;{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            OpenStreetMap
          </a>{' '}
          contributors &middot; &copy;{' '}
          <a
            href="https://carto.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            CARTO
          </a>
        </div>
      )}
    </div>
  );
}
