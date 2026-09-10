// Database singleton — memory (default) or mongo, selected by `database.driver`
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { MemoryStore } from './memory-store.js';
import type { DataStore } from './store.js';

const log = logger.child({ area: 'db' });

function createStore(): DataStore {
  if (config.database.driver === 'mongo') {
    // Lazy import so the memory-only posture never loads the driver.
    throw new Error('mongo store must be created via initDb()');
  }
  // Tests always get an ephemeral store — a unit test must never flush
  // into the developer's local db.json.
  const filePath =
    config.env === 'test' || config.database.jsonPath === '' ? null : config.database.jsonPath;
  return new MemoryStore(filePath);
}

let store: DataStore =
  config.database.driver === 'mongo' ? (null as unknown as DataStore) : createStore();

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
  if (config.database.driver === 'mongo') {
    const { MongoStore } = await import('./mongo-store.js');
    store = new MongoStore(config.database.uri, config.database.name);
    log.info({ driver: 'mongo', db: config.database.name }, 'Connecting to MongoDB');
  } else {
    log.info(
      { driver: 'memory', file: config.database.jsonPath === '' ? null : config.database.jsonPath },
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
