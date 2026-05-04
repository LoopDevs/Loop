# Phase 17 - Security, Privacy, and Abuse Resistance

Status: in-progress

Required evidence:

- threat model by actor: started
- abuse surface review: started
- secrets/logging/redaction/PII review: started
- SSRF/XSS/CSRF/CORS/header review: started
- fraud and resource-exhaustion review: pending deeper pass

Findings:

- A4-030 - local ignored env files contain secret-bearing values with world-readable permissions
- A4-042 - DSR account deletion leaves historical payout destination addresses tied to the retained user row

Evidence captured:

- [local-env-secret-residue.txt](./artifacts/local-env-secret-residue.txt)
- [dsr-delete-payout-address-retention.txt](./artifacts/dsr-delete-payout-address-retention.txt)

Current verified observations:

- Production CORS is allowlisted and secure headers are mounted through dedicated middleware.
- `requireAuth` accepts Loop-signed tokens for local identity and preserves CTX pass-through for legacy proxy paths; identity-scoped `/me*`, admin, and Loop-native order paths require Loop-auth context before using local user state.
- Logger and Sentry scrubbers contain explicit redaction lists for auth headers, refresh/access tokens, OTPs, API credentials, operator secrets, database URL, Sentry DSNs, and Discord webhooks.
- Local ignored env files are present in the workspace and contain secret-bearing key names; values were not copied into audit evidence.
- DSR delete code clears the user's email, CTX user ID, primary Stellar address, auth sessions, and social identities, but only blocks pending/submitted payouts and leaves terminal `pending_payouts.to_address` rows tied to the retained `user_id`.
- DSR export code includes payout destination addresses as user export data, while privacy copy claims account identifiers are deleted and retained ledger rows no longer link to a real person.
