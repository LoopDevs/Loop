# Severity Model

Severity is based on impact and exploitability at the current baseline.

## Critical

Use for issues that can plausibly cause any of:

- unauthorized money movement or unrecoverable financial loss
- private key or production secret exposure
- unauthenticated admin action
- broad customer PII exposure
- remote code execution in production or CI with secrets
- systemic ledger corruption that cannot be reconciled from existing records
- release control failure that lets unreviewed malicious code ship to production with secrets

## High

Use for issues that can plausibly cause any of:

- account takeover or durable session compromise
- cross-user order, payout, wallet, or credit data access
- duplicate payout, double credit, missed debit, or negative balance under realistic conditions
- admin write bypass of actor, reason, idempotency, or audit controls
- SSRF or injection with meaningful internal, credential, or user impact
- broken migration or deploy path that can take production down
- alert or runbook gap for money-moving incidents where detection is unlikely

## Medium

Use for issues that can plausibly cause any of:

- meaningful but bounded data leakage
- incorrect user/admin reporting that can drive bad operator action
- stale or incorrect financial calculations with reconciliation path
- missing tests for high-risk behavior that is otherwise correctly implemented
- documentation drift that can cause unsafe operation
- CI or release weakness requiring maintainer mistake to exploit
- security hardening gap with bounded exploitability

## Low

Use for issues that can plausibly cause any of:

- minor user-visible correctness issue
- low-risk documentation drift
- localized missing test for low-risk code
- maintainability issue that increases future audit or review risk
- harmless dead code, stale fixture, or unused asset

## Info

Use for observations that do not require remediation but should be recorded:

- accepted design limitation confirmed by code
- intentional operational tradeoff
- documentation clarification without behavior risk
- evidence of strong control worth preserving

## Severity Modifiers

Raise severity when:

- exploit does not require auth
- exploit affects money, identity, secrets, or admin behavior
- issue is hard to detect
- issue can repeat automatically through workers
- issue spans multiple packages or release paths
- issue can survive retry, reload, or restart

Lower severity when:

- exploit requires already-compromised admin access and leaves clear audit evidence
- blast radius is one user and easy to reverse
- code has a strong compensating control
- failure is visible and recoverable through tested runbooks
