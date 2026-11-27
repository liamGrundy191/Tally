// T1.4 "Done when": the worker reads the fixture tickets with the fake reader, and every ticket
// ends in the expected status with the expected flags; a worker stopped mid-run finishes after
// a restart without duplicates. Plus tickets joining their month (6c). Runs the real API and
// worker against a throwaway database schema and storage bucket; never the real reader.
import type { INestApplication } from '@nestjs/common';
import type { UploadResult } from '@tally/shared';
import { FakeExtractor, type TicketExtractor } from '@tally/shared/extraction';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReadingConfig } from '../src/reading/config.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { startWorker } from '../src/worker.ts';
import { Browser } from './helpers/browser.ts';
import { slipsPdf } from './helpers/slips.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const fixtures = new FakeExtractor(new URL('../../../fixtures/extractions/', import.meta.url));

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting.');
}

describe.skipIf(!databaseUrl || !storageConfigured)('reading tickets (T1.4)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const files = testStorage();
  let app: INestApplication;
  let owner: Browser;

  /** Which prepared answers each test file's pages get, by file name. */
  const script: Record<string, string[]> = {};
  /** Every answer the fake reader gave ("<ticket id>:A"): what would have been paid for. */
  const answered: string[] = [];
  let stopAfter: number | null = null; // the worker "dies" after this many answers
  const extractor: TicketExtractor = {
    async extract(input, template, pass) {
      const ticket = await prisma.ticket.findUniqueOrThrow({
        where: { id: input.id },
        include: { upload: true },
      });
      const name = script[ticket.upload.originalFilename]![ticket.pageIndex]!;
      if (stopAfter !== null && answered.length >= stopAfter) {
        stopAfter = null;
        throw Object.assign(new Error('the worker stopped'), { status: 401 }); // ends the job
      }
      const answer = await fixtures.extract({ ...input, id: name }, template, pass);
      answered.push(`${input.id}:${pass}`);
      return answer;
    },
  };
  const speeds: string[] = []; // the speed each reading job asked for
  const config = new ReadingConfig(
    (speed) => (speeds.push(speed), extractor),
    () => ({ today: '2026-11-21', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 }),
    false,
    1, // retry quickly in tests
  ) as ReadingConfig & { reviewEverything: boolean };

  /** Uploads a scan whose pages get the named prepared answers, and waits until it is read. */
  async function read(name: string, answers: string[], speed: 'now' | 'batch' = 'now') {
    script[name] = answers;
    const [{ key, url }] = (await owner.send('POST', '/api/uploads/sign', { count: 1 })).body;
    await fetch(url, { method: 'PUT', body: await slipsPdf(answers.length, name) });
    const done = await owner.send('POST', '/api/uploads/complete', {
      speed,
      files: [{ key, name }],
    });
    const result = (done.body as UploadResult[])[0]!;
    expect(result.status).toBe('queued');
    const uploadId = (result as { uploadId: string }).uploadId;
    await until(
      async () =>
        (await prisma.ticket.count({ where: { uploadId, status: { not: 'processing' } } })) ===
        answers.length,
    );
    return prisma.ticket.findMany({
      where: { uploadId },
      include: { flags: { orderBy: [{ code: 'asc' }, { field: 'asc' }] }, month: true },
      orderBy: { pageIndex: 'asc' },
    });
  }
  const codes = (t: { flags: { code: string; field: string | null }[] }) =>
    t.flags.map((f) => (f.field ? `${f.code}:${f.field}` : f.code));

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    let base: string;
    ({ app, base } = await testApp(db, { storage: files.storage, reading: config }));
    owner = new Browser(base);
    await owner.login(OWNER.email, OWNER.password);
    // The fixtures' worker, so a clear Hebrew name has its English spelling (5.2).
    await prisma.listEntry.create({ data: { kind: 'name', name: 'Yael', spellings: ['יעל'] } });
    await startWorker(app);
  }, 120_000);

  // Each test starts without the others' tickets, which would be possible duplicates of its own.
  beforeEach(() => prisma.upload.deleteMany());

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  it('reads every ticket and saves its status, values, flags and month', async () => {
    const [clean, disputed, broken, voided] = await read('week 1.pdf', [
      'clean',
      'disputed',
      'broken',
      'voided',
    ]);
    // Clear on both readings, nothing wrong: verified, in November.
    expect(clean).toMatchObject({
      status: 'verified',
      verifiedHow: 'auto',
      firstName: 'יעל',
      workerName: 'Yael',
      workplaceRaw: 'סופר פארם',
      shiftDate: new Date('2026-11-10'),
      startMinutes: 8 * 60,
      endMinutes: 16 * 60 + 30,
      totalMinutes: 8 * 60 + 30,
      month: { year: 2026, month: 11 },
    });
    expect(codes(clean!)).toEqual([]);
    // The readings disagree and the total is overwritten: a person decides.
    expect(disputed).toMatchObject({ status: 'needs_review', verifiedHow: null });
    expect(codes(disputed!)).toEqual(EXPECTED_DISPUTED);
    // An answer that never fits the format, even after retries: typed in by a person.
    expect(broken).toMatchObject({ status: 'needs_manual_entry', monthId: null });
    expect(codes(broken!)).toEqual(['EXTRACTION_ERROR']);
    // Crossed out: a person confirms it should be excluded.
    expect(voided).toMatchObject({ status: 'needs_review' });
    expect(codes(voided!)).toContain('VOIDED_TICKET');
  });

  it('with REVIEW_EVERYTHING, a ticket with no flags still waits for one click', async () => {
    config.reviewEverything = true;
    try {
      const [t] = await read('week 2.pdf', ['clean']);
      expect(t).toMatchObject({ status: 'needs_review', verifiedHow: null });
      expect(codes(t!)).toEqual([]);
    } finally {
      config.reviewEverything = false;
    }
  });

  it('never reads other tickets: each page waits to be typed in (D68)', async () => {
    const [{ key, url }] = (await owner.send('POST', '/api/uploads/sign', { count: 1 })).body;
    await fetch(url, { method: 'PUT', body: await slipsPdf(2, 'other tickets.pdf') });
    const paid = answered.length;
    const done = await owner.send('POST', '/api/uploads/complete', {
      freeForm: true,
      files: [{ key, name: 'other tickets.pdf' }],
    });
    const { uploadId } = (done.body as { uploadId: string }[])[0]!;
    const tickets = await until(async () => {
      const found = await prisma.ticket.findMany({ where: { uploadId } });
      return found.length === 2 && found;
    });
    for (const t of tickets) {
      expect(t).toMatchObject({ status: 'needs_manual_entry', freeForm: true, monthId: null });
    }
    // The upload's reading job has run and found nothing to read.
    await until(
      async () =>
        (await prisma.upload.findUnique({ where: { id: uploadId } }))?.s3KeyOriginal === null,
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(answered.length).toBe(paid);
    expect(await prisma.reading.count({ where: { ticket: { uploadId } } })).toBe(0);
  });

  it('without REVIEW_EVERYTHING, a ticket on the 57 list still waits for a person (D67)', async () => {
    const entry = await prisma.listEntry.create({
      data: { kind: 'rate57', name: 'Yael', spellings: ['סופר פארם'] },
    });
    try {
      const [t] = await read('week 2b.pdf', ['clean']);
      expect(t).toMatchObject({ status: 'needs_review', verifiedHow: null, workerName: 'Yael' });
      expect(codes(t!)).toEqual([]);
    } finally {
      await prisma.listEntry.delete({ where: { id: entry.id } });
    }
  });

  it('never takes a Hebrew-only names list line as the English name', async () => {
    // "יעל" alone on the names list: an entry with no English spelling.
    const yael = await prisma.listEntry.findFirstOrThrow({ where: { name: 'Yael' } });
    await prisma.listEntry.delete({ where: { id: yael.id } });
    await prisma.listEntry.create({ data: { kind: 'name', name: 'יעל', spellings: [] } });
    try {
      const [t] = await read('hebrew only.pdf', ['clean']);
      expect(t).toMatchObject({ workerName: null, status: 'needs_review' });
      expect(codes(t!)).toContain('NAME_NOT_CONFIRMED:firstName');
    } finally {
      await prisma.listEntry.deleteMany({ where: { kind: 'name' } });
      await prisma.listEntry.create({
        data: { kind: 'name', name: 'Yael', spellings: ['יעל'] },
      });
    }
  });

  it('does not pick between two listed names that share a Hebrew spelling', async () => {
    const other = await prisma.listEntry.create({
      data: { kind: 'name', name: 'Yaelle', spellings: ['יעל'] },
    });
    try {
      const [t] = await read('shared spelling.pdf', ['clean']);
      expect(t).toMatchObject({ workerName: null });
      expect(t!.status).not.toBe('verified');
      expect(codes(t!)).toContain('NAME_NOT_CONFIRMED:firstName');
    } finally {
      await prisma.listEntry.delete({ where: { id: other.id } });
    }
  });

  it('reads in batch mode the same way', async () => {
    const [t] = await read('week 3.pdf', ['clean'], 'batch');
    expect(t).toMatchObject({ status: 'verified' });
  });

  it('keeps a ticket dated in a closed month out of it, with MONTH_CLOSED', async () => {
    await prisma.month.update({
      where: { year_month: { year: 2026, month: 11 } },
      data: { status: 'closed' },
    });
    try {
      const [t] = await read('late.pdf', ['clean']);
      expect(t).toMatchObject({ status: 'needs_review', monthId: null });
      expect(codes(t!)).toEqual(['MONTH_CLOSED:date']);
    } finally {
      await prisma.month.update({
        where: { year_month: { year: 2026, month: 11 } },
        data: { status: 'open' },
      });
    }
  });

  it('finishes after the worker stops mid-run, without paying twice or duplicating', async () => {
    answered.length = 0;
    stopAfter = 3; // dies after three answers, in the middle of the first round
    const tickets = await read('restart.pdf', ['clean', 'disputed', 'voided']);
    expect(tickets.map((t) => t.status)).toEqual(['verified', 'needs_review', 'needs_review']);
    // Every answer was paid for once: the restarted job reused the saved ones.
    expect(new Set(answered).size).toBe(answered.length);
    const readings = await prisma.reading.count({
      where: { ticketId: { in: tickets.map((t) => t.id) } },
    });
    expect(readings).toBe(answered.length);
    expect(codes(tickets[1]!)).toEqual(EXPECTED_DISPUTED);
    expect(tickets[0]!.flags).toEqual([]);
  }, 90_000);

  describe('reading a ticket again (T1.6)', () => {
    const reprocess = (t: { id: string; version: number }) =>
      owner.send('POST', `/api/tickets/${t.id}/reprocess`, { version: t.version });
    const readAgain = (id: string) =>
      until(async () => {
        const t = await prisma.ticket.findUniqueOrThrow({
          where: { id },
          include: { flags: true },
        });
        return t.status !== 'processing' && t;
      });

    it('reads it straight away from its scan, paying for new answers', async () => {
      const [t] = await read('again.pdf', ['voided'], 'batch');
      expect(t!.version).toBe(1); // the reading itself is a change a review must not overwrite
      expect(codes(t!)).toContain('VOIDED_TICKET');
      script['again.pdf'] = ['clean'];
      answered.length = 0;
      speeds.length = 0;
      expect((await reprocess(t!)).status).toBe(204);
      const again = await readAgain(t!.id);
      // Clean, but read again at a person's request: it comes back to them (D70).
      expect(again).toMatchObject({ status: 'needs_review', readRound: 1, version: 3 });
      expect(again.flags).toEqual([]); // the open question went with the old reading
      expect(answered.sort()).toEqual([`${t!.id}:A`, `${t!.id}:B`]);
      expect(speeds).toEqual(['now']);

      // A review opened before the new reading cannot save over it.
      const save = await owner.send('PUT', `/api/tickets/${t!.id}`, {
        version: 2,
        values: {
          firstName: 'יעל',
          workplace: 'סופר פארם',
          date: '10/11/2026',
          startTime: '08:00',
          endTime: '16:30',
          totalWorked: '08:30',
        },
        workerName: 'Yael',
      });
      expect(save.status).toBe(409);
      const audit = await prisma.auditEntry.findMany({ where: { action: 'reprocess-ticket' } });
      expect(audit.map((a) => a.entityId)).toEqual([t!.id]);
    });

    it('reads one ticket of an upload again at a time, and never a removed one', async () => {
      const [a, b] = await read('two.pdf', ['clean', 'disputed']);
      const answers = await Promise.all([reprocess(a!), reprocess(b!)]);
      expect(answers.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(JSON.stringify(answers)).toContain('This upload is still being read.');
      await readAgain(a!.id);
      await readAgain(b!.id);

      const removed = await prisma.ticket.update({
        where: { id: b!.id },
        data: { status: 'excluded' },
      });
      expect((await reprocess(removed)).status).toBe(409);
    });
  });
});

/**
 * The "disputed" answers: pass A sees the total overwritten, pass B cannot read the end time, the
 * two read the total differently, and 22:00 to 06:00 is 8:00, not the 8:30 written.
 */
const EXPECTED_DISPUTED = [
  'CORRECTION_MARKS:totalWorked',
  'FIELD_UNREADABLE:endTime',
  'NAME_NOT_CONFIRMED:firstName', // a clear Hebrew name with no English spelling on the list
  'PASS_DISAGREEMENT:totalWorked',
  'TIME_MATH_MISMATCH:totalWorked',
];
