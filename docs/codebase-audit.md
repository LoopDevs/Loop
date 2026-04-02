# Codebase Audit Plan

Comprehensive audit of every file, pattern, and system in the Loop monorepo.

## Audit phases

### Phase 1: File inventory

- Count every source file across all packages
- Identify any orphaned/unused files
- Check file naming conventions (kebab-case)

### Phase 2: Backend audit

- [ ] `src/app.ts` — middleware order, route registration, health endpoint
- [ ] `src/index.ts` — startup sequence, timing
- [ ] `src/env.ts` — all env vars validated, defaults sensible
- [ ] `src/upstream.ts` — URL builder correctness
- [ ] `src/circuit-breaker.ts` — state machine, edge cases
- [ ] `src/logger.ts` — configuration
- [ ] `src/auth/handler.ts` — validation, proxy logic, error handling, clientId
- [ ] `src/orders/handler.ts` — Zod schemas match CTX, mapping correctness, X-Client-Id
- [ ] `src/merchants/sync.ts` — pagination, field mapping, savingsPercentage conversion
- [ ] `src/merchants/handler.ts` — search, pagination, cache headers
- [ ] `src/clustering/algorithm.ts` — grid sizes, edge cases
- [ ] `src/clustering/data-store.ts` — cross-reference, pagination, startup order
- [ ] `src/clustering/handler.ts` — protobuf, JSON fallback, content negotiation
- [ ] `src/images/proxy.ts` — SSRF, caching, resize, allowlist

### Phase 3: Shared package audit

- [ ] `src/index.ts` — barrel exports complete
- [ ] `src/api.ts` — error types, auth types
- [ ] `src/merchants.ts` — Merchant type matches CTX reality
- [ ] `src/orders.ts` — Order type matches CTX reality
- [ ] `src/slugs.ts` — slug generation correctness
- [ ] `src/proto/` — generated types, import paths

### Phase 4: Web app audit

- [ ] Routes: home, auth, gift-card, map, orders, not-found
- [ ] Components: Navbar, Footer, MerchantCard, ClusterMap, MapBottomSheet, NativeBackButton, NativeTabBar
- [ ] Purchase flow: PurchaseContainer, AmountSelection, PaymentStep, PurchaseComplete, RedeemFlow
- [ ] UI primitives: Button, Input, Spinner, Skeleton, LazyImage, OfflineBanner, ToastContainer
- [ ] Hooks: use-auth, use-merchants, use-native-platform, use-session-restore, slug
- [ ] Services: api-client, auth, merchants, orders, clusters, config
- [ ] Stores: auth.store, purchase.store, ui.store
- [ ] Native modules: all 13 files in native/
- [ ] Utils: image.ts, error-messages.ts
- [ ] CSS: app.css — all custom classes, dark mode, animations, safe areas

### Phase 5: Configuration & infrastructure audit

- [ ] Root package.json — scripts, workspaces, engines
- [ ] Per-package package.json — dependencies, scripts
- [ ] TypeScript configs — strict mode, paths, base config
- [ ] ESLint config — rules, ignores, import boundaries
- [ ] Prettier config
- [ ] Husky hooks — pre-commit, pre-push, commit-msg
- [ ] CI workflow — jobs, caching, secrets, e2e
- [ ] Capacitor config — plugins, settings
- [ ] Vite config — plugins, optimizeDeps
- [ ] Vitest configs — coverage, environment

### Phase 6: Documentation audit

- [ ] AGENTS.md (root) — current and accurate
- [ ] Per-package AGENTS.md files — current and accurate
- [ ] docs/architecture.md — matches code reality
- [ ] docs/development.md — commands work, env vars current
- [ ] docs/deployment.md — Dockerfiles, Fly.io, Vercel
- [ ] docs/testing.md — test inventory matches reality
- [ ] docs/standards.md — rules enforced
- [ ] docs/roadmap.md — items correctly marked
- [ ] docs/mobile-native-ux.md — items correctly marked
- [ ] docs/ui-restoration-plan.md — items correctly marked
- [ ] docs/migration.md — historical accuracy

### Phase 7: Test audit

- [ ] Backend test coverage — every handler, every edge case
- [ ] Web test coverage — stores, hooks, services, native modules
- [ ] E2E tests — smoke + purchase flow
- [ ] Test quality — mocks correct, assertions meaningful
- [ ] Missing tests for new code

### Phase 8: Security audit

- [ ] No secrets in source or git history
- [ ] CORS configuration correct
- [ ] SSRF protection complete
- [ ] Auth token handling secure
- [ ] Rate limiting adequate
- [ ] Input validation complete
- [ ] No XSS vectors
- [ ] Secure headers present

### Phase 9: Performance audit

- [ ] Bundle size analysis
- [ ] Lazy loading effectiveness
- [ ] API response times
- [ ] Image proxy efficiency
- [ ] Memory usage patterns
- [ ] N+1 query patterns

### Phase 10: Cross-cutting concerns

- [ ] Error handling consistency
- [ ] Logging completeness
- [ ] TypeScript strictness (no any leaks)
- [ ] Dark mode completeness
- [ ] Accessibility
- [ ] Offline handling
- [ ] Mobile UX

## Findings format

Each finding:

```
[SEVERITY] Category > File:line — Description
  Impact: ...
  Fix: ...
```

Severities: CRITICAL, HIGH, MEDIUM, LOW, NITPICK
