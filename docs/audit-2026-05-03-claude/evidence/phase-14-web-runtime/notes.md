# Phase 14 - Web Runtime and UX State

Status: complete
Owner: lead (Claude)

## Files reviewed (verified subset of subagent input)

- apps/web/app/routes/\* (35 routes)
- apps/web/app/services/\* (~40 services)
- apps/web/app/hooks/\* (8 hooks)
- apps/web/app/stores/{auth,purchase,ui}.store.ts
- apps/web/app/components/features/\* (admin + cluster map + redeem flow + purchase + cashback)
- apps/web/app/utils/{security-headers,sentry-error-scrubber,query-error-reporting,redeem-challenge-bar,share-image,money,locale,image,error-messages}.ts
- apps/web/app/entry.server.tsx, root.tsx, routes.ts

## Findings filed

- A4-052 High — credit adjustment form no confirmation
- A4-053 High — withdrawal form no confirmation
- A4-054 Low — entry.server.tsx timeout never cleared
- A4-058 Medium — admin user drill loads userId into query keys forwarded to Sentry
- A4-060 Low — api-client doRefresh discards upstream rejection reason
- A4-070 Low — auth.store no cross-tab logout coordination
- A4-071 Low — redeem-challenge-bar uses deprecated execCommand with silent fallback

## No-finding-but-reviewed

- TanStack Query is the canonical data fetcher; only `routes/sitemap.tsx` does loader-side fetch.
- ESLint no-restricted-imports blocks `@capacitor/*` outside `app/native/`.
- Lazy import for native plugins.

## Cross-references

- A4-051 (Sentry scrubber bypass) sits in Phase 17.
