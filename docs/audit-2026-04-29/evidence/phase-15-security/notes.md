# Phase 15 — Security, Privacy & Abuse

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Pasteur`
- Phase status: complete

## Findings logged

- `A3-034` Medium — authenticated barcode gift-card images are republished as 7-day public cache objects.
- `A3-035` Low — admin read-audit logging retains raw query-string PII.

## Cross-phase note

- Auth and cache-boundary security defects already logged under other phases remain part of the security story here: `A3-015`, `A3-016`, `A3-021`, and `A3-024`.

## Clean bill so far

- Image-proxy SSRF guards, ClusterMap HTML escaping, redeem WebView URL validation, and token/key/webhook redaction all looked materially sound on this pass.
