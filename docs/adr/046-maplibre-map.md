# ADR 046: MapLibre GL JS replaces Leaflet for the store-locator map

Status: Accepted — raster-source migration implemented
Date: 2026-07-10
Related: ADR 005 §10 (third-party runtime dependencies — CARTO/OSM tiles)
Resolves: roadmap.md "Swap Leaflet for MapLibre GL JS" / readiness-backlog
§P3 "MapLibre GL swap (from Leaflet)" / go-live-plan §P3 "MapLibre GL JS
swap for Leaflet"

## Context

`apps/web/app/components/features/ClusterMap.tsx` renders the `/map`
store-locator using Leaflet 1.9.4: DOM `L.divIcon` markers (cluster
bubbles + merchant pins + a "you are here" halo), `L.popup` for the
merchant detail card, and a raster `L.tileLayer` against CARTO's free
`basemaps.cartocdn.com` tiles (`voyager` in light mode, `dark_all` in
dark mode — OpenStreetMap-sourced, CARTO-styled). Marker/cluster data
comes from the backend's `/api/clusters` endpoint, which does
server-side spatial clustering over the full merchant-location catalog
and returns a protobuf `ClusterResponse` of `clusterPoints` (aggregated
bubbles with a count) and `locationPoints` (individual pins) for the
current viewport. ADR 005 §10 flagged MapLibre GL JS as the likely
Phase-3 direction when this dependency was first accepted.

Leaflet renders every marker and tile as real DOM nodes (`<img>` tiles,
`<div>` icons) painted and repositioned by the CPU on every pan/zoom.
That's adequate at Loop's current marker density (a few hundred pins,
pre-clustered server-side so the client never renders more than a
viewport's worth) but is the wrong architecture to grow into — more
markers, smoother pan/zoom, and any future move to vector tiles all
want a GL renderer.

## Decision

Replace Leaflet with **MapLibre GL JS** (`maplibre-gl`, BSD-3-Clause,
the community-maintained, license-unencumbered fork of Mapbox GL JS
v1.x), using the **existing CARTO raster tiles as a `raster` source**.
This is a rendering-library swap only — the server-side clustering
contract (`/api/clusters`, protobuf, viewport-bounds request params)
does not change, and neither does the visual design of markers/popups.

### Why raster-source-first, not vector tiles now

MapLibre GL JS can consume tiles two ways:

1. **Raster source against the existing CARTO tile URLs** — a `raster`
   source pointed at the same `basemaps.cartocdn.com` endpoints Leaflet
   already uses. Zero new infrastructure, zero new third-party
   dependency beyond the rendering library itself, ships in this PR.
   MapLibre still gets the WebGL-canvas win (smooth GPU-composited
   pan/zoom, non-blocking marker updates) even though the _tiles_
   themselves are still server-rendered raster PNGs.
2. **Self-hosted vector tiles** — e.g. Protomaps PMTiles (a single
   static `.pmtiles` file served over HTTP range requests, no tile
   server or per-request cost) or a paid vector provider (MapTiler,
   Stadia Maps). This is what actually retires the third-party CARTO/
   OSM origin ADR 005 §10 accepted as a runtime dependency, and is
   the more complete realization of "self-hosted vector tiles" that
   §10's revisit note gestured at.

Vector tiles are the better long-term answer (self-hosted, no
third-party runtime origin, smaller payload per tile, client-side
styling flexibility), but they need an operator decision this PR
shouldn't make unilaterally:

- **Protomaps PMTiles** is compelling (single self-hosted file, no
  recurring per-tile cost, MIT-licensed pipeline) but needs someone to
  generate/host the `.pmtiles` extract (planet or regional), pick a
  storage/CDN target, and own the rebuild cadence as OSM data ages.
- **MapTiler / Stadia Maps** are turnkey (hosted vector tiles, drop-in
  MapLibre style JSON) but add a paid third-party dependency with its
  own attribution/ToS/pricing-tier tradeoffs — exactly the kind of
  vendor commitment `docs/adr/` decisions are supposed to gate.

Neither choice is obviously correct without operator input on hosting
budget and ops appetite, and getting it wrong (e.g. standing up a
PMTiles pipeline that then needs re-doing under MapTiler, or vice
versa) costs more than shipping the WebGL swap now and revisiting tile
sourcing separately.

**Recommendation: ship the raster-source MapLibre swap now (this PR);
defer the vector/self-host tile-sourcing decision to a 👤 operator
follow-up** (tracked as a roadmap/backlog item, not blocking this PR).
The raster-source swap is strictly additive value (WebGL renderer,
better mobile marker/pan perf, same tiles, same CSP allowlist, same
CARTO free-tier usage) and doesn't foreclose the vector-tile move
later — swapping a MapLibre `raster` source for a `vector` source is a
contained change to the map-init code, not another library migration.

### What changes

- `maplibre-gl` replaces `leaflet` + `@types/leaflet` as the map
  rendering dependency (`apps/web/package.json`). Still lazy-loaded via
  dynamic `import()` at the `ClusterMap` component boundary (unchanged
  pattern from Leaflet) so it lands in its own async chunk, not the
  main SSR bundle.
- `apps/web/public/leaflet/marker-*.png` (Leaflet's default marker
  images) are deleted. They were dead weight even before this
  migration — every marker in `ClusterMap.tsx` already used a custom
  `L.divIcon`, so Leaflet's default-icon images were never actually
  rendered; the `L.Icon.Default.mergeOptions(...)` call that pointed at
  them was defensive boilerplate against a bundler path issue that
  never fired in practice. MapLibre's custom-element `Marker` API has
  no equivalent "default icon" concept to work around.
- Server-side clustering is unchanged: `fetchClusters()` /
  `/api/clusters` / the protobuf `ClusterResponse` shape are untouched.
  MapLibre only renders the same `clusterPoints` / `locationPoints`
  arrays the backend already returns — client-side re-clustering
  (MapLibre's built-in GeoJSON `cluster: true` source option) is
  deliberately **not** used; the backend's clustering is load-bearing
  (it's what keeps the client from ever fetching/rendering the full
  merchant-location catalog) and out of scope for a rendering-library
  swap.
- Markers/popups are rebuilt on MapLibre's `Marker`/`Popup` APIs with
  the same interaction set: cluster-bubble click-to-zoom, merchant-pin
  click (desktop: open a rich HTML popup with image, name, "Buy Gift
  Card" link routed through React Router's `navigate` instead of a
  full page load; mobile: pan the tapped pin into the top third of the
  viewport for the bottom-sheet UI), the "locate me" one-shot
  geolocation marker with a pulsing halo, and dark-mode tile swapping
  via the same `document.documentElement` class `MutationObserver`
  (now calling `RasterTileSource#setTiles()` instead of Leaflet's
  `tileLayer.setUrl()`). Keyboard accessibility (A11Y-006: tab-focusable
  markers, Enter/Space activation, `aria-label`) is reimplemented
  explicitly on the marker DOM elements — MapLibre's `Marker` has no
  built-in `keyboard: true` option the way Leaflet did, so the
  tabindex/role/keydown wiring that used to be one constructor option
  is now manual per-marker code.
- **Dropped, not carried forward:** the dark-mode CSS filter on
  `.leaflet-pane.leaflet-tile-pane` (`sepia(50%) hue-rotate(180deg)
saturate(300%) contrast(1.1) brightness(2)`). Git history shows this
  filter shipped in the initial monorepo commit — before Loop had a
  real dark tile source — as a hack to fake a dark basemap by
  color-filtering the _light_ tiles. A later commit
  (`88b5508f`, "fix(web): map dark tiles") added the real CARTO
  `dark_all` tile URL swap but never removed the old filter, so both
  have been stacked for months: a proper dark basemap tile, then an
  extra sepia/hue-rotate/saturate/brightness pass on top of it.
  MapLibre's raster tiles paint onto a shared WebGL canvas (no
  per-tile `<img>` DOM nodes to target with a scoped CSS filter the way
  `.leaflet-tile-pane` could), so this migration is a natural point to
  drop the redundant filter rather than invent a new way to keep
  double-processing an already-correct dark tile. Net visual effect:
  dark mode now shows CARTO's `dark_all` tiles as designed, unfiltered.
  Flagged here explicitly since it's a behavior change riding along
  with an otherwise mechanical library swap.
- Attribution: MapLibre GL JS is BSD-3-Clause (see
  `docs/third-party-licenses.md` for the license entry replacing the
  retired Leaflet marker-image entry). The **tile attribution
  requirement is unchanged** — OpenStreetMap + CARTO still own the map
  data/styling and are still credited via the same custom "ⓘ" info
  button popover (not MapLibre's own default attribution control,
  which stays disabled via `attributionControl: false`, matching the
  prior Leaflet configuration).
- CSP (`apps/web/app/utils/security-headers.ts`): unchanged. The
  `img-src` allowlist for `*.basemaps.cartocdn.com` /
  `*.tile.openstreetmap.org` stays exactly as-is — MapLibre requests
  tiles from the same origins Leaflet did; only the client-side
  requester changed.

## Consequences

- **Bundle size**: `maplibre-gl` (~1 MB minified, vs. Leaflet's
  ~150 KB) is materially larger. It's lazy-loaded into its own async
  chunk (unchanged pattern from Leaflet's lazy import), so it never
  touches the SSR-critical main bundle (`MAX_SSR_KB` in
  `scripts/check-bundle-budget.sh`) — only users who actually open
  `/map` pay the download cost, and only once per browser cache
  lifetime. The per-chunk ceiling (`MAX_CHUNK_KB`, currently 800) needs
  raising to fit the maplibre-gl chunk; see the budget-script comment
  for the specific number and justification.
- **Runtime dependency surface**: unchanged — still CARTO/OSM raster
  tiles over HTTP, still covered by ADR 005 §10's accepted-risk
  reasoning (free-tier traffic volume, CSP-allowlisted origins, no
  Loop-identifying data in the request).
- **Follow-up (👤 operator-gated, not this PR)**: decide between
  Protomaps PMTiles self-hosting vs. a paid vector-tile provider
  (MapTiler/Stadia) to retire the third-party CARTO/OSM origin
  entirely per ADR 005 §10's original revisit note. Until that
  decision lands, the map keeps depending on CARTO's free raster
  basemap.
- **A11y**: keyboard marker activation is now hand-rolled (tabindex +
  role + keydown) instead of a single Leaflet constructor flag. Covered
  by the same manual QA pass that verified the original Leaflet
  A11Y-006 fix; no automated a11y test regression expected since
  `jest-axe` (ADR 042) doesn't exercise the lazy-loaded map component.

## Alternatives considered

- **Stay on Leaflet.** Rejected — ADR 005 §10 already flagged MapLibre
  as the intended direction, and Leaflet's DOM-based rendering is the
  wrong foundation to keep building marker density and interaction
  work on top of.
- **Vector tiles in this same PR.** Rejected for now — see "Why
  raster-source-first" above. Bundling a tile-hosting vendor/pipeline
  decision into a rendering-library swap risks picking the wrong
  hosting approach under time pressure and re-doing it later; splitting
  the two lets the (mechanical, low-risk) library swap ship immediately
  and the (vendor/hosting, needs operator input) tile-sourcing decision
  get proper consideration on its own.
- **MapLibre's client-side GeoJSON clustering** (`cluster: true` on a
  GeoJSON source) instead of consuming the backend's pre-clustered
  `/api/clusters` response. Rejected — the backend clustering is what
  keeps the client from ever downloading the full merchant-location
  catalog; replacing it with client-side clustering would mean shipping
  every location to every client on every viewport change, a strictly
  worse data-transfer and privacy posture for zero rendering benefit.
