/**
 * NS-04 — durable runtime rail kill/halt switches: shared types.
 *
 * DESIGN SCAFFOLD ONLY. These types describe a *durable*, admin-toggleable
 * halt capability for the four money-moving rails. It is deliberately
 * distinct from the existing boot/secret-based kill switches in
 * `../kill-switches.ts` (A2-1907, subsystems `orders-legacy` /
 * `orders-loop` / `auth` / `emissions`), which are flipped via
 * `fly secrets set` + a rolling restart and read live from `process.env`.
 *
 * The rails here (deposit / payout / vault / refund) have NO runtime halt
 * today — only coarse boot flags (`LOOP_WORKERS_ENABLED`,
 * `LOOP_VAULTS_ENABLED`) that need a redeploy. NS-04 proposes a
 * `rail_kill_switches` table (migration 0071+, applied later, serialized —
 * NOT part of this scaffold) so an admin can halt/resume a single rail
 * without a redeploy, and each rail's entry point rejects new work while
 * halted.
 *
 * See `docs/audit/audit-2026-07/ns-04-kill-switches-design.md` for the full
 * design, proposed SQL, enforcement points, and the open policy questions.
 *
 * NOTHING in this module is wired into a live rail. It exists to pin the
 * interface shape and let the design compile; enforcement is intentionally
 * deferred until the migration lands and a halt policy is agreed.
 */

/**
 * The four money-moving rails that gain a runtime halt under NS-04.
 *
 *  - `deposit` — inbound on-chain payment matching (payment-watcher tick).
 *  - `payout`  — outbound Stellar payment draining (`pending_payouts`).
 *  - `vault`   — DeFindex yield-vault deposit / withdraw / share-transfer.
 *  - `refund`  — credit-ledger refund + on-chain deposit-return primitives.
 *
 * Kept separate from `KillSwitch` in `../kill-switches.ts` on purpose: that
 * union names *env-secret* subsystems; this one names *DB-backed* rails.
 */
export type Rail = 'deposit' | 'payout' | 'vault' | 'refund';

/** Canonical rail list — the durable table has exactly one row per entry. */
export const RAILS: readonly Rail[] = ['deposit', 'payout', 'vault', 'refund'] as const;

/**
 * The current durable halt state for one rail — the read model the admin
 * "list" endpoint and every enforcement check consume.
 *
 * The DEFAULT for every rail is `halted: false` (a protected class — see
 * the design doc §Policy). A rail is only ever halted by an explicit,
 * audited admin action.
 */
export interface RailHaltState {
  rail: Rail;
  /** `true` while the rail is halted; `false` (default) while open. */
  halted: boolean;
  /** Operator-supplied reason for the current state; `null` when never toggled. */
  reason: string | null;
  /** Admin user id who last toggled this rail; `null` when never toggled. */
  actorUserId: string | null;
  /** When the current state was last written. */
  updatedAt: Date;
}

/** Arguments for an admin halt action. Mirrors the audited admin-write shape. */
export interface HaltArgs {
  rail: Rail;
  /** Admin performing the halt (from `requireStaff('admin')` context). */
  actorUserId: string;
  /** Required human reason, surfaced in the audit trail. */
  reason: string;
  /** ADR-017 idempotency key so a double-click can't double-write. */
  idempotencyKey: string;
}

/** Arguments for an admin resume action. */
export interface ResumeArgs {
  rail: Rail;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
}
