// Admin idempotency constants — ADR 017, A2-500

export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 128;

// Replay window only; rows retained as audit trail (see admin.auditRetentionDays)
export const IDEMPOTENCY_TTL_HOURS = 24;
