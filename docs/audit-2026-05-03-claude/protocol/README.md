# Audit Protocol

These protocol files define how the audit is executed. If a phase conflicts with protocol, protocol wins unless the lead auditor records an exception in `tracker.md`.

Protocol files:

- [cold-audit-rules.md](./cold-audit-rules.md)
- [execution-protocol.md](./execution-protocol.md)
- [evidence-protocol.md](./evidence-protocol.md)
- [file-disposition-protocol.md](./file-disposition-protocol.md)
- [finding-protocol.md](./finding-protocol.md)
- [planned-feature-protocol.md](./planned-feature-protocol.md)
- [review-dimensions.md](./review-dimensions.md)
- [second-third-pass.md](./second-third-pass.md)

Audit execution is append-only until phase close. Corrections after close belong in `tracker.md` and, if needed, in a follow-up evidence note that explains the correction.
