/**
 * `GET /api/admin/lookup?q=` wire shape (ADR 037 — User 360 reverse
 * lookups). One box for "I have an order id / payment memo / Stellar
 * address from a ticket — whose is it?". Email lookups stay on the
 * existing `/api/admin/users` search; this endpoint covers the
 * non-email identifiers.
 */

export type AdminLookupKind = 'order' | 'memo' | 'address' | 'none';

/** `GET /api/admin/lookup?q=…` */
export interface AdminLookupResult {
  kind: AdminLookupKind;
  /** Set when the identifier resolved to a user. */
  userId?: string;
  /** Set when the identifier resolved to (or via) an order. */
  orderId?: string;
}
