/**
 * In-process serialisation for read-modify-write sequences the
 * document store cannot make atomic.
 *
 * The store (`store.ts`) offers atomic *single-document* operations —
 * `updateOne` is a compare-and-set, `insertOne` fails closed on a
 * unique violation — which covers almost everything. What it has no
 * answer for is an invariant spanning several documents that must hold
 * across a check and a write: "there is always at least one admin"
 * needs a count and a mutation to be indivisible, and two concurrent
 * demotions that both read `count === 2` would both proceed.
 *
 * Postgres gave that for free (`pg_advisory_xact_lock` inside a
 * transaction). What replaces it here is a promise chain per key: a
 * caller awaits whatever is currently queued under its key, runs, and
 * hands the next caller its completion. Same serialisation, same
 * ordering, no transaction.
 *
 * ── The limit, stated plainly ──────────────────────────────────────
 *
 * This lock lives in ONE process. Two backend machines each hold their
 * own chain and do not see each other, so it does not serialise across
 * a fleet. That is sound today because both drivers are already
 * single-writer in practice — the memory driver IS the process, and
 * the deployment runs one machine — but it is a real constraint, not
 * an implementation detail: a horizontally-scaled Mongo deployment
 * needs a shared lock (a `findOneAndUpdate` lease document, or Mongo
 * transactions) before these invariants hold fleet-wide.
 *
 * Every guarded invariant is a refusal to act, never a money movement:
 * the failure mode of a lost race is a demotion that should have been
 * refused, or an admin write that replays instead of returning its
 * snapshot — recoverable, and loud in the audit trail.
 */

/**
 * Tail of the promise chain per key. An entry is deleted as soon as
 * its chain drains, so the map tracks only in-flight keys rather than
 * growing once per (admin, idempotency-key) pair ever seen.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` with no other `withKeyedLock` call for the same `key`
 * running concurrently. Callers queue in arrival order.
 *
 * `fn`'s rejection propagates to its own caller and does NOT poison
 * the queue — the next waiter still runs, which is what you want when
 * one admin's malformed write must not wedge everyone else's.
 */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // Swallow the predecessor's rejection here (it was already delivered
  // to its own caller) so a failed holder doesn't reject every waiter.
  const run = previous.then(fn, fn);
  // Park a settled-either-way tail so the next caller waits for THIS
  // run to finish rather than for it to succeed.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    // Only clear when we're the last queued caller; a later arrival
    // has already replaced the tail and is waiting on it.
    if (chains.get(key) === tail) chains.delete(key);
  }
}
