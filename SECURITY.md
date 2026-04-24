# Security Policy

Loop is a pre-launch cashback / gift-card app handling payment data,
Stellar-network assets, and user PII. We treat every credible
security report as urgent.

## Supported versions

Loop is continuously deployed; only the tip of `main` is supported.
We do not maintain security patches for older revisions. If you are
running a fork, rebase onto `main` before reporting.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security reports.** Issues
are indexed immediately and would give an attacker a head start.

Report via one of these private channels:

1. **GitHub Security Advisories** — preferred. Open a private
   advisory at
   [`github.com/LoopDevs/Loop/security/advisories/new`](https://github.com/LoopDevs/Loop/security/advisories/new).
   The advisory starts private; we coordinate disclosure + fix
   directly in it.
2. **Email** — `security@loopfinance.io`. Please encrypt sensitive
   details using the PGP key published at
   `https://loopfinance.io/.well-known/security.asc` (available once
   the public site ships). Plain-text reports are still read; we
   just prefer encryption for anything that names a specific bug.

When reporting, please include:

- A short summary of the issue and its impact.
- Steps to reproduce or a proof-of-concept. A minimal curl command
  or Stellar memo value is usually enough.
- The commit SHA (or `main` date) you tested against.
- Any known mitigation.

## What we treat as in-scope

- **Critical** — remote code execution, unauthenticated access to
  another user's ledger or PII, key-material exfiltration, wallet
  draining, ability to mint LOOP stablecoin without backing.
- **High** — privilege escalation, admin-write bypass of the ADR-017
  idempotency / reason / audit contract, CTX-operator pool
  takeover, OTP / JWT signature bypass.
- **Medium** — persistent XSS in authenticated surfaces, information
  disclosure, authn/z downgrade, rate-limit or circuit-breaker
  bypass leading to resource exhaustion.
- **Low** — non-exploitable information disclosure, outdated
  dependencies without a reachable path, content-security-policy
  gaps on unauth routes.

## Out of scope

- Denial-of-service against public unauthenticated endpoints that
  are already rate-limited (see `apps/backend/AGENTS.md` middleware
  stack). We pay attention to a DoS only if it bypasses the limiter
  or amplifies against a downstream.
- Reports based on outdated dependencies without a concrete exploit
  path — we run Dependabot and Snyk; please include a CVE tie-in.
- Automated scanner output with no triage, "missing X header" on a
  route that doesn't need it, or `npm audit` transitive warnings on
  dev-only packages.
- Social-engineering of Loop employees.

## Response targets

- Triage acknowledgement within 2 business days.
- Severity assessment + mitigation plan within 5 business days.
- Fix shipped to production:
  - Critical: 72 hours.
  - High: 7 days.
  - Medium: 30 days.
  - Low: next regular release window.

We keep reporters updated during the fix window and coordinate
public disclosure (GitHub Security Advisory + release notes) after
the patch ships. Credit is offered by default; let us know if you'd
prefer to stay anonymous.

## Safe-harbour

Testing that stays inside these bounds will not be treated as a
breach of the Terms of Service or as grounds for legal action:

- Use only accounts you own, or test accounts we've provisioned.
- Do not access, modify, or exfiltrate data belonging to other users.
- Do not run load tests, spam the production OTP sender, or
  otherwise disrupt the service for real users.
- Share findings only with Loop until disclosure is coordinated.

If you're unsure whether your testing is safe-harbour, ask in the
advisory or email before acting.
