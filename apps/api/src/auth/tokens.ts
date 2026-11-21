import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A long random secret for a session, invite or CSRF token (256 bits). */
export const newToken = () => randomBytes(32).toString('base64url');

/** Tokens are stored only as hashes, so a copy of the database cannot be used to log in. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Compares two secrets without leaking how much of them matched. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
