// GET /api/health (section 8): open to anyone, "ok" when the database, file storage and the job
// queue answer, 503 with no details otherwise (T4.2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

describe.skipIf(!databaseUrl || !storageConfigured)('the health check', () => {
  const db = testDatabase();
  const files = testStorage();
  const apps: { close: () => Promise<void> }[] = [];

  beforeAll(async () => {
    await db.migrate();
    await files.create();
  }, 120_000);
  afterAll(async () => {
    for (const app of apps) await app.close();
    await files.drop();
    await db.drop();
  });

  async function health(storage = files.storage) {
    const { app, base } = await testApp(db, { storage });
    apps.push(app);
    return fetch(`${base}/api/health`);
  }

  it('answers "ok" with no login, and sets no cookie', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('ok');
  });

  it('answers 503, naming nothing, when file storage is not there', async () => {
    const res = await health(testStorage().storage); // a bucket that was never made
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('unavailable');
  });
});
