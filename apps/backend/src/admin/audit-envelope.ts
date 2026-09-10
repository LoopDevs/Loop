// Admin write envelope — ADR 017
import type { User } from '../db/users.js';

export interface AdminAuditEnvelope<T> {
  result: T;
  audit: {
    actorUserId: string;
    actorEmail: string;
    idempotencyKey: string;
    appliedAt: string;
    replayed: boolean;
  };
}

export function buildAuditEnvelope<T>(args: {
  result: T;
  actor: User;
  idempotencyKey: string;
  appliedAt: Date;
  replayed: boolean;
}): AdminAuditEnvelope<T> {
  return {
    result: args.result,
    audit: {
      actorUserId: args.actor.id,
      actorEmail: args.actor.email,
      idempotencyKey: args.idempotencyKey,
      appliedAt: args.appliedAt.toISOString(),
      replayed: args.replayed,
    },
  };
}
