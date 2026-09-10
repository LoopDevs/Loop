// Social-login ID-token replay guard — A2-566, AGT-06
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { logger } from '../logger.js';
import type { SocialProvider } from '../db/types.js';

const log = logger.child({ component: 'id-token-replay' });

export async function consumeIdToken(args: {
  token: string;
  provider: SocialProvider;
  expSeconds: number;
}): Promise<boolean> {
  const tokenHash = createHash('sha256').update(args.token).digest('hex');
  const expiresAt = new Date(args.expSeconds * 1000);
  try {
    await db.collection('social_id_token_uses').insertOne({
      tokenHash,
      provider: args.provider,
      expiresAt,
      createdAt: new Date(),
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      log.warn({ provider: args.provider }, 'Social id_token replay rejected');
      return false;
    }
    // Fail closed on store error to prevent replay during transient outages
    log.error({ err, provider: args.provider }, 'id-token replay-guard store error');
    throw err;
  }
}

export async function purgeExpiredIdTokenUses(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  return db.collection('social_id_token_uses').deleteMany({ expiresAt: { $lt: cutoff } });
}
