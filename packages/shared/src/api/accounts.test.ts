import { describe, expect, it } from 'vitest';
import {
  acceptInviteSchema,
  emailSchema,
  inviteSchema,
  loginSchema,
  updateUserSchema,
} from './accounts.ts';

describe('account request rules', () => {
  it('compares emails without spaces or capital letters', () => {
    expect(emailSchema.parse('  Owner@Example.COM ')).toBe('owner@example.com');
    expect(loginSchema.parse({ email: ' A@B.com', password: 'x' }).email).toBe('a@b.com');
    expect(emailSchema.safeParse('not an email').success).toBe(false);
  });

  it('needs a new password of 12 to 200 characters, but a login only needs one typed', () => {
    expect(acceptInviteSchema.safeParse({ token: 't', password: 'x'.repeat(11) }).success).toBe(
      false,
    );
    expect(acceptInviteSchema.safeParse({ token: 't', password: 'x'.repeat(12) }).success).toBe(
      true,
    );
    expect(acceptInviteSchema.safeParse({ token: 't', password: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });

  it('accepts only the two roles, and a change must change something', () => {
    expect(inviteSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
    expect(updateUserSchema.safeParse({}).success).toBe(false);
    expect(updateUserSchema.safeParse({ disabled: true }).success).toBe(true);
  });
});
