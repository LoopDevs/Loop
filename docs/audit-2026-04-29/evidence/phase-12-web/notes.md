# Phase 12 — Web Runtime

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `James`
- Phase status: in-progress

## Evidence

- Query-site sweep: [artifacts/query-sites.txt](./artifacts/query-sites.txt)
- Query-site counts: [artifacts/query-site-counts.txt](./artifacts/query-site-counts.txt)
- `fetch(` sweep: [artifacts/fetch-sites.txt](./artifacts/fetch-sites.txt)

## Findings logged

- `A3-004` Medium — query-layer boundary drift is systemic in `apps/web`: route and component code now contains 231 `useQuery` / `useMutation` / `useInfiniteQuery` sites versus 16 in hooks, despite the package guide framing hooks as the data-fetching layer.
- `A3-005` Low — `apps/web/app/native/share.ts` performs raw `fetch()` calls outside `services/`, expanding network behavior outside the normal API-client review surface.

## Clean bill so far

- Loader/server-fetch discipline appears to hold; only the documented `sitemap.tsx` exception and an SSR-only 404 loader were found.
- Forbidden Capacitor/plugin imports outside `app/native` appear to hold on the tracked web surface.
