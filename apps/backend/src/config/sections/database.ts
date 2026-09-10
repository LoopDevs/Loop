// database config — discriminated union for driver-specific settings
import { z } from 'zod';

export const databaseSchema = z
  .discriminatedUnion('driver', [
    z.object({
      driver: z.literal('memory'),
      // Empty string = ephemeral store (unit-test posture)
      jsonPath: z.string().default('_data/db.json'),
    }),
    z.object({
      driver: z.literal('mongo'),
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
