/**
 * NS-08 — HTTP enforcement helper for the user-initiated debit entry
 * points (design doc §5A). A cheap fail-closed gate: read the freeze
 * mirror once and, if a live hold blocks the intent, return the uniform
 * `403 ACCOUNT_FROZEN` envelope; otherwise return null and let the
 * handler proceed. The authoritative in-txn re-read still guards the
 * durable debit primitive (§5B) — this is the UX + cost-control layer.
 *
 * The message is deliberately generic (design doc §6 Q8 — AML/sanctions
 * holds can carry anti-tipping-off constraints; the exact user-facing
 * copy is a legal decision). It says "contact support" without naming a
 * freeze/AML reason.
 */
import type { Context } from 'hono';
import { ApiErrorCode } from '@loop/shared';
import {
  getAccountFreezeState,
  scopeBlocksDebit,
  scopeBlocksIncoming,
  type FreezeIntent,
} from './account-freeze.js';

/**
 * Returns a `403 ACCOUNT_FROZEN` Response when a live hold blocks
 * `intent` for `userId`, or null to proceed. Fail-closed: an unreadable
 * mirror resolves to frozen (`getAccountFreezeState` treats a read error
 * as scope `full`), so the gate blocks rather than letting a debit slip.
 */
export async function guardAccountNotFrozen(
  c: Context,
  userId: string,
  intent: FreezeIntent,
): Promise<Response | null> {
  const state = await getAccountFreezeState(userId);
  if (!state.frozen || state.scope === null) return null;
  const blocked =
    intent === 'system_payout' ? scopeBlocksIncoming(state.scope) : scopeBlocksDebit(state.scope);
  if (!blocked) return null;
  return c.json(
    {
      code: ApiErrorCode.ACCOUNT_FROZEN,
      message: 'Your account is on hold and can’t complete this action. Please contact support.',
    },
    403,
  );
}
