// The browser test's tickets (pnpm e2e, T2.3): three fixture scans read by the real API and
// worker with the fake reader, into the database `tally_e2e` (wiped first) and the bucket
// `tally-e2e` (kept; old page images there are never read again). Never the dev database. Runs
// only through vitest.e2e-seed.config.ts (`pnpm e2e`), which sets E2E_SEED; skipped otherwise.
// The names and login are invented; apps/web/e2e/review.e2e.ts uses the same ones.
import { AGENCY_TIME_ZONE, todayIn, type UploadResult } from '@tally/shared';
import { FakeExtractor, type TicketExtractor } from '@tally/shared/extraction';
import { expect, it } from 'vitest';
import { createPrisma } from '../src/db.ts';
import { ReadingConfig } from '../src/reading/config.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { startWorker } from '../src/worker.ts';
import { Browser } from './helpers/browser.ts';
import { slipsPdf } from './helpers/slips.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrlFor, testDatabase } from './helpers/test-db.ts';
import { testStorage } from './helpers/test-storage.ts';

const DATABASE = 'tally_e2e';
const BUCKET = 'tally-e2e';
const USER = { email: 'e2e@example.com', password: 'e2e password 1' };
/** The pages of the one scan, in order: a disputed reading, a crossed-out ticket, a failed one. */
const PAGES = ['disputed', 'voided', 'broken'];
const fixtures = new FakeExtractor(new URL('../../../fixtures/extractions/', import.meta.url));

/** Yesterday in Israel as DD/MM/YY, so the fixtures' dates raise no date flag on any day. */
function yesterday() {
  const day = new Date(`${todayIn(AGENCY_TIME_ZONE)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  const [y, m, d] = day.toISOString().slice(0, 10).split('-');
  return `${d}/${m}/${y!.slice(2)}`;
}

it.runIf(process.env.E2E_SEED === '1')(
  'seeds the browser test’s database',
  async () => {
    const server = createPrisma(databaseUrlFor('postgres'));
    const found = await server.$queryRaw<
      unknown[]
    >`SELECT 1 FROM pg_database WHERE datname = ${DATABASE}`;
    if (found.length === 0) await server.$executeRawUnsafe(`CREATE DATABASE "${DATABASE}"`);
    await server.$disconnect();

    const db = testDatabase(DATABASE);
    const prisma = db.prisma;
    // Only ever this database: everything in it is the test's own.
    expect(new URL(db.url).pathname).toBe(`/${DATABASE}`);
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
    await db.migrate();
    const files = testStorage(BUCKET);
    await files.create().catch((e: Error) => {
      if (!/BucketAlready/.test(e.name)) throw e;
    });
    await createAdmin(prisma, USER.email, USER.password);

    const date = yesterday();
    const extractor: TicketExtractor = {
      async extract(input, template, pass) {
        const { pageIndex } = await prisma.ticket.findUniqueOrThrow({ where: { id: input.id } });
        const answer = await fixtures.extract({ ...input, id: PAGES[pageIndex]! }, template, pass);
        const field = answer.result.fields.date;
        if (field.value !== null) field.value = date;
        return answer;
      },
    };
    const config = new ReadingConfig(
      () => extractor,
      () => ({
        today: todayIn(AGENCY_TIME_ZONE),
        minShiftHours: 2,
        maxShiftHours: 16,
        maxDateAgeDays: 45,
      }),
      false,
      1,
    );
    const { app, base } = await testApp(db, { storage: files.storage, reading: config });
    try {
      await startWorker(app);
      const owner = new Browser(base);
      await owner.login(USER.email, USER.password);
      const [{ key, url }] = (await owner.send('POST', '/api/uploads/sign', { count: 1 })).body;
      await fetch(url, { method: 'PUT', body: await slipsPdf(PAGES.length, 'e2e week') });
      const done = await owner.send('POST', '/api/uploads/complete', {
        speed: 'now',
        files: [{ key, name: 'week.pdf' }],
      });
      expect((done.body as UploadResult[])[0]!.status).toBe('queued');
      // Read, and the dated ones sorted into their workplace by the organiser.
      for (const end = Date.now() + 90_000; ;) {
        const tickets = await prisma.ticket.findMany({ orderBy: { pageIndex: 'asc' } });
        const ready =
          tickets.length === PAGES.length &&
          tickets.every((t) => t.status !== 'processing' && (!t.monthId || t.workplaceGroupId));
        if (ready) {
          expect(tickets.map((t) => t.status)).toEqual([
            'needs_review',
            'needs_review',
            'needs_manual_entry',
          ]);
          break;
        }
        if (Date.now() > end) throw new Error('The fixture tickets were not read in time.');
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  },
  180_000,
);
