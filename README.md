# Loop

Cross-platform app for buying discounted gift cards with XLM. Cashback-to-Stellar is a Phase 2 feature on the roadmap — not yet shipped.

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

| Doc                                                  | Contents                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)                             | AI agent instructions, architecture rules, file boundaries |
| [`docs/architecture.md`](docs/architecture.md)       | System design, data flows, API endpoints                   |
| [`docs/development.md`](docs/development.md)         | Getting started, env vars, all dev commands                |
| [`docs/deployment.md`](docs/deployment.md)           | Deploy backend, web, and mobile                            |
| [`docs/testing.md`](docs/testing.md)                 | Testing pyramid, coverage requirements                     |
| [`docs/standards.md`](docs/standards.md)             | Code style, commit format, branching, review rules         |
| [`docs/roadmap.md`](docs/roadmap.md)                 | What's left for Phase 1, Phase 2, Phase 3                  |
| [`docs/codebase-audit.md`](docs/codebase-audit.md)   | Audit program, scope, and completion criteria              |
| [`docs/audit-checklist.md`](docs/audit-checklist.md) | Detailed audit checklist by workstream                     |
| [`docs/audit-tracker.md`](docs/audit-tracker.md)     | Working tracker for evidence, findings, and status         |
| [`docs/adr/`](docs/adr/)                             | Architecture Decision Records                              |

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
