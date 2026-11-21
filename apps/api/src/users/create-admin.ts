import { argon2id, hash } from 'argon2';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.ts';

/** PLAN section 11: at least 12 characters. The upper bound keeps hashing cheap. */
export const passwordSchema = z
  .string()
  .min(12, 'The password needs at least 12 characters.')
  .max(200, 'The password can have at most 200 characters.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('That is not a valid email address.'));

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
