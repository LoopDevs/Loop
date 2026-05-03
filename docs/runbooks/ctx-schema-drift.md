# Runbook · `notifyCtxSchemaDrift` alert

## Symptom

Discord `#ops-alerts` embed from `notifyCtxSchemaDrift` reporting a CTX response that failed Zod validation on a known surface.

## Severity

**P1** if the affected surface is auth, orders, or procurement. Otherwise **P2**.

## Diagnosis

1. Identify the failing surface from the alert and logs.
2. Compare the live CTX payload against the pinned fixture in `apps/backend/src/__fixtures__/ctx/`.
3. Determine whether CTX widened the schema, removed a field, or changed a type.

## Mitigation

- If the change is harmless widening: patch the parser and ship immediately.
- If the change is breaking or ambiguous: gate the affected feature if needed, escalate to CTX, and keep the alert thread updated.

## Resolution

Land the schema/parser update, rerun the contract test, and confirm the alert stops repeating.

## Related

- [`ctx-circuit-open.md`](./ctx-circuit-open.md)
