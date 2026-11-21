// T1.2 "Done when": login success and failure, lockout, an expired session, role denial and
// invite acceptance; plus the limit per computer, CSRF, disabled users and the last admin.
// Runs the real API over HTTP against a throwaway database schema.
import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

    it('explains bad input plainly', async () => {
      expect((await browser().send('POST', '/api/auth/login', {})).status).toBe(400);
    });
  });

  describe('sessions', () => {
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
