# Third-party licences + attribution

Loop ships with several third-party open-source dependencies. Most
are MIT / Apache-2.0 / ISC and carry no attribution requirement
beyond preserving the upstream copyright notice, which `npm install`
does automatically via `node_modules/<pkg>/LICENSE`. A handful
require explicit attribution and are documented below.

Closes A2-305, A2-306, A2-309.

## Public-facing obligations

Before the public launch at `loopfinance.io/licenses`, ship a page
listing every entry in this section. For now, the repo copy is the
source of truth — legal + marketing reference this doc when building
the public page so the two stay aligned.

### libvips (via `sharp` image processing) — LGPL-3.0-or-later

**Package:** `@img/sharp-libvips-*` prebuilt binaries (`^1.2.4` at
time of writing), transitive dependency of `sharp`.

**Used for:** The image-proxy endpoint (`/api/image`) pipes merchant
logos + marketing imagery through `sharp.resize(...)` / `webp(...)` /
`jpeg(...)`. libvips is the native C library doing the actual pixel
work.

**Licence:** LGPL-3.0-or-later. Also bundles several transitive
libraries under BSD, MIT, Mozilla Public 2.0, and freetype's
BSD-like. The sharp team ships the full per-library table on the
prebuilt package's README (`node_modules/@img/sharp-libvips-<platform>/README.md`).

**Attribution requirement:** LGPL §6 requires notice of the library's
use. We satisfy this by:

1. Listing libvips in this document.
2. Surfacing the same listing on the public site at launch.
3. Linking to the upstream source (`https://www.libvips.org/`) and
   the sharp package's own licensing page (`https://sharp.pixelplumbing.com/`).

**Note on dynamic linking:** sharp uses libvips via dlopen against a
prebuilt shared object — a valid way to preserve LGPL section 4's
"runtime relinking" clause. We do not statically link libvips, so no
object-file distribution is required.

### MapLibre GL JS — BSD-3-Clause

**Package:** `maplibre-gl` (top-level `apps/web/package.json`
dependency, ADR 046).

**Used for:** the `/map` store-locator's rendering engine
(`apps/web/app/components/features/ClusterMap.tsx`), replacing Leaflet
as of ADR 046 (2026-07-10). All markers/popups/pins are custom DOM
elements we build ourselves (no library-provided marker images), so
unlike the Leaflet entry it replaces, there are no bundled image assets
to list here — just the library itself.

**Upstream:** `https://github.com/maplibre/maplibre-gl-js`.
BSD-3-Clause licence — the community-maintained, license-unencumbered
fork of Mapbox GL JS v1.x. No attribution beyond the standard
`npm install`-preserved `LICENSE` file is required (BSD-3 has no
"advertising clause"), but listed here per this doc's practice of
naming every shipped runtime dependency, not just the ones with an
explicit attribution obligation.

**Note on map-tile attribution (unchanged by this swap):** MapLibre
renders the same third-party CARTO/OpenStreetMap raster tiles Leaflet
did (ADR 005 §10) — the runtime tile-fetch dependency and its required
OpenStreetMap + CARTO copyright credit (surfaced via the map's "ⓘ" info
button, not this document) are unrelated to which JS rendering library
draws them and haven't changed.

**Retired by this swap:** Leaflet's default marker images
(`apps/web/public/leaflet/marker-icon.png`, `marker-icon-2x.png`,
`marker-shadow.png`, BSD-2-Clause, copied from the `leaflet` npm
package's `dist/images/` directory) are deleted — every marker in
`ClusterMap.tsx` already used a custom icon, so these were unused dead
weight even before the swap. No successor asset needed; MapLibre's
custom-element `Marker` API takes a DOM element per marker directly,
with no "default icon" concept to work around.

### flag-icons country flags — MIT (flags are public domain)

**Files:** `apps/web/public/flags/*.svg` (23 flat 4:3 country flags — the
`/:country/:lang` selector, ADR 034).

**Origin:** copied verbatim from the `flag-icons` collection
(`flags/4x3/`), replacing the platform emoji flags (which render as wavy
cloth flags and vary per OS).

**Upstream:** `https://github.com/lipis/flag-icons`. The collection is
MIT-licensed; the flag artwork itself is in the public domain.

**Why we ship copies instead of the npm package:** same reason as the
Leaflet markers — the Capacitor static-export build needs assets at a
stable public path, and we only ship the ~23 flags we route, not the
full set. No new runtime dependency.

**Attribution** (MIT — preserve the notice):

> The MIT License (MIT)
> Copyright (c) 2013 Panayiotis Lipiridis

### @capgo/inappbrowser — MPL-2.0

**Package:** `@capgo/inappbrowser@8.6.1` (top-level runtime
dependency in both `apps/web/package.json` and
`apps/mobile/package.json`).

**Used for:** the Capacitor in-app-browser plugin used by the
purchase-redeem flow to host merchant redeem URLs in a webview
that can be scripted with the challenge bar.

**Licence:** Mozilla Public Licence 2.0 (MPL-2.0).

**Attribution requirement:** MPL §3 requires source-code
availability for any modifications and preservation of upstream
source notices. Loop ships an unmodified vendored package — the
`LICENSE` file inside `node_modules/@capgo/inappbrowser/` is
preserved on install. The plugin's source remains available
upstream at the package's homepage; no Loop-side modifications
are distributed. Listed here to satisfy the "explicit attribution"
arm of MPL §3.2(a).

### @anthropic-ai/claude-code — Anthropic commercial licence

**Package:** `@anthropic-ai/claude-code` (root `devDependencies`).

**Used for:** the AI PR-review GitHub Actions workflow
(`.github/workflows/pr-review.yml`); not shipped to end users.

**Licence:** non-standard commercial licence — see
`node_modules/@anthropic-ai/claude-code/LICENSE` for the canonical
text. Listed here so the public attribution page is honest about
the build-side AI tooling alongside Anthropic's own terms.

### postgres (driver) — Unlicense

**Package:** `postgres@3.4.9` (aka `postgres-js`).

**Used for:** Drizzle ORM's underlying Postgres driver for the
credits ledger + admin panel (ADR 012).

**Licence:** The Unlicense — a public-domain dedication with no
attribution requirement under copyright law.

**Why we still list it:** The public attribution page is how Loop
demonstrates the integrity of its dependency tree. A package
dedicated to the public domain is a notable data-point (no copyright
chain to inherit), and listing it is how legal's due-diligence
surface stays complete rather than relying on a reader noticing the
absence. A2-309 specifically asked for this.

## Licences without further attribution requirement

Every MIT / Apache-2.0 / ISC / BSD-3 package in the dependency tree
preserves its upstream `LICENSE` file inside `node_modules/<pkg>/` at
install time. Redistribution doesn't happen (the backend runs on our
infra; the web bundle ships only the compiled application code, not
unchanged source files), so no further action is required.

If a future package with a reciprocal licence (GPL-2.0, AGPL-3.0,
EUPL) lands, add it to the section above and update the public page.
`scripts/lint-docs.sh` doesn't currently lint dependency licences —
`audit-2026-tracker.md` flags this as a follow-on (A2-408 SBOM /
provenance bundle).
