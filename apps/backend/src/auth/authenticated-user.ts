// Identity-resolution for /me* — A2-550, A2-551, ADR 013
import type { Context } from 'hono';
import type { LoopAuthContext } from './handler.js';
import { getUserById, type User } from '../db/users.js';

export async function resolveLoopAuthenticatedUser(c: Context): Promise<User | null> {
  const auth = c.get('auth') as LoopAuthContext | undefined;
  if (auth === undefined || auth.kind !== 'loop') return null;
  return await getUserById(auth.userId);
}
