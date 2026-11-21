// The blank printable ticket (section 9, Ticket template screen): logged-in users only.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdmin } from '../src/users/create-admin.ts';
import { Browser } from './helpers/browser.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };

describe.skipIf(!databaseUrl)('ticket template download', () => {
  const db = testDatabase();
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    await db.migrate();
    await createAdmin(db.prisma, OWNER.email, OWNER.password);
    ({ app, base } = await testApp(db));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  it('refuses a visitor who is not logged in', async () => {
    expect((await fetch(`${base}/api/templates/v1/pdf`)).status).toBe(401);
  });

  it('gives a logged-in user the PDF as a download', async () => {
    const browser = new Browser(base);
    await browser.login(OWNER.email, OWNER.password);
    const res = await fetch(`${base}/api/templates/v1/pdf`, {
      headers: { cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="tickets-v1.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  }, 60_000);
});
