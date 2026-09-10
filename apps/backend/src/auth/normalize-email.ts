// A2-2002: shared email-normalization primitive

const ASCII_RE = /^[\x20-\x7e]+$/;

export interface NormalizedEmail {
  value: string;
}

export class NonAsciiEmailError extends Error {
  constructor(public readonly raw: string) {
    super('Email must be ASCII; non-ASCII addresses are not supported in Phase 1');
    this.name = 'NonAsciiEmailError';
  }
}

// Order matters: trim before NFKC, NFKC before lowercase, ASCII-check last
export function normalizeEmail(raw: string): string {
  const folded = raw.trim().normalize('NFKC').toLowerCase();
  if (!ASCII_RE.test(folded)) {
    throw new NonAsciiEmailError(raw);
  }
  return folded;
}
