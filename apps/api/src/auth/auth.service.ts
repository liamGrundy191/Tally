import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { PrismaClient } from '../generated/prisma/client.ts';
import { SESSION_IDLE_MS, type SessionUser } from './http.ts';
import { hashToken, newToken } from './tokens.ts';

/** Section 11: lockout after 10 failures for 15 minutes. */
export const MAX_FAILURES_PER_ACCOUNT = 10;
export const LOCK_MS = 15 * 60 * 1000;
/** Failed logins from one IP address within LOCK_MS before it is refused. */
export const MAX_FAILURES_PER_IP = 50;
/** Extend a session at most once a minute, not on every request. */
const EXTEND_AFTER_MS = 60 * 1000;

const WRONG = 'Email or password is wrong.';
const minutes = (ms: number) => {
  const n = Math.max(1, Math.ceil(ms / 60000));
  return n === 1 ? '1 minute' : `${n} minutes`;
};

@Injectable()
export class AuthService {
  /** Checked against when the email is unknown, so a login takes as long either way. */
  private dummyHash?: Promise<string>;

  constructor(private readonly prisma: PrismaClient) {}

  /** Checks the password and opens a session; the same answer for a wrong email or password. */
  async login(email: string, password: string, ip: string) {
    const now = Date.now();
    const recent = await this.prisma.loginFailure.count({
      where: { ip, createdAt: { gt: new Date(now - LOCK_MS) } },
    });
    if (recent >= MAX_FAILURES_PER_IP) {
      throw new HttpException(
        'Too many failed logins from this computer. Try again in 15 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user?.lockedUntil && user.lockedUntil.getTime() > now) {
      throw new HttpException(
        `Too many wrong passwords. Try again in ${minutes(user.lockedUntil.getTime() - now)}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.dummyHash ??= hash('not a real password', { type: argon2id });
    const matches = await verify(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !matches || user.disabledAt) {
      await this.recordFailure(ip, matches ? undefined : user?.id);
      throw new UnauthorizedException(WRONG);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null },
    });
    await this.forgetOldFailures();
    // Logins are not audited: those entries would pile up outside any month (D41).
    const token = await this.openSession(user.id);
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  }

  /** Failed logins (with their IP addresses) are kept for a day only: the limit needs 15 minutes. */
  private forgetOldFailures() {
    return this.prisma.loginFailure.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
  }

  private async recordFailure(ip: string, userId?: string) {
    await this.prisma.loginFailure.create({ data: { ip } });
    await this.forgetOldFailures();
    if (!userId) return;
    // The counter is raised in the database, so two attempts at once both count.
    const { failedLogins } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLogins: { increment: 1 } },
      select: { failedLogins: true },
    });
    if (failedLogins >= MAX_FAILURES_PER_ACCOUNT) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
    }
  }

  async openSession(userId: string): Promise<string> {
    const token = newToken();
    const now = Date.now();
    await this.prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date(now) } } });
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(now + SESSION_IDLE_MS),
        lastSeenAt: new Date(now),
      },
    });
    return token;
  }

  /** The user of a valid session, or null; extends the session's idle time while it is used. */
  async userForSession(token: string): Promise<SessionUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.user.disabledAt) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (now - session.lastSeenAt.getTime() > EXTEND_AFTER_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_IDLE_MS) },
      });
    }
    const { id, email, role } = session.user;
    return { id, email, role };
  }

  async logout(token: string) {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
}
