/**
 * MongoDB driver for the document store (`DB_DRIVER=mongo`).
 *
 * The store's filter/update language is already a Mongo subset, so
 * calls pass through nearly verbatim. App-level ids are the identity —
 * Mongo's `_id` is stripped from every read and the unique specs in
 * `COLLECTION_SPECS` are materialised as unique indexes at init
 * (sparse-like partial filters for tuples with nullable members, e.g.
 * the orders idempotency fence).
 */
import {
  MongoClient,
  MongoServerError,
  type Collection as MongoCollection,
  type Document,
  type Sort as MongoSort,
} from 'mongodb';
import { COLLECTION_SPECS, type CollectionDocs, type CollectionName } from './types.js';
import {
  UniqueViolationError,
  type Collection,
  type DataStore,
  type Filter,
  type FindOptions,
  type Update,
} from './store.js';

function toMongoSort<T>(options?: FindOptions<T>): MongoSort | undefined {
  if (options?.sort === undefined || options.sort.length === 0) return undefined;
  return Object.fromEntries(options.sort.map(([field, dir]) => [field, dir === 'asc' ? 1 : -1]));
}

class MongoStoreCollection<T extends object> implements Collection<T> {
  constructor(
    private readonly name: CollectionName,
    private readonly col: MongoCollection<Document>,
  ) {}

  async findOne(filter: Filter<T>, options?: FindOptions<T>): Promise<T | null> {
    const sort = toMongoSort(options);
    const doc = await this.col.findOne(filter as Document, {
      ...(sort !== undefined ? { sort } : {}),
      projection: { _id: 0 },
    });
    return doc as T | null;
  }

  async findMany(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]> {
    let cursor = this.col
      .find((filter ?? {}) as Document, { projection: { _id: 0 } })
      .sort(toMongoSort(options) ?? {});
    if (options?.skip !== undefined) cursor = cursor.skip(options.skip);
    if (options?.limit !== undefined) cursor = cursor.limit(options.limit);
    return (await cursor.toArray()) as T[];
  }

  async count(filter?: Filter<T>): Promise<number> {
    return this.col.countDocuments((filter ?? {}) as Document);
  }

  async insertOne(doc: T): Promise<void> {
    try {
      // Spread so the driver's `_id` injection never lands on the caller's object.
      await this.col.insertOne({ ...doc });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        const keyPattern = (err as MongoServerError & { keyPattern?: Record<string, unknown> })
          .keyPattern;
        throw new UniqueViolationError(this.name, Object.keys(keyPattern ?? {}));
      }
      throw err;
    }
  }

  async updateOne(
    filter: Filter<T>,
    update: Update<T>,
    options?: FindOptions<T>,
  ): Promise<T | null> {
    const sort = toMongoSort(options);
    const doc = await this.col.findOneAndUpdate(filter as Document, update as Document, {
      ...(sort !== undefined ? { sort } : {}),
      returnDocument: 'after',
      projection: { _id: 0 },
    });
    return doc as T | null;
  }

  async updateMany(filter: Filter<T>, update: Update<T>): Promise<number> {
    const result = await this.col.updateMany(filter as Document, update as Document);
    return result.modifiedCount;
  }

  async replaceOne(filter: Filter<T>, doc: T, options?: { upsert?: boolean }): Promise<void> {
    await this.col.replaceOne(filter as Document, { ...doc }, { upsert: options?.upsert === true });
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    const result = await this.col.deleteMany(filter as Document);
    return result.deletedCount;
  }
}

export class MongoStore implements DataStore {
  private readonly client: MongoClient;
  private readonly collections = new Map<CollectionName, Collection<object>>();

  constructor(
    uri: string,
    private readonly dbName: string,
  ) {
    this.client = new MongoClient(uri);
  }

  async init(): Promise<void> {
    await this.client.connect();
    const db = this.client.db(this.dbName);
    for (const [name, spec] of Object.entries(COLLECTION_SPECS)) {
      for (const fields of spec.uniques) {
        const key = Object.fromEntries(fields.map((f) => [f, 1]));
        // Partial filter mirrors the memory driver's "any null field is
        // exempt" rule so nullable unique tuples (orders idempotency)
        // don't collide on null.
        const partialFilterExpression = Object.fromEntries(
          fields.map((f) => [f, { $type: ['string', 'number', 'bool', 'date', 'objectId'] }]),
        );
        await db.collection(name).createIndex(key, { unique: true, partialFilterExpression });
      }
    }
  }

  collection<Name extends CollectionName>(name: Name): Collection<CollectionDocs[Name]> {
    let col = this.collections.get(name);
    if (col === undefined) {
      col = new MongoStoreCollection(name, this.client.db(this.dbName).collection(name));
      this.collections.set(name, col);
    }
    return col as Collection<CollectionDocs[Name]>;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
