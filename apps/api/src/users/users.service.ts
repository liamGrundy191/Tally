import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Role } from '@tally/shared';
import { argon2id, hash } from 'argon2';
import { audit } from '../audit.ts';
import { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { hashToken, newToken } from '../auth/tokens.ts';

/** An invite link works for 7 days (Liam, D41). */
export const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const BAD_INVITE = 'This invite link is not valid or has expired. Ask for a new one.';

const publicFields = {
  id: true,
  email: true,
  role: true,
  disabledAt: true,
  createdAt: true,
} as const;

/** Invites no longer needed: used, expired, or (with an email) any other one for that email. */
const staleInvites = (email?: string) => ({
  OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }, ...(email ? [{ email }] : [])],
});

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaClient) {}

  list() {
    return this.prisma.user.findMany({ select: publicFields, orderBy: { email: 'asc' } });
  }

  /**
   * Creates an invite and returns its link, for the admin to send (there is no email sending).
   * The token is in the link's fragment (#), so it never reaches server or proxy logs.
   */
  async invite(byUserId: string, email: string, role: Role, appUrl: string) {
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('This email already has an account.');
    }
    const token = newToken();
    const invite = await this.prisma.$transaction(async (tx) => {
      // An older link for this email stops working; used and expired invites are not kept.
      await tx.invite.deleteMany({ where: staleInvites(email) });
      const created = await tx.invite.create({
        data: {
          email,
          role,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITE_MS),
        },
      });
      await audit(tx, {
        userId: byUserId,
        action: 'invite',
        entity: 'Invite',
        entityId: created.id,
        after: { role }, // not the email: this entry outlives the invite
      });
      return created;
    });
    return { inviteUrl: `${appUrl}/accept-invite#token=${token}`, expiresAt: invite.expiresAt };
  }

  /** Sets the invited person's password and creates their account; a link works once. */
  async acceptInvite(token: string, password: string) {
    const invite = await this.prisma.invite.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!invite || invite.usedAt || invite.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(BAD_INVITE);
    }
    const passwordHash = await hash(password, { type: argon2id });
    return this.prisma.$transaction(async (tx) => {
      // Only one of two clicks at once can use the link.
      const used = await tx.invite.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (used.count === 0) throw new BadRequestException(BAD_INVITE);
      if (await tx.user.findUnique({ where: { email: invite.email } })) {
        throw new ConflictException('This email already has an account.');
      }
      const user = await tx.user.create({
        data: { email: invite.email, passwordHash, role: invite.role },
        select: { id: true, email: true, role: true },
      });
      await audit(tx, {
        userId: user.id,
        action: 'accept-invite',
        entity: 'User',
        entityId: user.id,
        after: { email: user.email, role: user.role },
      });
      await tx.invite.deleteMany({ where: staleInvites() });
      return user;
    });
  }

  /** Changes a user's role or disables them; there is always at least one active admin. */
  async update(byUserId: string, id: string, change: { role?: Role; disabled?: boolean }) {
    return this.updateOnce(byUserId, id, change).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
        throw new ConflictException('Someone changed this at the same time. Please try again.');
      }
      throw e;
    });
  }

  private updateOnce(byUserId: string, id: string, change: { role?: Role; disabled?: boolean }) {
    return this.prisma.$transaction(
      async (tx) => {
        const before = await tx.user.findUnique({ where: { id }, select: publicFields });
        if (!before) throw new NotFoundException('There is no such user.');
        const role = change.role ?? before.role;
        const disabledAt =
          change.disabled === undefined ? before.disabledAt : change.disabled ? new Date() : null;
        if (before.role === 'admin' && !before.disabledAt && (role !== 'admin' || disabledAt)) {
          const otherAdmins = await tx.user.count({
            where: { role: 'admin', disabledAt: null, id: { not: id } },
          });
          if (otherAdmins === 0) {
            throw new ConflictException('There must always be at least one active admin.');
          }
        }
        const after = await tx.user.update({
          where: { id },
          // Enabling a user again also clears a wrong-password lock.
          data: {
            role,
            disabledAt,
            ...(change.disabled === false ? { failedLogins: 0, lockedUntil: null } : {}),
          },
          select: publicFields,
        });
        if (disabledAt) await tx.session.deleteMany({ where: { userId: id } }); // logged out at once
        await audit(tx, {
          userId: byUserId,
          action: 'update-user',
          entity: 'User',
          entityId: id,
          before: { role: before.role, disabled: before.disabledAt !== null },
          after: { role: after.role, disabled: after.disabledAt !== null },
        });
        return after;
        // Serializable: two admins disabling each other at once cannot both pass the last-admin check.
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
