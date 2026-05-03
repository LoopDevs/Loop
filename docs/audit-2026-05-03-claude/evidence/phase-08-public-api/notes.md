# Phase 08 - Public API and Public Surfaces

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/public/\* (cashback-stats, cashback-preview, flywheel-stats, loop-assets, merchant, top-cashback-merchants)
- apps/backend/src/routes/public.ts
- apps/backend/src/images/{proxy,ssrf-guard}.ts
- apps/backend/src/middleware/cache-control.ts
- apps/web/app/routes/sitemap.tsx (the only documented loader-side fetch)

## Findings filed

- A4-004 Medium — image proxy bare fetch + SSRF TOCTOU; mitigated by env-validated allowlist

## No-finding-but-reviewed

- Every public handler honors never-500 with last-known-good fallback.
- `/api/public/*` rate-limited at 60/min (note A4-001 still applies).
- ADR-020 reference for `/api/public/stats` does not match code (see A4-061).

## Cross-references

- Phase 17 covers the SSRF discussion fully.
