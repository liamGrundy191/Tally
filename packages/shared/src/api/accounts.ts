// Request bodies for logging in and managing users (PLAN sections 8 and 11), shared by the API
// and the web app so both check them the same way. Messages are shown to the user.
import { z } from 'zod';

export const ROLES = ['admin', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('That is not a valid email address.'));

/** At least 12 characters (section 11). The upper bound keeps hashing cheap. */
export const passwordSchema = z
  .string()
  .min(12, 'The password needs at least 12 characters.')
  .max(200, 'The password can have at most 200 characters.');

/** Login checks only that something was typed: the length rule applies when a password is set. */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().min(1).max(200),
});

export const inviteSchema = z.object({ email: emailSchema, role: z.enum(ROLES) });

export const acceptInviteSchema = z.object({
  token: z.string().min(1).max(200),
  password: passwordSchema,
});

export const updateUserSchema = z
  .object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional() })
  .refine((u) => u.role !== undefined || u.disabled !== undefined, 'Nothing to change.');
