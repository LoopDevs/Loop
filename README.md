# Loop

Cross-platform app for buying discounted gift cards with XLM, USDC, or LOOP-asset cashback (USDLOOP / GBPLOOP / EURLOOP). Off-chain credits ledger + Stellar-side LOOP-asset payout for users who link a wallet. Single brand only (Loop, no white-label).

**Phase 1 shipped:** XLM / USDC purchase rails, off-chain cashback ledger (ADR 009), per-merchant cashback split (ADR 011), Stellar wallet linking, LOOP-asset outbound payout worker (ADR 016) gated behind `LOOP_WORKERS_ENABLED` + per-currency issuer envs.
**Phase 2 in progress:** principal-switch payment rails (ADR 010), Loop-native auth (ADR 013, gated by `LOOP_AUTH_NATIVE_ENABLED`), social login (ADR 014), admin step-up auth (ADR 028, designed-not-implemented), tax/regulatory CSV emitter (ADR 026, designed-not-implemented), user-initiated cash-out flow (ADR 024 Phase 2b).

## Quick start

```bash
npm install
cp apps/backend/.env.example apps/backend/.env   # fill in real values
cp apps/web/.env.local.example apps/web/.env.local
npm run dev                                        # web on :5173, backend on :8080
```

Requires Node.js >= 22.

## Architecture

```
apps/web        React Router v7 + Vite — SSR for loopfinance.io, static export for mobile
apps/backend    TypeScript + Hono — merchant cache, clustering, image proxy, auth proxy, order proxy
apps/mobile     Capacitor v8 shell — loads static web build from disk
packages/shared Shared TypeScript types, slug + search utilities, protobuf definitions
```

## Documentation

| Doc                                                                                                                                              | Contents                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [`AGENTS.md`](AGENTS.md)                                                                                                                         | AI agent instructions, architecture rules, file boundaries                           |
| [`docs/architecture.md`](docs/architecture.md)                                                                                                   | System design, data flows, API endpoints                                             |
| [`docs/development.md`](docs/development.md)                                                                                                     | Getting started, env vars, all dev commands                                          |
| [`docs/deployment.md`](docs/deployment.md)                                                                                                       | Deploy backend, web, and mobile                                                      |
| [`docs/testing.md`](docs/testing.md)                                                                                                             | Testing pyramid, coverage requirements                                               |
| [`docs/standards.md`](docs/standards.md)                                                                                                         | Code style, commit format, branching, review rules                                   |
| [`docs/roadmap.md`](docs/roadmap.md)                                                                                                             | What's left for Phase 1, Phase 2, Phase 3                                            |
| [`docs/audit-2026-05-03-claude/`](docs/audit-2026-05-03-claude/)                                                                                 | **Active audit.** Claude register: 124 findings (1 Critical, 23 High, …). 2026-05-03 |
| [`docs/audit-2026-05-03/`](docs/audit-2026-05-03/)                                                                                               | **Active audit.** Codex parallel register: 42 findings. 2026-05-03                   |
| [`docs/adr/`](docs/adr/)                                                                                                                         | Architecture Decision Records                                                        |
| [`docs/audit-2026-tracker.md`](docs/audit-2026-tracker.md)                                                                                       | Pre-2026-05-03 adversarial audit (467 findings). Historical.                         |
| [`docs/codebase-audit.md`](docs/codebase-audit.md), [`audit-checklist.md`](docs/audit-checklist.md), [`audit-tracker.md`](docs/audit-tracker.md) | Pre-2026 audit triplet. **Superseded** by the 2026-05-03 audits above.               |

## Commands

```bash
npm run dev              # web + backend concurrently
npm run typecheck        # tsc across all packages
npm run lint             # ESLint across all packages
npm test                 # unit tests (vitest)
npm run test:e2e         # Playwright e2e — self-contained mocked suite (default)
npm run test:e2e:real    # Playwright e2e — against a running real-CTX backend
npm run build            # production build
npm run verify           # typecheck + lint + format + docs + test (one command)
```

## License

Proprietary. All rights reserved.
