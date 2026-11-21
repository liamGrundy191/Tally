import { emailSchema, passwordSchema } from '@tally/shared';
import { argon2id, hash } from 'argon2';
import type { PrismaClient } from '../generated/prisma/client.ts';

/** A problem with what the person typed, explained in plain words. */
export class AccountError extends Error {}

/** Creates an admin with an argon2id password hash; refuses an email already in use. */
export async function createAdmin(prisma: PrismaClient, emailInput: string, password: string) {
  const email = emailSchema.safeParse(emailInput);
  if (!email.success) throw new AccountError(email.error.issues[0]!.message);
  const pass = passwordSchema.safeParse(password);
  if (!pass.success) throw new AccountError(pass.error.issues[0]!.message);
  if (await prisma.user.findUnique({ where: { email: email.data } })) {
    throw new AccountError(`A user with the email ${email.data} already exists.`);
  }
  return prisma.user.create({
    data: {
      email: email.data,
      passwordHash: await hash(pass.data, { type: argon2id }),
      role: 'admin',
    },
    select: { id: true, email: true, role: true },
  });
}
