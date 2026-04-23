/**
 * Exhaustiveness marker (A2-1532).
 *
 * Call from the `default` branch of a discriminating switch to force
 * TypeScript to prove every variant is handled. Adding a new variant
 * later becomes a compile error at every switch that's missing the
 * case — no runtime fallthrough bugs like A2-1531's silently-yellow
 * pill for a brand-new OrderState.
 *
 * The function IS called at runtime as a last-resort guard — we throw
 * rather than return so a runtime violation (e.g. a backend sent a
 * state the current client doesn't know about) fails loudly instead
 * of the UI showing stale or default-branch output.
 *
 * Example:
 *   switch (state) {
 *     case 'a': return ...;
 *     case 'b': return ...;
 *     default:  return assertNever(state, 'state');
 *   }
 */
export function assertNever(value: never, label = 'value'): never {
  throw new Error(`Non-exhaustive ${label}: ${JSON.stringify(value)}`);
}
