// In-process serialisation for multi-document invariants the store cannot make atomic — single-process only; fleet-wide needs a shared lock
const chains = new Map<string, Promise<unknown>>();

// Rejection does not poison the queue — next waiter still runs
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}
