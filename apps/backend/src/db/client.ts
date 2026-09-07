/**
 * Database singleton. Picks the driver from `DB_DRIVER`:
 *
 *   - `memory` (default) — the whole database in process memory,
 *     hydrated from / flushed to the JSON file at `DB_JSON_PATH`
 *     (unset → ephemeral). The right shape while Loop is undeployed
 *     and for every test.
 *   - `mongo` — MongoDB via `MONGODB_URI` / `MONGODB_DB`.
 *
 * `initDb()` must be awaited at boot before serving traffic (index.ts
 * does this; tests use the ephemeral memory store which needs no init).
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import { MemoryStore } from './memory-store.js';
import type { DataStore } from './store.js';

const log = logger.child({ area: 'db' });

function createStore(): DataStore {
  if (env.DB_DRIVER === 'mongo') {
    // Lazy import so the memory-only posture never loads the driver.
    throw new Error('mongo store must be created via initDb()');
  }
  // Tests always get an ephemeral store — a unit test must never flush
  // into the developer's local db.json.
  const filePath = env.NODE_ENV === 'test' || env.DB_JSON_PATH === '' ? null : env.DB_JSON_PATH;
  return new MemoryStore(filePath);
}

let store: DataStore = env.DB_DRIVER === 'mongo' ? (null as unknown as DataStore) : createStore();

/** The active store. Import this everywhere a repository needs data access. */
export const db: DataStore = new Proxy({} as DataStore, {
  get(_target, prop: keyof DataStore) {
    if (store === null) {
      throw new Error('db used before initDb() — the mongo driver connects at boot');
    }
    return store[prop].bind(store);
  },
});

/** Connect / hydrate the configured driver. Called once at boot. */
export async function initDb(): Promise<void> {
  if (env.DB_DRIVER === 'mongo') {
    const { MongoStore } = await import('./mongo-store.js');
    if (env.MONGODB_URI === undefined) {
      throw new Error('DB_DRIVER=mongo requires MONGODB_URI');
    }
    store = new MongoStore(env.MONGODB_URI, env.MONGODB_DB);
    log.info({ driver: 'mongo', db: env.MONGODB_DB }, 'Connecting to MongoDB');
  } else {
    log.info(
      { driver: 'memory', file: env.DB_JSON_PATH === '' ? null : env.DB_JSON_PATH },
      'Using in-memory document store',
    );
  }
  await store.init();
}

/** Flush + disconnect. Wired into the graceful-shutdown handler. */
export async function closeDb(): Promise<void> {
  if (store !== null) await store.close();
}

/**
 * Test seam: swap in a fresh, ephemeral memory store so each test (or
 * suite) starts from an empty database. Never call outside tests.
 */
export function __resetDbForTests(): void {
  store = new MemoryStore(null);
}

// ─── Single-flight fences ───────────────────────────────────────────────────
//
// The old Postgres advisory-lock fence (`withAdvisoryLock`) serialised
// periodic workers fleet-wide. Undeployed, single-process Loop needs
// only an in-process fence: overlapping ticks of the same worker skip
// instead of stacking. Same `{ ran }` contract so callers are a
// mechanical port.

const inFlight = new Set<string>();

export async function withSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (inFlight.has(key)) return { ran: false };
  inFlight.add(key);
  try {
    return { ran: true, value: await fn() };
  } finally {
    inFlight.delete(key);
  }
}
