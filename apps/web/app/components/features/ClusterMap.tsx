import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import type {
  Map as MapLibreMap,
  MapOptions,
  Marker,
  MarkerOptions,
  Popup,
  PopupOptions,
  NavigationControl,
  NavigationControlOptions,
  RasterTileSource,
} from 'maplibre-gl';
import type { ClusterParams, ClusterResponse } from '@loop/shared';
import { ApiException, merchantSlug } from '@loop/shared';
import * as Sentry from '@sentry/react';
import { fetchClusters } from '~/services/clusters';
import { getImageProxyUrl } from '~/utils/image';
import { useAllMerchants } from '~/hooks/use-merchants';

const DEBOUNCE_MS = 300;

/**
 * The shape of the dynamically-imported `maplibre-gl` module we actually
 * use (its 4 constructors). maplibre-gl's generated `.d.ts` re-exports
 * `@maplibre/maplibre-gl-style-spec`'s types via `export type * from ...`,
 * which makes `typeof import('maplibre-gl')` (equivalently, `import type *
 * as X from 'maplibre-gl'`) structurally include those type-only members
 * as pseudo-properties — a shape no real runtime value can satisfy, so a
 * dynamically-`import()`ed module's `.default` never type-checks against
 * it (even though it's the runtime-correct value — Vite's CJS/UMD interop
 * handles this fine, this is purely a `tsc` type-level mismatch). Naming
 * just the constructors we call sidesteps that entirely.
 */
interface MapLibreGl {
  Map: new (options: MapOptions) => MapLibreMap;
  Marker: new (options?: MarkerOptions) => Marker;
  Popup: new (options?: PopupOptions) => Popup;
  NavigationControl: new (options?: NavigationControlOptions) => NavigationControl;
}

// CARTO basemap tiles are a documented and accepted third-party runtime
// dependency — see `docs/adr/005-known-limitations.md` §10 and
// `docs/adr/046-maplibre-map.md` (the Leaflet → MapLibre GL JS swap, which
// deliberately kept this same raster tile source — see the ADR for why).
// CSP allowlists `*.basemaps.cartocdn.com` in `buildSecurityHeaders`.
// Audit A-032. MapLibre's style-spec `tiles` source option doesn't support
// Leaflet's `{s}` subdomain placeholder — we expand the four CARTO
// subdomains into explicit URLs ourselves; MapLibre round-robins across
// them the same way Leaflet did for load-spreading. CARTO's URL scheme
// also supports a `{r}` retina-tile placeholder — Leaflet only resolved it
// to `@2x` when `detectRetina` was set, which this map never did, so (to
// keep this a like-for-like rendering-library swap rather than also
// opting into retina tiles) we resolve `{r}` to the same empty string
// Leaflet always used here.
const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'];
const CARTO_SOURCE_ID = 'carto-basemap';
const CARTO_LAYER_ID = 'carto-basemap-layer';

function cartoTileUrls(dark: boolean): string[] {
  const style = dark ? 'dark_all' : 'rastertiles/voyager';
  return CARTO_SUBDOMAINS.map(
    (sub) => `https://${sub}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`,
  );
}

function prefersDark(): boolean {
  return (
    document.documentElement.classList.contains('dark') ||
    (!document.documentElement.classList.contains('light') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

/**
 * Escapes a string for safe interpolation into HTML text content. MapLibre's
 * Popup#setHTML and our custom marker elements' innerHTML both set raw
 * HTML, so any upstream value we interpolate into a popup template
 * (merchant name, anything from the cluster response) has to be escaped.
 * The backend validates these fields as non-empty strings but does not
 * HTML-escape them — if CTX ever returns a merchant with `<script>…</script>`
 * in the name we'd XSS ourselves.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A11Y-006: Leaflet's marker `keyboard: true` option made a marker
 * tab-focusable and fired its click handler on Enter/Space, automatically.
 * MapLibre's `Marker` has no equivalent option — markers are plain DOM
 * elements — so this wires the same behavior by hand on the element we
 * pass to `new maplibregl.Marker({ element })`.
 */
function makeKeyboardActivatable(el: HTMLElement, label: string, activate: () => void): void {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', label);
  el.title = label;
  el.style.cursor = 'pointer';
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
}

interface ClusterMapProps {
  onMerchantSelect?: ((merchantId: string) => void) | undefined;
  /**
   * Initial center/zoom (UX-08 — `docs/ux-pass-2026-07-09.md`), typically
   * `mapViewOf(locale.country)` from `@loop/shared`. `undefined` (unrouted
   * country, or caller doesn't pass one) falls back to the US-wide default
   * below so the map always renders something.
   */
  initialView?: { lat: number; lng: number; zoom: number } | undefined;
}

/**
 * Full-screen MapLibre GL map with protobuf cluster data from the Loop
 * backend. This component is lazy-loaded — MapLibre requires browser APIs
 * (WebGL canvas). See `docs/adr/046-maplibre-map.md` for the Leaflet →
 * MapLibre migration this component is the result of.
 */
export default function ClusterMap({
  onMerchantSelect,
  initialView,
}: ClusterMapProps): React.JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // UX-08: captured once at mount, not kept reactive to a later locale
  // change while the map stays mounted — this is deliberately just the
  // *initial* viewport, not a live re-center (a bigger behavior change
  // than "open looking at roughly the right part of the world").
  const initialViewRef = useRef(initialView ?? { lat: 40, lng: -98, zoom: 4 });
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
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
  // Kept as refs (not state) because the marker and MapLibre module
  // are imperative APIs; no render-side consumers care.
  const maplibreRef = useRef<MapLibreGl | null>(null);
  const userMarkerRef = useRef<Marker | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  // Track viewport width once, kept in a ref so the marker click closures
  // (which are attached once per marker) pick up the latest value. md:
  // breakpoint in Tailwind = 768px.
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
  // id → { display name, country-aware slug }. The slug is precomputed from
  // the full catalog row here (popup handlers run outside React and only have
  // the merchant id), so the popup's "Buy" link uses merchantSlug, not a
  // name-only slug that would drop the country.
  const merchantsById = useRef(new Map<string, { name: string; slug: string }>());
  const onMerchantSelectRef = useRef(onMerchantSelect);
  // Popup "open" click handlers run outside React — capture navigate in a
  // ref so the anchor click listener can invoke client-side nav without
  // forcing a full page reload on every "Buy Gift Card" tap.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  // Track open popup so we can re-open it after zoom/pan marker refresh, and
  // so a new popup open closes whichever one is currently showing (MapLibre
  // popups, unlike Leaflet's, aren't map-singleton by default).
  const openPopupRef = useRef<{ merchantId: string; lat: number; lng: number } | null>(null);
  const activePopupRef = useRef<Popup | null>(null);

  useEffect(() => {
    onMerchantSelectRef.current = onMerchantSelect;
  }, [onMerchantSelect]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    merchantsById.current = new Map(
      merchants.map((m) => [m.id, { name: m.name, slug: merchantSlug(m) }]),
    );
  }, [merchants]);

  const updateMarkers = useCallback(
    async (map: MapLibreMap, maplibregl: MapLibreGl): Promise<void> => {
      const bounds = map.getBounds();
      const zoom = Math.round(map.getZoom());

      // Clamp to valid lon/lat ranges. getBounds() can return values past
      // the date line (e.g. west=-190) when the viewport is wider than the
      // world at low zooms — the backend Zod schema rejects anything
      // outside [-180,180] / [-85,85] with a 400, so no pins on first
      // load. Clamp here before dispatching.
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
      for (const marker of markersRef.current) {
        marker.remove();
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

        const el = document.createElement('div');
        el.innerHTML = `<div style="width:40px;height:40px;border-radius:50%;background:rgba(37,99,235,0.85);border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${count}</div>`;

        // A11Y-006: focusable + named so keyboard/SR users can reach and
        // activate the cluster the same as a tap.
        const clusterLabel = `Cluster of ${count} ${count === 1 ? 'location' : 'locations'}. Activate to zoom in.`;
        // easeTo (not panTo) keeps the current centre while also zooming in
        // — clicking a cluster both pans to it AND zooms, so the
        // interaction feels like drilling into the cluster the user tapped
        // (same intent as the original `map.setView([lat,lng], zoom+2)`).
        const activate = (): void => {
          map.easeTo({ center: [lng, lat], zoom: zoom + 2 });
        };
        makeKeyboardActivatable(el, clusterLabel, activate);

        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map);
        marker.on('click', activate);
        markersRef.current.push(marker);
      }

      // Add individual location markers
      for (const point of data.locationPoints) {
        const { longitude: lng, latitude: lat } = point.geometry.coordinates;
        const { merchantId, mapPinUrl } = point.properties;

        const iconHtml = mapPinUrl
          ? `<div style="width:32px;height:32px;border-radius:6px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.3);background-image:url('${escapeHtml(getImageProxyUrl(mapPinUrl, 64))}');background-size:cover;background-position:center;background-repeat:no-repeat;"></div>`
          : `<div style="width:32px;height:32px;border-radius:6px;background:#2563eb;border:2px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3)"></div>`;

        const el = document.createElement('div');
        el.innerHTML = iconHtml;

        const resolved = merchantsById.current.get(merchantId);
        const merchantName = resolved?.name ?? merchantId;
        const slug = resolved?.slug ?? merchantSlug(merchantId);
        // A11Y-006: focusable + named pin so keyboard/SR users can reach
        // each merchant. Enter/Space fires the same handler as a tap.
        const pinLabel = `${merchantName}. Activate to view and buy a gift card.`;

        // Escape before interpolation: Popup#setHTML sets innerHTML.
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

        const popup = new maplibregl.Popup({
          maxWidth: '300px',
          className: 'merchant-popup',
          closeButton: true,
        });

        // Intercept "Buy Gift Card" link clicks so they stay within the
        // SPA. Popup#setHTML injects raw HTML, so the <a href> would
        // otherwise trigger a full page reload — losing the map viewport,
        // re-downloading the JS bundle, and re-fetching clusters on
        // return. Attached once per popup at construction; fires every
        // time this popup transitions to open.
        popup.on('open', () => {
          const container = popup.getElement();
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

        popup.on('close', () => {
          // Only clear if this popup is still the tracked one
          if (
            openPopupRef.current?.merchantId === merchantId &&
            openPopupRef.current?.lat === lat
          ) {
            openPopupRef.current = null;
          }
          if (activePopupRef.current === popup) {
            activePopupRef.current = null;
          }
        });

        const activate = (): void => {
          onMerchantSelectRef.current?.(merchantId);

          if (isMobileRef.current) {
            // Pan the map so the tapped pin lands in the top third of the
            // visible viewport, leaving the bottom two thirds free for the
            // sheet that's about to slide up. Shift the pin's projected
            // screen point downward by 1/6 of the map height so the map
            // centre moves below the pin and the pin renders higher.
            const containerHeight = map.getContainer().clientHeight;
            const pinPoint = map.project([lng, lat]);
            pinPoint.y += containerHeight / 6;
            map.panTo(map.unproject(pinPoint), { animate: true });
            return;
          }

          // Desktop only — mobile never opens a popup (the drawer is the
          // single affordance there). Only one popup open at a time,
          // matching Leaflet's map-singleton popup behavior.
          if (activePopupRef.current !== null && activePopupRef.current !== popup) {
            activePopupRef.current.remove();
          }
          popup.setLngLat([lng, lat]).setHTML(popupContent);
          popup.addTo(map);
          activePopupRef.current = popup;
          openPopupRef.current = { merchantId, lat, lng };
        };
        makeKeyboardActivatable(el, pinLabel, activate);

        // Re-open popup if this marker matches the previously open one
        // (desktop only — mobile never opens a popup).
        if (
          !isMobileRef.current &&
          openPopupRef.current !== null &&
          openPopupRef.current.merchantId === merchantId &&
          Math.abs(openPopupRef.current.lat - lat) < 0.0001 &&
          Math.abs(openPopupRef.current.lng - lng) < 0.0001
        ) {
          popup.setLngLat([lng, lat]).setHTML(popupContent);
          popup.addTo(map);
          activePopupRef.current = popup;
        }

        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map);
        // `activate` itself branches on `isMobileRef.current` (pan vs.
        // popup), so this listener is unconditional — same shape as the
        // original Leaflet `marker.on('click', ...)` handler, which also
        // always ran regardless of platform.
        marker.on('click', activate);
        markersRef.current.push(marker);
      }
    },
    [],
  );

  const handleLocate = useCallback(() => {
    const map = mapRef.current;
    const maplibregl = maplibreRef.current;
    if (map === null || maplibregl === null) return;
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setLocateError('Geolocation is not available on this device.');
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        // Remove the previous marker before creating a new one —
        // otherwise repeat-locate drops a pile of blue dots on the
        // same spot as accuracy drifts slightly.
        if (userMarkerRef.current !== null) {
          userMarkerRef.current.remove();
          userMarkerRef.current = null;
        }
        // Custom blue-dot element — matches the iOS/Google "you are
        // here" style (solid blue disc with white ring + soft halo).
        // Pure CSS (`.loop-user-location*` in app.css) so we don't need
        // to ship a second image asset.
        const el = document.createElement('div');
        el.className = 'loop-user-location';
        el.innerHTML = `
          <div class="loop-user-location__halo"></div>
          <div class="loop-user-location__dot"></div>
        `;
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([longitude, latitude])
          .addTo(map);
        // Sit the user marker under any merchant popups/pins — the blue
        // dot is orientation, not content the user is trying to click
        // through to. `.loop-user-location` already carries
        // `pointer-events: none` (app.css), matching Leaflet's
        // `interactive: false`.
        marker.getElement().style.zIndex = '0';
        userMarkerRef.current = marker;
        // Keep their existing zoom if they've already zoomed in;
        // otherwise jump to a city-level zoom so the dot and any
        // nearby merchant clusters both read on screen. MapLibre's
        // flyTo duration is milliseconds (Leaflet's was seconds).
        const targetZoom = Math.max(map.getZoom(), 13);
        map.flyTo({ center: [longitude, latitude], zoom: targetZoom, duration: 700 });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocateError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'Couldn’t determine your location.'
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
      const [maplibreModule] = await Promise.all([
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl.css'),
      ]);
      // Cast needed: `maplibreModule.default`'s inferred type doesn't
      // structurally match `MapLibreGl` (see that interface's doc comment)
      // even though it's the runtime-correct value — Vite's build already
      // confirms this resolves correctly (`new maplibreModule.default.Map(...)`
      // works in the built bundle); this narrows the type `tsc` sees to
      // just the 4 constructors we call.
      const maplibregl = maplibreModule.default as unknown as MapLibreGl;
      // Stash the MapLibre module for the locate button's callback —
      // it runs outside the init effect and needs `maplibregl.Marker`
      // to plot the user's position.
      maplibreRef.current = maplibregl;

      if (!mounted || mapContainerRef.current === null) return;

      const isDark = prefersDark();

      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: {
          version: 8,
          sources: {
            [CARTO_SOURCE_ID]: {
              type: 'raster',
              tiles: cartoTileUrls(isDark),
              tileSize: 256,
              maxzoom: 20,
            },
          },
          layers: [
            {
              id: CARTO_LAYER_ID,
              type: 'raster',
              source: CARTO_SOURCE_ID,
            },
          ],
        },
        center: [initialViewRef.current.lng, initialViewRef.current.lat],
        zoom: initialViewRef.current.zoom,
        // Match Leaflet's effective max zoom (the tile layer's maxZoom of
        // 20, which Leaflet also used as the map's own zoom ceiling since
        // no separate map-level maxZoom was set).
        maxZoom: 20,
        // Default MapLibre attribution control takes a visible strip
        // along the bottom. Suppress it here; the license-required
        // credits are still surfaced via the "ⓘ" button rendered below
        // the map container, which opens a popover with the same links.
        attributionControl: false,
      });

      // A11Y-006: restore the +/- zoom control. Gestures (pinch /
      // double-tap) are the primary affordance on mobile, but the buttons
      // are the only keyboard-operable zoom for users who can't pinch —
      // without them keyboard users have no zoom at all. (Native <button>
      // elements, so they're focusable and Enter/Space-activatable for
      // free.) Compass/rotate hidden — this map never rotates or tilts.
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false, showZoom: true }),
        'top-left',
      );

      // Watch for theme changes and swap tile source URLs in place.
      themeObserver = new MutationObserver(() => {
        const source = map.getSource<RasterTileSource>(CARTO_SOURCE_ID);
        if (source === undefined) return;
        source.setTiles(cartoTileUrls(prefersDark()));
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });

      mapRef.current = map;

      const refresh = (): void => {
        if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          void updateMarkers(map, maplibregl);
        }, DEBOUNCE_MS);
      };

      map.on('moveend', refresh);
      map.on('zoomend', refresh);

      // Initial load
      void updateMarkers(map, maplibregl);
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
