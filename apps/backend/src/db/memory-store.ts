// in-memory document store — atomic tmp-file + rename flush
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLLECTION_SPECS, type CollectionDocs, type CollectionName } from './types.js';
import {
  applyUpdate,
  matchesFilter,
  sortDocs,
  UniqueViolationError,
  type Collection,
  type DataStore,
  type Filter,
  type FindOptions,
  type Update,
} from './store.js';

const FLUSH_DEBOUNCE_MS = 250;

type DateMarker = { $date: string };

function serialize(data: Record<string, unknown[]>): string {
  return JSON.stringify(
    data,
    (_key, value: unknown) => value,
    2,
    // JSON.stringify calls toJSON() on Dates BEFORE the replacer sees
    // them, so Dates are wrapped via the pre-pass below instead.
  );
}

function wrapDates(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() } satisfies DateMarker;
  if (Array.isArray(value)) return value.map(wrapDates);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wrapDates(v);
    return out;
  }
  return value;
}

function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['$date'] === 'string' && Object.keys(record).length === 1) {
      return new Date(record['$date']);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = reviveDates(v);
    return out;
  }
  return value;
}

class MemoryCollection<T extends object> implements Collection<T> {
  constructor(
    private readonly name: CollectionName,
    private readonly docs: T[],
    private readonly onMutate: () => void,
  ) {}

  private select(filter: Filter<T> | undefined, options?: FindOptions<T>): T[] {
    let out = this.docs.filter((d) => matchesFilter(d, filter));
    out = sortDocs(out, options?.sort);
    if (options?.skip !== undefined) out = out.slice(options.skip);
    if (options?.limit !== undefined) out = out.slice(0, options.limit);
    return out;
  }

  findOne(filter: Filter<T>, options?: FindOptions<T>): Promise<T | null> {
    const [first] = this.select(filter, { ...options, limit: 1 });
    return Promise.resolve(first !== undefined ? { ...first } : null);
  }

  findMany(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]> {
    return Promise.resolve(this.select(filter, options).map((d) => ({ ...d })));
  }

  count(filter?: Filter<T>): Promise<number> {
    return Promise.resolve(this.docs.filter((d) => matchesFilter(d, filter)).length);
  }

  private assertUnique(candidate: T, ignore?: T): void {
    for (const fields of COLLECTION_SPECS[this.name].uniques) {
      const values = fields.map((f) => (candidate as Record<string, unknown>)[f]);
      // Partial-unique semantics: a tuple with any null/missing field is exempt.
      if (values.some((v) => v === null || v === undefined)) continue;
      const clash = this.docs.some(
        (d) =>
          d !== ignore && fields.every((f, i) => (d as Record<string, unknown>)[f] === values[i]),
      );
      if (clash) throw new UniqueViolationError(this.name, fields);
    }
  }

  insertOne(doc: T): Promise<void> {
    this.assertUnique(doc);
    this.docs.push({ ...doc });
    this.onMutate();
    return Promise.resolve();
  }

  updateOne(filter: Filter<T>, update: Update<T>, options?: FindOptions<T>): Promise<T | null> {
    const [target] = this.select(filter, { ...options, limit: 1 });
    if (target === undefined) return Promise.resolve(null);
    const index = this.docs.indexOf(target);
    const next = applyUpdate(target, update);
    this.assertUnique(next, target);
    this.docs[index] = next;
    this.onMutate();
    return Promise.resolve({ ...next });
  }

  updateMany(filter: Filter<T>, update: Update<T>): Promise<number> {
    let updated = 0;
    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i];
      if (doc !== undefined && matchesFilter(doc, filter)) {
        this.docs[i] = applyUpdate(doc, update);
        updated++;
      }
    }
    if (updated > 0) this.onMutate();
    return Promise.resolve(updated);
  }

  replaceOne(filter: Filter<T>, doc: T, options?: { upsert?: boolean }): Promise<void> {
    const [target] = this.select(filter, { limit: 1 });
    if (target !== undefined) {
      this.assertUnique(doc, target);
      this.docs[this.docs.indexOf(target)] = { ...doc };
      this.onMutate();
    } else if (options?.upsert === true) {
      this.assertUnique(doc);
      this.docs.push({ ...doc });
      this.onMutate();
    }
    return Promise.resolve();
  }

  deleteMany(filter: Filter<T>): Promise<number> {
    const keep = this.docs.filter((d) => !matchesFilter(d, filter));
    const deleted = this.docs.length - keep.length;
    if (deleted > 0) {
      this.docs.length = 0;
      this.docs.push(...keep);
      this.onMutate();
    }
    return Promise.resolve(deleted);
  }
}

export class MemoryStore implements DataStore {
  private readonly data = new Map<CollectionName, object[]>();
  private readonly collections = new Map<CollectionName, Collection<object>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly filePath: string | null) {}

  init(): Promise<void> {
    if (this.filePath !== null && existsSync(this.filePath)) {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      for (const name of Object.keys(COLLECTION_SPECS) as CollectionName[]) {
        const rows = raw[name];
        if (Array.isArray(rows)) this.data.set(name, reviveDates(rows) as object[]);
      }
    }
    return Promise.resolve();
  }

  collection<Name extends CollectionName>(name: Name): Collection<CollectionDocs[Name]> {
    let col = this.collections.get(name);
    if (col === undefined) {
      let docs = this.data.get(name);
      if (docs === undefined) {
        docs = [];
        this.data.set(name, docs);
      }
      col = new MemoryCollection(name, docs, () => this.scheduleFlush());
      this.collections.set(name, col);
    }
    return col as Collection<CollectionDocs[Name]>;
  }

  private scheduleFlush(): void {
    if (this.filePath === null) return;
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
    // Never keep the process alive just to persist — close() flushes too.
    this.flushTimer.unref();
  }

  private flushSync(): void {
    if (this.filePath === null || !this.dirty) return;
    this.dirty = false;
    const snapshot: Record<string, unknown[]> = {};
    for (const [name, docs] of this.data) {
      snapshot[name] = wrapDates(docs) as unknown[];
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, serialize(snapshot), 'utf8');
    renameSync(tmp, this.filePath);
  }

  close(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
    return Promise.resolve();
  }
}
