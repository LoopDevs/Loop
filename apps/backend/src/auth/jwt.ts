import { createHmac, randomBytes } from 'crypto';
import { env } from '../env.js';

const ACCESS_TOKEN_TTL_S = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days

interface JwtPayload {
  sub: string; // email
  exp: number;
  iat: number;
  jti: string;
}

/** Minimal HS256 JWT implementation — no external dependency. */
function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function sign(payload: JwtPayload, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = base64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verify(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts as [string, string, string];
  const data = `${header}.${body}`;
  const expectedSig = base64url(createHmac('sha256', secret).update(data).digest());

  if (sig !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Issues an access + refresh token pair for the given email. */
export function issueTokenPair(email: string): { accessToken: string; refreshToken: string } {
  const now = Math.floor(Date.now() / 1000);

  const accessToken = sign(
    { sub: email, iat: now, exp: now + ACCESS_TOKEN_TTL_S, jti: randomBytes(8).toString('hex') },
    env.JWT_SECRET,
  );

  const refreshToken = sign(
    { sub: email, iat: now, exp: now + REFRESH_TOKEN_TTL_S, jti: randomBytes(8).toString('hex') },
    env.JWT_REFRESH_SECRET,
  );

  return { accessToken, refreshToken };
}

/** Verifies an access token. Returns the email or null if invalid/expired. */
export function verifyAccessToken(token: string): string | null {
  return verify(token, env.JWT_SECRET)?.sub ?? null;
}

/** Verifies a refresh token and issues a new access token. Returns null if invalid. */
export function refreshAccessToken(refreshToken: string): string | null {
  const payload = verify(refreshToken, env.JWT_REFRESH_SECRET);
  if (payload === null) return null;

  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: payload.sub, iat: now, exp: now + ACCESS_TOKEN_TTL_S, jti: randomBytes(8).toString('hex') },
    env.JWT_SECRET,
  );
}
