// T1.2 "Done when": login success and failure, lockout, an expired session, role denial and
// invite acceptance; plus the limit per computer, CSRF, disabled users and the last admin.
// Runs the real API over HTTP against a throwaway database schema.
import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionIdleMs } from '../src/auth/http.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

@Controller('forgotten')
class RouteWithoutAccessRule {
  @Get()
  open() {
    return 'should never be reached';
  }
}

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const WRONG = 'Email or password is wrong.';

describe.skipIf(!databaseUrl)('logging in (T1.2)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  let app: INestApplication;
  let base: string;
  const browser = () => new Browser(base);

  /** Invites `email` as a reviewer and accepts; returns the logged-in browser. */
  async function reviewer(email: string, password = 'reviewer password') {
    const admin = browser();
    await admin.login(OWNER.email, OWNER.password);
    const { body } = await admin.send('POST', '/api/users/invite', { email, role: 'reviewer' });
    const r = browser();
    const accepted = await r.send('POST', '/api/auth/accept-invite', {
      token: tokenOf(body.inviteUrl),
      password,
    });
    expect(accepted.status).toBe(200);
    return { admin, reviewer: r, id: accepted.body.id as string };
  }
  const tokenOf = (inviteUrl: string) => inviteUrl.split('#token=')[1]!;

  beforeAll(async () => {
    await db.migrate();
    await createAdmin(prisma, OWNER.email, OWNER.password);
    ({ app, base } = await testApp(db, { controllers: [RouteWithoutAccessRule] }));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.loginFailure.deleteMany();
    await prisma.user.updateMany({ data: { failedLogins: 0, lockedUntil: null } });
  });

  describe('login', () => {
    it('logs in with the right password and stays logged in', async () => {
      const b = browser();
      const res = await b.login(' Owner@Example.com ', OWNER.password);
      expect(res).toMatchObject({ status: 200, body: { email: OWNER.email, role: 'admin' } });
      const session = b.lastSetCookies.find((c) => c.startsWith('tally_session='))!;
      expect(session).toMatch(/HttpOnly/);
      expect(session).toMatch(/Secure/);
      expect(session).toMatch(/SameSite=Lax/);
      const csrf = b.lastSetCookies.find((c) => c.startsWith('tally_csrf='))!;
      expect(csrf).not.toMatch(/HttpOnly/); // the web app must read it
      expect((await b.send('GET', '/api/auth/me')).body).toMatchObject({ email: OWNER.email });
      // Only a hash of the session key is stored.
      const stored = await prisma.session.findMany({ select: { tokenHash: true } });
      expect(stored.map((s) => s.tokenHash)).not.toContain(b.cookies.get('tally_session'));
    });

    it('gives the same answer for a wrong password and an unknown email, and no session', async () => {
      const b = browser();
      const wrong = await b.login(OWNER.email, 'not the password');
      const unknown = await b.login('nobody@example.com', OWNER.password);
      expect(wrong).toMatchObject({ status: 401, body: { message: WRONG } });
      expect(unknown).toMatchObject({ status: 401, body: { message: WRONG } });
      expect(b.cookies.has('tally_session')).toBe(false);
      expect((await b.send('GET', '/api/auth/me')).status).toBe(401);
    });

    it('locks the account for 15 minutes after 10 wrong passwords', async () => {
      const b = browser();
      for (let i = 0; i < 10; i++)
        expect((await b.login(OWNER.email, `wrong ${i}`)).status).toBe(401);
      const locked = await b.login(OWNER.email, OWNER.password); // even the right password
      expect(locked.status).toBe(429);
      expect(locked.body.message).toMatch(/Too many wrong passwords\. Try again in 15 minutes/);
      // 15 minutes later:
      await prisma.user.update({
        where: { email: OWNER.email },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      expect((await b.login(OWNER.email, OWNER.password)).status).toBe(200);
      const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER.email } });
      expect(owner).toMatchObject({ failedLogins: 0, lockedUntil: null });
    });

    it('starts counting again after a good login', async () => {
      const b = browser();
      for (let i = 0; i < 9; i++) await b.login(OWNER.email, 'wrong');
      expect((await b.login(OWNER.email, OWNER.password)).status).toBe(200);
      for (let i = 0; i < 9; i++) await b.login(OWNER.email, 'wrong');
      expect((await b.login(OWNER.email, OWNER.password)).status).toBe(200);
    });

    it('refuses a computer after 50 failed logins in 15 minutes, whatever the account', async () => {
      const b = browser();
      await b.login('nobody@example.com', 'wrong');
      const { ip } = await prisma.loginFailure.findFirstOrThrow();
      await prisma.loginFailure.createMany({ data: Array.from({ length: 49 }, () => ({ ip })) });
      const refused = await b.login(OWNER.email, OWNER.password);
      expect(refused).toMatchObject({ status: 429 });
      expect(refused.body.message).toMatch(/from this computer/);
      // Older failures do not count.
      await prisma.loginFailure.updateMany({
        data: { createdAt: new Date(Date.now() - 16 * 60_000) },
      });
      expect((await b.login(OWNER.email, OWNER.password)).status).toBe(200);
    });

    it('counts failures per computer behind the proxy, and does not believe a forged address', async () => {
      const login = (forwardedFor: string, password = 'wrong') =>
        fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
          body: JSON.stringify({ email: OWNER.email, password }),
        });
      const first = await login('203.0.113.9');
      expect(first.status).toBe(401);
      expect(first.headers.get('x-powered-by')).toBeNull();
      expect((await prisma.loginFailure.findFirstOrThrow()).ip).toBe('203.0.113.9');
      await prisma.loginFailure.createMany({
        data: Array.from({ length: 49 }, () => ({ ip: '203.0.113.9' })),
      });
      expect((await login('203.0.113.9', OWNER.password)).status).toBe(429);
      expect((await login('198.51.100.7', OWNER.password)).status).toBe(200);
      // An address added in front of the one the proxy saw is not believed.
      expect((await login('203.0.113.9, 198.51.100.7', OWNER.password)).status).toBe(200);
    });

    it('refuses a login sent by a form on another site', async () => {
      const send = (type: string, body: string) =>
        fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': type },
          body,
        });
      const form = new URLSearchParams(OWNER).toString();
      for (const res of [
        await send('application/x-www-form-urlencoded', form),
        await send('text/plain', JSON.stringify(OWNER)),
      ]) {
        expect(res.status).toBe(403);
        expect(res.headers.getSetCookie()).toEqual([]);
      }
      expect((await send('application/json; charset=utf-8', JSON.stringify(OWNER))).status).toBe(
        200,
      );
    });

    it('explains bad input plainly', async () => {
      expect((await browser().send('POST', '/api/auth/login', {})).status).toBe(400);
    });
  });

  describe('sessions', () => {
    it('lasts 12 hours without use, or SESSION_IDLE_DAYS on the home laptop', () => {
      expect(sessionIdleMs(undefined)).toBe(12 * 60 * 60 * 1000);
      expect(sessionIdleMs('30')).toBe(30 * 24 * 60 * 60 * 1000);
      for (const bad of ['0', '31', '1.5', 'thirty']) expect(() => sessionIdleMs(bad)).toThrow();
    });

    it('ends a session after 12 hours without use', async () => {
      const b = browser();
      await b.login(OWNER.email, OWNER.password);
      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const before = await prisma.session.count();
      expect((await b.send('GET', '/api/auth/me')).status).toBe(401);
      expect(await prisma.session.count()).toBe(before - 1); // the expired session is removed
    });

    it('extends a session while it is used', async () => {
      await prisma.session.deleteMany();
      const b = browser();
      await b.login(OWNER.email, OWNER.password);
      await prisma.session.updateMany({
        data: {
          lastSeenAt: new Date(Date.now() - 2 * 60_000),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect((await b.send('GET', '/api/auth/me')).status).toBe(200);
      const { expiresAt } = await prisma.session.findFirstOrThrow();
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60_000);
    });

    it('logs out: the session ends on the server, not just in the browser', async () => {
      const b = browser();
      await b.login(OWNER.email, OWNER.password);
      const key = b.cookies.get('tally_session')!;
      expect((await b.send('POST', '/api/auth/logout')).status).toBe(204);
      expect(b.cookies.has('tally_session')).toBe(false);
      b.cookies.set('tally_session', key); // an old copy of the cookie
      expect((await b.send('GET', '/api/auth/me')).status).toBe(401);
    });

    it('refuses a change without the right CSRF token, and stays logged in', async () => {
      const b = browser();
      await b.login(OWNER.email, OWNER.password);
      expect((await b.send('POST', '/api/auth/logout', undefined, { csrf: false })).status).toBe(
        403,
      );
      expect((await b.send('POST', '/api/auth/logout', undefined, { csrf: 'forged' })).status).toBe(
        403,
      );
      expect((await b.send('GET', '/api/auth/me')).status).toBe(200);
    });

    it('gives a new CSRF token at every login, so one planted earlier is useless', async () => {
      const b = browser();
      b.cookies.set('tally_csrf', 'planted');
      await b.login(OWNER.email, OWNER.password);
      expect(b.cookies.get('tally_csrf')).not.toBe('planted');
      expect((await b.send('POST', '/api/auth/logout')).status).toBe(204);
    });

    it('keeps working after the browser is closed and reopened', async () => {
      const b = browser();
      await b.login(OWNER.email, OWNER.password);
      // Both cookies outlive the browser, so a reopened browser still has its CSRF token.
      const csrf = b.lastSetCookies.find((c) => c.startsWith('tally_csrf='))!;
      expect(csrf).toMatch(/Max-Age=\d+/);
      // A browser that lost it anyway gets a new one from /auth/me, and can make changes again.
      b.cookies.delete('tally_csrf');
      expect((await b.send('POST', '/api/auth/logout')).status).toBe(403);
      expect((await b.send('GET', '/api/auth/me')).status).toBe(200);
      expect(b.cookies.has('tally_csrf')).toBe(true);
      expect((await b.send('POST', '/api/auth/logout')).status).toBe(204);
    });

    it('keeps failed logins, with their addresses, for a day only', async () => {
      await prisma.loginFailure.create({
        data: { ip: '203.0.113.9', createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      });
      expect((await browser().login(OWNER.email, OWNER.password)).status).toBe(200);
      expect(await prisma.loginFailure.count({ where: { ip: '203.0.113.9' } })).toBe(0);
    });
  });

  describe('roles', () => {
    it('refuses everyone not logged in, and reviewers on admin routes', async () => {
      expect((await browser().send('GET', '/api/users')).status).toBe(401);
      const { reviewer: r } = await reviewer('roles@example.com');
      expect((await r.send('GET', '/api/auth/me')).body).toMatchObject({ role: 'reviewer' });
      expect((await r.send('GET', '/api/users')).status).toBe(403);
      expect(
        (await r.send('POST', '/api/users/invite', { email: 'x@example.com', role: 'admin' }))
          .status,
      ).toBe(403);
    });

    it('refuses a route that forgot to declare who may use it, even for an admin', async () => {
      const b = browser();
      await b.login(OWNER.email, OWNER.password);
      expect((await b.send('GET', '/api/forgotten')).status).toBe(403);
    });
  });

  describe('invites', () => {
    it('lets an invited person set a password once, and logs them in', async () => {
      const admin = browser();
      await admin.login(OWNER.email, OWNER.password);
      const invited = await admin.send('POST', '/api/users/invite', {
        email: 'New@Example.com',
        role: 'reviewer',
      });
      expect(invited.status).toBe(201);
      expect(invited.body.inviteUrl).toMatch(/\/accept-invite#token=/);
      const token = tokenOf(invited.body.inviteUrl);
      const b = browser();
      const short = await b.send('POST', '/api/auth/accept-invite', { token, password: 'short' });
      expect(short).toMatchObject({ status: 400, body: { message: /at least 12 characters/ } });
      const ok = await b.send('POST', '/api/auth/accept-invite', {
        token,
        password: 'my own password',
      });
      expect(ok).toMatchObject({
        status: 200,
        body: { email: 'new@example.com', role: 'reviewer' },
      });
      expect((await b.send('GET', '/api/auth/me')).status).toBe(200);
      const again = await browser().send('POST', '/api/auth/accept-invite', {
        token,
        password: 'another password',
      });
      expect(again.status).toBe(400);
      expect((await browser().login('new@example.com', 'my own password')).status).toBe(200);
      const actions = await prisma.auditEntry.findMany({ select: { action: true } });
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining(['invite', 'accept-invite']),
      );
    });

    it('refuses an expired invite, an old link after a new invite, and an email in use', async () => {
      const admin = browser();
      await admin.login(OWNER.email, OWNER.password);
      const invite = async (email: string) =>
        tokenOf(
          (await admin.send('POST', '/api/users/invite', { email, role: 'reviewer' })).body
            .inviteUrl,
        );
      const accept = (token: string) =>
        browser().send('POST', '/api/auth/accept-invite', { token, password: 'long enough pass' });

      const expired = await invite('late@example.com');
      await prisma.invite.updateMany({
        where: { email: 'late@example.com' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await accept(expired)).status).toBe(400);

      const first = await invite('twice@example.com');
      const second = await invite('twice@example.com');
      expect((await accept(first)).status).toBe(400);
      expect((await accept(second)).status).toBe(200);

      const inUse = await admin.send('POST', '/api/users/invite', {
        email: OWNER.email,
        role: 'admin',
      });
      expect(inUse.status).toBe(409);
      // Used and expired invites are not kept, and the audit trail keeps no invited email.
      expect(await prisma.invite.count({ where: { email: 'late@example.com' } })).toBe(0);
      expect(await prisma.invite.count({ where: { usedAt: { not: null } } })).toBe(0);
      const audited = await prisma.auditEntry.findMany({ where: { action: 'invite' } });
      expect(JSON.stringify(audited)).not.toMatch(/@example\.com/);
    });
  });

  describe('managing users', () => {
    it('disabling a user logs them out at once and stops their login', async () => {
      const { admin, reviewer: r, id } = await reviewer('leaver@example.com', 'leaver password');
      expect((await admin.send('PATCH', `/api/users/${id}`, { disabled: true })).status).toBe(200);
      expect((await r.send('GET', '/api/auth/me')).status).toBe(401);
      const login = await browser().login('leaver@example.com', 'leaver password');
      expect(login).toMatchObject({ status: 401, body: { message: WRONG } });
      expect((await admin.send('PATCH', `/api/users/${id}`, { disabled: false })).status).toBe(200);
      expect((await browser().login('leaver@example.com', 'leaver password')).status).toBe(200);
    });

    it('enabling a user again also clears a wrong-password lock', async () => {
      const { admin, id } = await reviewer('locked@example.com', 'locked password');
      expect((await admin.send('PATCH', `/api/users/${id}`, { disabled: true })).status).toBe(200);
      await prisma.user.update({
        where: { id },
        data: { failedLogins: 3, lockedUntil: new Date(Date.now() + 3600_000) },
      });
      expect((await admin.send('PATCH', `/api/users/${id}`, { disabled: false })).status).toBe(200);
      expect((await browser().login('locked@example.com', 'locked password')).status).toBe(200);
    });

    it('a role change counts from the next request, and only an admin can make it', async () => {
      const { admin, reviewer: r, id } = await reviewer('promoted@example.com');
      expect((await r.send('PATCH', `/api/users/${id}`, { role: 'admin' })).status).toBe(403);
      expect((await admin.send('PATCH', `/api/users/${id}`, { role: 'admin' })).status).toBe(200);
      expect((await r.send('GET', '/api/users')).status).toBe(200);
      expect((await admin.send('PATCH', `/api/users/${id}`, { role: 'reviewer' })).status).toBe(
        200,
      );
      expect((await r.send('GET', '/api/users')).status).toBe(403);
    });

    it('says what to do when the invited email already has an account', async () => {
      const { admin } = await reviewer('taken@example.com');
      const again = await admin.send('POST', '/api/users/invite', {
        email: 'taken@example.com',
        role: 'reviewer',
      });
      expect(again).toMatchObject({
        status: 409,
        body: {
          message:
            'This email already has an account. If it is disabled, enable it in the list above.',
        },
      });
    });

    it('keeps at least one active admin', async () => {
      const admin = browser();
      const { body: me } = await admin.login(OWNER.email, OWNER.password);
      const selfDisable = await admin.send('PATCH', `/api/users/${me.id}`, { disabled: true });
      expect(selfDisable).toMatchObject({
        status: 409,
        body: { message: /at least one active admin/ },
      });
      expect((await admin.send('PATCH', `/api/users/${me.id}`, { role: 'reviewer' })).status).toBe(
        409,
      );
      expect((await admin.send('GET', '/api/auth/me')).body).toMatchObject({ role: 'admin' });
    });

    it('lists users without their password hashes, and refuses a made-up user id', async () => {
      const admin = browser();
      await admin.login(OWNER.email, OWNER.password);
      const { body } = await admin.send('GET', '/api/users');
      expect(body.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|argon2/);
      expect((await admin.send('PATCH', '/api/users/not-an-id', { disabled: true })).status).toBe(
        404,
      );
      expect(
        (
          await admin.send('PATCH', '/api/users/00000000-0000-4000-8000-000000000000', {
            disabled: true,
          })
        ).status,
      ).toBe(404);
    });
  });
});
