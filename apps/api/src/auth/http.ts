// The small part of Express's request and response that the API uses, and its cookies.
import type { Role } from '@tally/shared';

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
}

export interface Req {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  /** Set by the access guard for a logged-in request. */
  user?: SessionUser;
  sessionToken?: string;
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge?: number;
}

export interface Res {
  cookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string, options: CookieOptions): void;
}

export const SESSION_COOKIE = 'tally_session';
export const CSRF_COOKIE = 'tally_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Section 11: idle expiry 12 hours. The home laptop (D62) sets SESSION_IDLE_DAYS=30, so its one
 * user logs in about once a month; never past the session cookie's own 30 days.
 */
export function sessionIdleMs(days: string | undefined): number {
  if (!days) return 12 * 60 * 60 * 1000;
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    throw new Error('SESSION_IDLE_DAYS must be a whole number of days from 1 to 30.');
  }
  return n * 24 * 60 * 60 * 1000;
}
export const SESSION_IDLE_MS = sessionIdleMs(process.env.SESSION_IDLE_DAYS);

const base = { secure: true, sameSite: 'lax', path: '/' } as const;
/**
 * Script cannot read the session cookie; the CSRF cookie must be read by the web app. The
 * cookie may outlive the session: the server enforces the 12-hour idle expiry, so closing the
 * browser does not log anyone out early.
 */
export const sessionCookie: CookieOptions = {
  ...base,
  httpOnly: true,
  maxAge: 30 * 24 * 60 * 60 * 1000,
};
/** Lives as long as the session cookie: without it, every change would be refused after the
 * browser is closed and reopened. */
export const csrfCookie: CookieOptions = { ...base, httpOnly: false, maxAge: sessionCookie.maxAge };

export function readCookie(req: Req, name: string): string | undefined {
  const header = req.headers.cookie;
  for (const part of (Array.isArray(header) ? header.join(';') : (header ?? '')).split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
