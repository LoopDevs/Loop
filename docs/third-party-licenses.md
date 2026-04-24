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

### Leaflet default marker images — BSD-2-Clause

**Files:** `apps/web/public/leaflet/marker-icon.png`,
`marker-icon-2x.png`, `marker-shadow.png`.

**Origin:** copied verbatim from the `leaflet` npm package's
`dist/images/` directory.

**Upstream:** `https://github.com/Leaflet/Leaflet`. BSD-2-Clause
licence; copyright belongs to the Leaflet contributors.

**Why we ship copies instead of importing from `node_modules`:** the
Capacitor static-export build strips `node_modules` assets at bundle
time, and Leaflet expects its defaults at a path it controls on the
page root (`L.Icon.Default.imagePath`). Copying into `public/leaflet/`
gives the mobile bundle a stable URL.

**Attribution** (required by BSD-2 §2 "advertising clause" modern
equivalent): the Leaflet copyright notice is preserved in this
document and on the public licences page. The original
`LICENSE` text from the Leaflet repository reads:

> Copyright (c) 2010-2024, Volodymyr Agafonkin
> Copyright (c) 2010-2011, CloudMade
> All rights reserved.

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
