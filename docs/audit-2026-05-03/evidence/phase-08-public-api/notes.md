# Phase 08 - Public API and Public Surfaces

Status: in-progress

Required evidence:

- public route inventory
- cache-control and never-500 review
- public PII/business leakage review
- public web route and asset review
- image proxy review

Findings:

- A4-014: `/api/image` returns a 500 catch-all path that is absent from the OpenAPI registration.

Evidence captured:

- `artifacts/backend-public-files.txt`
- `artifacts/public-contract-lines.txt`
- `artifacts/image-openapi-status-drift.txt`

First-pass observations:

- `/api/public/cashback-stats`, `/api/public/top-cashback-merchants`, `/api/public/merchants/:id`, `/api/public/cashback-preview`, `/api/public/loop-assets`, and `/api/public/flywheel-stats` were reviewed against handler code and tests.
- The ADR-020 surfaces generally implement the intended unauthenticated/no-PII/fallback behavior: DB/config failures return 200 with stale or safe-empty payloads and short public cache headers.
- `400` and `404` paths on public merchant/preview endpoints intentionally remain validation/not-found responses rather than fallback 200s; no finding filed because the ADR allows stable client errors and the handlers avoid 5xx.
- The sitemap loader was reviewed as the documented SSR exception; it fails open to static routes and escapes XML.
- The image proxy SSRF guard, allowlist enforcement, redirect rejection, size cap, private mode cache bypass, and tests were reviewed. One contract drift finding was filed because the handler's 500 path is not in OpenAPI.
