# Phase 24 - Planned Features and Current Feature Set

Status: in-progress

Required evidence:

- planned-feature source inventory
- current-feature source inventory
- planned-vs-current matrix
- deferred-control trigger review
- partial/hidden/reachable feature risk review
- planned user journey vs current user journey review

Artifacts:

- `../../inventory/planned-feature-matrix.tsv`

Findings:

- A4-037 — Loop-native OTP auth has no supported production email provider
- A4-038 — Tax/reporting ADR claims a quarterly CSV implementation that is absent
- A4-040 — Loop-native purchase UI exposes only USDC despite planned and backend-supported XLM, credit, and LOOP-asset payment rails

Evidence captured:

- `../../inventory/planned-feature-matrix.tsv` now classifies nine planned/current feature areas against current code, tests, docs, and findings.
- `artifacts/loop-native-email-provider-gap.txt` verifies the Loop-native auth rollout against `auth/email.ts`, `native-request-otp.ts`, env schema/docs, and tests. Result: no supported production email provider exists.
- `artifacts/tax-reporting-csv-implementation-gap.txt` verifies ADR-026 against current scripts, package commands, schema, and migrations. Result: the named quarterly tax emitter and report command are absent.
- `artifacts/web-loop-payment-method-gap.txt` verifies the primary web purchase path against backend order contracts, DB constraints, and public product copy. Result: Loop-native purchase creation hardcodes `paymentMethod: 'usdc'`.

Current classification highlights:

- Implemented but defect-bearing: stablecoin cashback/payouts, CTX principal-switch rails, admin primitives/drill-downs, mobile shell, CI/provenance, Loop-native auth.
- User-visible payment-rail gap: backend/admin/read contracts support XLM, USDC, credit, and LOOP-asset rails, but the primary purchase journey exposes only USDC when Loop-native orders are enabled.
- Designed/deferred: admin step-up auth and several mobile security controls.
- Designed but not implemented despite contradictory doc wording: quarterly tax/regulatory CSV reports.

Second-pass notes:

- Planned features were not accepted as truth from docs. Each row includes a current-code source or an explicit absence proof.
- Step-up auth remains classified as deferred rather than filed as a defect because ADR-028 status explicitly says implementation deferred, even though its body describes the intended Phase-1 mechanics.
