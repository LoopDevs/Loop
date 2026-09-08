/**
 * config section: `database:` — the document store driver and its
 * per-driver settings.
 *
 * This is the clearest case for nesting in the whole file. As flat env
 * vars, `DB_DRIVER` / `DB_JSON_PATH` / `MONGODB_URI` / `MONGODB_DB` sat
 * side by side with nothing saying that two of them apply only to
 * `memory` and two only to `mongo` — the relationship lived in a
 * hand-written boot guard in `env.ts` ("DB_DRIVER=mongo requires
 * MONGODB_URI"). A discriminated union puts it back in the type: pick a
 * driver and only that driver's settings are accepted, with the
 * required ones actually required.
 *
 * See `./server.ts` for what a section module is.
 */
import { z } from 'zod';

export const databaseSchema = z
  .discriminatedUnion('driver', [
    z.object({
      // The default. Loads the whole database into memory from
      // `jsonPath` at boot and flushes writes back (debounced, atomic
      // rename). See src/db/memory-store.ts.
      driver: z.literal('memory'),
      // Where the memory driver persists. Set to an empty string for an
      // ephemeral store with no persistence at all — the unit-test
      // posture.
      jsonPath: z.string().default('_data/db.json'),
    }),
    z.object({
      // Connects to a real MongoDB. See src/db/mongo-store.ts.
      driver: z.literal('mongo'),
      // Required — no default, no boot guard needed. Previously this
      // could be omitted and the deployment would come up fine, then
      // fail on the first collection access.
      uri: z
        .string()
        .url()
        .refine((u) => u.startsWith('mongodb://') || u.startsWith('mongodb+srv://'), {
          message: 'must be a mongodb:// or mongodb+srv:// URL',
        }),
      name: z.string().min(1).default('loop'),
    }),
  ])
  .prefault({ driver: 'memory' });
