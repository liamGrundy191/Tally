// T1.6 "Done when": a correction, a stale save (409), and resolving every flag type. Plus
// confirming, accepting a value as written, removing a ticket, and the progress of uploads.
// Runs the real API over HTTP on a throwaway database schema. Names are invented.
import type { INestApplication } from '@nestjs/common';
import { FLAG_CODES, type FlagCode } from '@tally/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { monthOf } from '../src/months/months.service.ts';
import { Organiser, lockMonth } from '../src/months/organiser.ts';
import { ReadingConfig } from '../src/reading/config.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { imageToJpeg, pdfToImages } from '@tally/shared/imaging';
import { PDFDocument } from 'pdf-lib';
import { Browser } from './helpers/browser.ts';
import { slipsPdf } from './helpers/slips.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';
import { storageConfigured, testStorage } from './helpers/test-storage.ts';

const OWNER = { email: 'owner@example.com', password: 'owner password 1' };
const DAY = new Date('2026-11-13');
/** What the paper says, as a person types it. */
const VALUES = {
  firstName: 'Kwame',
  workplace: 'Golan Farm',
  date: '13/11/2026',
  startTime: '08:00',
  endTime: '12:00',
  totalWorked: '04:00',
};
const STALE = 'Someone else changed this ticket. Reload it.';

describe.skipIf(!databaseUrl || !storageConfigured)('reviewing tickets (T1.6)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  let app: INestApplication;
  let base: string;
  let owner: Browser;
  let organiser: Organiser;
  let monthId: string;
  let uploadId: string;
  let page = 0;
  const files = testStorage();
  const config = new ReadingConfig(
    () => {
      throw new Error('nothing is read in these tests');
    },
    () => ({ today: '2026-11-21', minShiftHours: 2, maxShiftHours: 16, maxDateAgeDays: 45 }),
    false,
  );

  beforeAll(async () => {
    await Promise.all([db.migrate(), files.create()]);
    await createAdmin(prisma, OWNER.email, OWNER.password);
    ({ app, base } = await testApp(db, { reading: config, storage: files.storage }));
    owner = new Browser(base);
    organiser = app.get(Organiser);
    await owner.login(OWNER.email, OWNER.password);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await files.drop();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.upload.deleteMany();
    await prisma.workplaceGroup.deleteMany();
    await prisma.listEntry.deleteMany();
    await prisma.auditEntry.deleteMany();
    await prisma.month.updateMany({ data: { status: 'open', closedAt: null } });
    const user = await prisma.user.findFirstOrThrow();
    monthId = (await monthOf(prisma, DAY)).id;
    uploadId = (
      await prisma.upload.create({
        data: {
          uploadedById: user.id,
          originalFilename: 'week.pdf',
          sha256: `s${Math.random()}`,
          mime: 'application/pdf',
          pageCount: 3,
        },
      })
    ).id;
  });

  /** A ticket as the reader left it: the values of VALUES, in November, waiting for review. */
  const ticket = (extra: Record<string, unknown> = {}) =>
    prisma.ticket.create({
      data: {
        uploadId,
        monthId,
        pageIndex: page++,
        s3KeyPage: `pages/${uploadId}/${page}.jpg`,
        firstName: 'Kwame',
        workerName: 'Kwame',
        workplaceRaw: 'Golan Farm',
        shiftDate: DAY,
        startMinutes: 480,
        endMinutes: 720,
        totalMinutes: 240,
        status: 'needs_review',
        ...extra,
      },
    });
  const flag = (ticketId: string, code: string, field?: string) =>
    prisma.flag.create({ data: { ticketId, code, field, detail: {} } });
  const get = (id: string) =>
    prisma.ticket.findUniqueOrThrow({ where: { id }, include: { flags: true } });
  const open = async (id: string) =>
    (await get(id)).flags
      .filter((f) => !f.resolvedAt)
      .map((f) => f.code)
      .sort();
  /** Saves VALUES with `change`, naming the version the ticket has now. */
  async function save(
    id: string,
    change: Partial<typeof VALUES> = {},
    more: Record<string, unknown> = {},
  ) {
    const { version } = await get(id);
    return owner.send('PUT', `/api/tickets/${id}`, {
      version,
      values: { ...VALUES, ...change },
      workerName: 'Kwame',
      ...more,
    });
  }
  const send = async (id: string, action: 'exclude' | 'reprocess', version?: number) =>
    owner.send('POST', `/api/tickets/${id}/${action}`, {
      version: version ?? (await get(id)).version,
    });

  it('saves a correction: the disputed end time is fixed and the ticket is verified', async () => {
    const t = await ticket({ endMinutes: 750 }); // read as 12:30; the paper says 12:00
    await flag(t.id, 'PASS_DISAGREEMENT', 'endTime');
    await flag(t.id, 'TIME_MATH_MISMATCH', 'totalWorked');
    await organiser.organise(monthId); // grouped, so nothing is left to ask
    const res = await save(t.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'verified', verifiedHow: 'corrected', version: 1 });
    expect(res.body.flags.map((f: { resolution: string }) => f.resolution).sort()).toEqual([
      'changed',
      'changed',
    ]);
    expect(await get(t.id)).toMatchObject({ endMinutes: 720, status: 'verified' });
    const user = await prisma.user.findFirstOrThrow();
    for (const f of (await get(t.id)).flags) expect(f.resolvedById).toBe(user.id);
    const [entry] = await prisma.auditEntry.findMany({ where: { action: 'save-ticket' } });
    expect(entry).toMatchObject({
      entityId: t.id,
      monthId,
      before: { status: 'needs_review', endTime: 750 },
      after: { status: 'verified', endTime: 720, accepted: [] },
    });
  });

  it('refuses a stale save (409) and keeps the ticket as it was', async () => {
    const t = await ticket({ endMinutes: 750, version: 3 });
    await flag(t.id, 'PASS_DISAGREEMENT', 'endTime');
    const res = await owner.send('PUT', `/api/tickets/${t.id}`, {
      version: 2,
      values: VALUES,
      workerName: 'Kwame',
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain(STALE);
    expect(await get(t.id)).toMatchObject({ endMinutes: 750, version: 3 });
    expect(await open(t.id)).toEqual(['PASS_DISAGREEMENT']);
  });

  it('confirms a ticket with no flags in one click', async () => {
    const t = await ticket();
    const res = await save(t.id);
    expect(res.body).toMatchObject({ status: 'verified', verifiedHow: 'confirmed' });
  });

  it('accepts unusual hours only when asked, and only for the values saved', async () => {
    const t = await ticket();
    const long = { startTime: '06:00', endTime: '02:00', totalWorked: '20:00' };
    expect((await save(t.id, long)).body.status).toBe('needs_review');
    expect(await open(t.id)).toEqual(['HOURS_OUT_OF_RANGE']);

    const res = await save(t.id, long, { accept: ['HOURS_OUT_OF_RANGE'] });
    expect(res.body).toMatchObject({ status: 'verified', verifiedHow: 'confirmed' });
    expect(await open(t.id)).toEqual([]);
    const accepted = (await get(t.id)).flags.filter((f) => f.resolution === 'accepted');
    expect(accepted.map((f) => f.code)).toEqual(['HOURS_OUT_OF_RANGE']);

    // The earlier "as written" was for 20 hours, not 23.
    const longer = { startTime: '03:00', endTime: '02:00', totalWorked: '23:00' };
    expect((await save(t.id, longer)).body.status).toBe('needs_review');
    expect(await open(t.id)).toEqual(['HOURS_OUT_OF_RANGE']);
  });

  it('never accepts a time or date that does not exist or is in the future', async () => {
    const t = await ticket();
    for (const code of ['TIME_INVALID', 'DATE_IN_FUTURE', 'FIELD_EMPTY', 'POSSIBLE_DUPLICATE']) {
      expect((await save(t.id, {}, { accept: [code] })).status).toBe(400);
    }
    expect((await get(t.id)).version).toBe(0);
  });

  it('keeps a crossed-out ticket open unless it is confirmed as written', async () => {
    const t = await ticket();
    await flag(t.id, 'VOIDED_TICKET');
    expect((await save(t.id)).body.status).toBe('needs_review');
    expect(await open(t.id)).toEqual(['VOIDED_TICKET']);
    expect((await save(t.id, {}, { accept: ['VOIDED_TICKET'] })).body.status).toBe('verified');
  });

  it('confirms a Hebrew name in English letters and adds both spellings to the names list', async () => {
    const t = await ticket({ firstName: 'דנה', workerName: null });
    await flag(t.id, 'NAME_NOT_CONFIRMED', 'firstName');
    const res = await save(t.id, { firstName: 'דנה' }, { workerName: 'DANA' });
    expect(res.status).toBe(200);
    expect(res.body.workerName).toBe('Dana');
    // A new name may raise a duplicate question: the organiser looks first, then it is verified.
    expect((await get(t.id)).status).toBe('verified');
    expect(
      await prisma.listEntry.findMany({ select: { kind: true, name: true, spellings: true } }),
    ).toEqual([{ kind: 'name', name: 'Dana', spellings: ['דנה'] }]);
    await save(t.id, { firstName: 'דנה' }, { workerName: 'Dana' });
    expect((await prisma.listEntry.findFirstOrThrow()).spellings).toEqual(['דנה']);

    const hebrew = await save(t.id, { firstName: 'דנה' }, { workerName: 'דנה' });
    expect(hebrew.status).toBe(400);
    expect(JSON.stringify(hebrew.body)).toContain('English letters');
  });

  it('puts a ticket into its month once a person gives its date, and asks about duplicates', async () => {
    const first = await ticket({ status: 'verified', verifiedHow: 'auto' });
    const waiting = await ticket({
      monthId: null,
      shiftDate: null,
      startMinutes: 840,
      endMinutes: 1080,
    });
    await flag(waiting.id, 'FIELD_UNREADABLE', 'date');
    const res = await save(waiting.id, { startTime: '14:00', endTime: '18:00' });
    expect(res.body).toMatchObject({ monthId, status: 'needs_review', verifiedHow: 'corrected' });
    const saved = await get(waiting.id);
    expect(saved.workplaceGroupId).not.toBeNull();
    expect(saved.workplaceGroupId).toBe((await get(first.id)).workplaceGroupId);
    expect(await open(waiting.id)).toEqual(['POSSIBLE_DUPLICATE']);
    expect(await open(first.id)).toEqual(['POSSIBLE_DUPLICATE']);

    const question = saved.flags.find((f) => f.code === 'POSSIBLE_DUPLICATE')!;
    const answer = await owner.send('POST', `/api/flags/${question.id}/resolve`, {
      decision: 'keep_both',
    });
    expect(answer.status).toBe(204);
    expect((await get(waiting.id)).status).toBe('verified');
    expect((await get(first.id)).status).toBe('verified');
  });

  it('asks the duplicate question again when the date changes and changes back', async () => {
    const a = await ticket({ status: 'verified', verifiedHow: 'auto' });
    const b = await ticket({ status: 'verified', verifiedHow: 'auto', startMinutes: 840 });
    await organiser.organise(monthId);
    expect(await open(a.id)).toEqual(['POSSIBLE_DUPLICATE']);

    await save(b.id, { date: '14/11/2026', startTime: '14:00', endTime: '18:00' });
    expect(await prisma.flag.count({ where: { code: 'POSSIBLE_DUPLICATE' } })).toBe(0);
    expect((await get(a.id)).status).toBe('verified');
    expect((await get(b.id)).status).toBe('verified');

    await save(b.id, { startTime: '14:00', endTime: '18:00' });
    expect(await open(a.id)).toEqual(['POSSIBLE_DUPLICATE']);
    expect(await open(b.id)).toEqual(['POSSIBLE_DUPLICATE']);
  });

  it('drops answered questions about the old month when a ticket moves to another', async () => {
    const t = await ticket();
    const answered = { resolvedAt: new Date(), resolution: 'different_place', detail: {} };
    await prisma.flag.createMany({
      data: [
        { ticketId: t.id, code: 'WORKPLACE_SIMILAR', ...answered },
        { ticketId: t.id, code: 'POSSIBLE_DUPLICATE', ...answered },
        { ticketId: t.id, code: 'CORRECTION_MARKS', ...answered },
      ],
    });
    expect((await save(t.id, { date: '13/12/2026' })).status).toBe(200);
    const moved = await get(t.id);
    expect(moved.monthId).not.toBe(monthId);
    expect(moved.flags.map((f) => f.code)).not.toContain('WORKPLACE_SIMILAR');
    expect(moved.flags.map((f) => f.code)).not.toContain('POSSIBLE_DUPLICATE');
    expect(moved.flags.map((f) => f.code)).toContain('CORRECTION_MARKS');
  });

  it('regroups a ticket whose workplace is corrected, and drops its similar-place question', async () => {
    const a = await ticket({ workplaceRaw: 'בית הדר', status: 'verified', verifiedHow: 'auto' });
    const b = await ticket({
      workplaceRaw: 'בית הדרים',
      firstName: 'Dana',
      workerName: 'Dana',
      status: 'verified',
      verifiedHow: 'auto',
    });
    await organiser.organise(monthId);
    expect(await open(b.id)).toEqual(['WORKPLACE_SIMILAR']);
    const res = await save(
      b.id,
      { firstName: 'Dana', workplace: 'בית הדר' },
      { workerName: 'Dana' },
    );
    expect(res.status).toBe(200);
    const saved = await get(b.id);
    expect(saved.workplaceGroupId).toBe((await get(a.id)).workplaceGroupId);
    // The question was about a place that now has no tickets: dropped on both.
    expect(await open(b.id)).toEqual([]);
    expect(await open(a.id)).toEqual([]);
    expect(saved.status).toBe('verified');
    expect((await get(a.id)).status).toBe('verified');
  });

  it('stores a workplace typed as a list spelling under its list name, so it joins that place', async () => {
    await prisma.listEntry.create({
      data: { kind: 'workplace', name: 'בית הדר', spellings: ['Beit Hadar'] },
    });
    const a = await ticket({ workplaceRaw: 'בית הדר', status: 'verified', verifiedHow: 'auto' });
    const b = await ticket({ workplaceRaw: null, firstName: 'Dana', workerName: 'Dana' });
    const res = await save(
      b.id,
      { firstName: 'Dana', workplace: 'beit  hadar' },
      { workerName: 'Dana' },
    );
    expect(res.status).toBe(200);
    const saved = await get(b.id);
    expect(saved.workplaceRaw).toBe('בית הדר');
    expect(saved.workplaceGroupId).toBe((await get(a.id)).workplaceGroupId);
  });

  it('keeps a workplace as typed when two list places share that spelling', async () => {
    await prisma.listEntry.createMany({
      data: [
        { kind: 'workplace', name: 'בית הדר', spellings: ['Hadar'] },
        { kind: 'workplace', name: 'הדר', spellings: ['Hadar'] },
      ],
    });
    const t = await ticket();
    expect((await save(t.id, { workplace: 'Hadar' })).status).toBe(200);
    expect((await get(t.id)).workplaceRaw).toBe('Hadar');
  });

  it('keeps a ticket dated in a closing month out of it, and removes it on request', async () => {
    const october = await monthOf(prisma, new Date('2026-10-20'));
    await prisma.month.update({ where: { id: october.id }, data: { status: 'closing' } });
    const t = await ticket({ monthId: null });
    const res = await save(t.id, { date: '20/10/2026', endTime: '12:30', totalWorked: '04:30' });
    expect(res.body).toMatchObject({ status: 'needs_review', monthId: null });
    expect(await open(t.id)).toEqual(['MONTH_CLOSED']);
    // No month: the audit entry would outlive the purge, so it names the boxes, not the values.
    const [entry] = await prisma.auditEntry.findMany({ where: { action: 'save-ticket' } });
    expect(entry!.monthId).toBeNull();
    expect(entry!.after).toMatchObject({ changed: ['date', 'endTime', 'totalWorked'] });
    expect(JSON.stringify([entry!.before, entry!.after])).not.toMatch(/750|2026-10-20|Kwame/);

    expect((await send(t.id, 'exclude')).status).toBe(204);
    const removed = await get(t.id);
    expect(removed).toMatchObject({ status: 'excluded', excludedReason: 'removed' });
    expect(removed.flags.filter((f) => !f.resolvedAt)).toEqual([]);
  });

  it('refuses to save a ticket whose month is closed', async () => {
    const t = await ticket();
    await prisma.month.update({ where: { id: monthId }, data: { status: 'closed' } });
    const res = await save(t.id);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('This month is being closed or is closed.');
  });

  it('removes a ticket: its questions close and the other ticket is verified again', async () => {
    const a = await ticket({ status: 'verified', verifiedHow: 'auto' });
    const b = await ticket({ status: 'verified', verifiedHow: 'auto', startMinutes: 840 });
    await organiser.organise(monthId);
    expect((await get(a.id)).status).toBe('needs_review');

    expect((await send(b.id, 'exclude', 99)).status).toBe(409);
    expect((await send(b.id, 'exclude')).status).toBe(204);
    const owner_ = await prisma.user.findFirstOrThrow();
    expect(await get(b.id)).toMatchObject({
      status: 'excluded',
      excludedReason: 'removed',
      excludedById: owner_.id,
    });
    for (const id of [a.id, b.id]) {
      const pair = (await get(id)).flags.filter((f) => f.code === 'POSSIBLE_DUPLICATE');
      expect(pair.map((f) => f.resolution)).toEqual(['ticket_removed']);
    }
    expect((await get(a.id)).status).toBe('verified');
    const [entry] = await prisma.auditEntry.findMany({ where: { action: 'exclude-ticket' } });
    expect(entry).toMatchObject({ entityId: b.id, monthId, after: { status: 'excluded' } });

    expect((await send(b.id, 'exclude')).status).toBe(409); // already removed
    const reading = await ticket({ status: 'processing' });
    const res = await send(reading.id, 'exclude');
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('still being read');
    await prisma.month.update({ where: { id: monthId }, data: { status: 'closed' } });
    expect((await send(a.id, 'exclude')).status).toBe(409);
  });

  it('records which name the place kept when two spellings are merged', async () => {
    const a = await ticket({ workplaceRaw: 'בית הדר' });
    await ticket({ workplaceRaw: 'בית הדרים', workerName: 'Dana', firstName: 'Dana' });
    await organiser.organise(monthId);
    const keep = (await get(a.id)).workplaceGroupId!;
    const question = (await get(a.id)).flags.find((f) => f.code === 'WORKPLACE_SIMILAR')!;
    await owner.send('POST', `/api/flags/${question.id}/resolve`, {
      decision: 'same_place',
      keepGroupId: keep,
    });
    const [entry] = await prisma.auditEntry.findMany({ where: { action: 'resolve-flag' } });
    expect(entry!.after).toMatchObject({ decision: 'same_place', keepGroupId: keep });
    expect(entry!.after).toMatchObject({
      kept: { id: keep, name: 'בית הדר' },
      merged: { name: 'בית הדרים' },
    });
  });

  it('shows a ticket with its flags, the ticket it may duplicate, and links to both scans', async () => {
    const a = await ticket({ suggestions: { endTime: '12:00' } });
    const b = await ticket({ startMinutes: 840 });
    await organiser.organise(monthId);
    const res = await owner.send('GET', `/api/tickets/${a.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a.id, version: 0, suggestions: { endTime: '12:00' } });
    expect(res.body.flags.map((f: { code: string }) => f.code)).toEqual(['POSSIBLE_DUPLICATE']);
    expect(res.body.imageUrl).toContain(`pages/${uploadId}/`);
    expect(res.body.imageUrl).toContain('X-Amz-Expires=300');
    expect(res.body.related).toHaveLength(1);
    expect(res.body.related[0]).toMatchObject({ id: b.id });
    expect(res.body.related[0].imageUrl).toContain('X-Amz-Expires=300');
    expect(JSON.stringify(res.body)).not.toContain('s3KeyPage');

    expect((await owner.send('GET', '/api/tickets/not-an-id')).status).toBe(404);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await owner.send('GET', `/api/tickets/${unknown}`)).status).toBe(404);
  });

  it('gives the month page each ticket’s version, which removing it needs', async () => {
    const t = await ticket({ version: 4 });
    await organiser.organise(monthId);
    const month = (await owner.send('GET', `/api/months/${monthId}`)).body;
    expect(month.workplaces[0].rows[0].tickets[0]).toMatchObject({ id: t.id, version: 4 });
  });

  it('gives the straightened slip of a scan, and 404 when its markers are not found', async () => {
    const slip = async (scan: Buffer) => {
      const t = await ticket();
      await files.storage.put(t.s3KeyPage, scan, 'image/jpeg');
      return fetch(`${base}/api/tickets/${t.id}/slip`, {
        headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      });
    };
    const [scan] = await pdfToImages(Buffer.from(await slipsPdf(1, 'slip')));
    const found = await slip(await imageToJpeg(scan!));
    expect(found.status).toBe(200);
    expect(found.headers.get('content-type')).toBe('image/jpeg');
    expect(found.headers.get('cache-control')).toBe('private, no-store');
    const jpeg = Buffer.from(await found.arrayBuffer());
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const blank = await PDFDocument.create();
    blank.addPage([400, 200]);
    const [white] = await pdfToImages(Buffer.from(await blank.save()));
    const missing = await slip(await imageToJpeg(white!));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('The corner markers were not found on this scan.');
  });

  it('never removes a ticket that replaced a duplicate: both copies would be out', async () => {
    const kept = await ticket({ status: 'verified', verifiedHow: 'confirmed' });
    await ticket({ status: 'excluded', excludedReason: 'replaced', replacedById: kept.id });
    const res = await send(kept.id, 'exclude');
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('This replaced a duplicate ticket');
    expect((await get(kept.id)).status).toBe('verified');
  });

  it('reading a ticket again clears its 57 tick, so it is decided afresh', async () => {
    const t = await ticket({ status: 'verified', verifiedHow: 'confirmed', rate57: true });
    expect((await send(t.id, 'reprocess')).status).toBe(204);
    expect(await get(t.id)).toMatchObject({ status: 'processing', rate57: null });
  });

  it('lists tickets by month, status and open flag, 50 to a page', async () => {
    const waiting = await ticket({ monthId: null });
    await flag(waiting.id, 'DATE_INVALID', 'date');
    await ticket({ status: 'verified' });
    const list = async (query: string) =>
      (await owner.send('GET', `/api/tickets?${query}`)).body as {
        total: number;
        tickets: { id: string }[];
      };
    expect((await list('month=none')).tickets.map((t) => t.id)).toEqual([waiting.id]);
    expect((await list(`month=${monthId}&status=verified`)).total).toBe(1);
    expect((await list('flag=DATE_INVALID')).tickets.map((t) => t.id)).toEqual([waiting.id]);
    expect((await list('page=2')).tickets).toEqual([]);
    expect((await owner.send('GET', '/api/tickets?month=soon')).status).toBe(400);
  });

  it('counts each upload’s tickets by status, including a file still being split', async () => {
    await ticket({ status: 'verified' });
    await ticket({ status: 'verified' });
    const reading = await ticket({ status: 'processing' });
    // An old upload with a ticket sent to be read again: its last activity is that ticket's.
    await prisma.upload.update({ where: { id: uploadId }, data: { updatedAt: new Date(0) } });
    const { updatedAt } = await prisma.ticket.findUniqueOrThrow({ where: { id: reading.id } });
    const user = await prisma.user.findFirstOrThrow();
    const splitting = await prisma.upload.create({
      data: {
        uploadedById: user.id,
        originalFilename: 'week 2.pdf',
        s3KeyOriginal: 'uploads/x',
        sha256: `s${Math.random()}`,
        mime: 'application/pdf',
        pageCount: 5,
      },
    });
    const res = await owner.send('GET', '/api/progress');
    expect(res.status).toBe(200);
    expect(res.body.map((u: { id: string }) => u.id)).toEqual([splitting.id, uploadId]);
    expect(res.body[0]).toMatchObject({ filename: 'week 2.pdf', pages: 5, splitting: true });
    expect(res.body[1]).toMatchObject({
      splitting: false,
      failedPages: [],
      activeAt: updatedAt.toISOString(),
      tickets: { processing: 1, verified: 2, needs_review: 0, needs_manual_entry: 0, excluded: 0 },
    });
  });

  it('keeps a ticket not yet grouped waiting until the organiser has asked its questions', async () => {
    await ticket({ status: 'verified', verifiedHow: 'auto' });
    await organiser.organise(monthId);
    const t = await ticket({ startMinutes: 840 }); // its workplace was in doubt: not grouped
    await flag(t.id, 'MATCH_AMBIGUOUS', 'workplace');
    await save(t.id, { startTime: '14:00', endTime: '18:00' });
    const [entry] = await prisma.auditEntry.findMany({ where: { action: 'save-ticket' } });
    expect(entry!.after).toMatchObject({ status: 'needs_review' }); // never verified meanwhile
    expect(await open(t.id)).toEqual(['POSSIBLE_DUPLICATE']);
  });

  it('asks again about a pair kept as two shifts once a value changes', async () => {
    const a = await ticket({ status: 'verified', verifiedHow: 'auto' });
    const b = await ticket({ status: 'verified', verifiedHow: 'auto', startMinutes: 840 });
    await organiser.organise(monthId);
    const question = (await get(a.id)).flags.find((f) => f.code === 'POSSIBLE_DUPLICATE')!;
    await owner.send('POST', `/api/flags/${question.id}/resolve`, { decision: 'keep_both' });
    expect(await open(a.id)).toEqual([]);
    // A's times now match B's: "two shifts" was answered about other values.
    const res = await save(a.id, { startTime: '14:00', endTime: '18:00' });
    expect(res.body.status).toBe('needs_review');
    expect(await open(a.id)).toEqual(['POSSIBLE_DUPLICATE']);
    expect(await open(b.id)).toEqual(['POSSIBLE_DUPLICATE']);
    expect(await prisma.auditEntry.count({ where: { action: 'resolve-flag' } })).toBe(1);
  });

  it('refuses an answer to a question that went away while it was sent', async () => {
    await ticket({ status: 'verified', verifiedHow: 'auto' });
    const b = await ticket({ status: 'verified', verifiedHow: 'auto', startMinutes: 840 });
    await organiser.organise(monthId);
    const question = (await get(b.id)).flags.find((f) => f.code === 'POSSIBLE_DUPLICATE')!;
    let answer: ReturnType<typeof owner.send> | undefined;
    // As if a save changed B's date between the answer's first look and its lock.
    await prisma.$transaction(async (tx) => {
      await lockMonth(tx, monthId);
      answer = owner.send('POST', `/api/flags/${question.id}/resolve`, { decision: 'keep_both' });
      await new Promise((r) => setTimeout(r, 500));
      await tx.flag.deleteMany({ where: { code: 'POSSIBLE_DUPLICATE' } });
    });
    const res = await answer!;
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('This question changed. Reload the page.');
  });

  it('counts a name typed by a person as a correction', async () => {
    const t = await ticket({ workerName: null });
    await flag(t.id, 'NAME_NOT_CONFIRMED', 'firstName');
    const res = await save(t.id);
    expect(res.body).toMatchObject({ status: 'verified', verifiedHow: 'corrected' });
  });

  it('refuses to confirm as written something that is not flagged', async () => {
    const t = await ticket();
    const res = await save(t.id, {}, { accept: ['HOURS_OUT_OF_RANGE'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('something you confirmed was not flagged');
    // A new warning from new values is shown first, and confirmed with the next save.
    const long = { startTime: '06:00', endTime: '02:00', totalWorked: '20:00' };
    expect((await save(t.id, long, { accept: ['HOURS_OUT_OF_RANGE'] })).status).toBe(400);
  });

  it('refuses to confirm a warning that is already answered', async () => {
    const t = await ticket({ startMinutes: 360, endMinutes: 120, totalMinutes: 1200 });
    await prisma.flag.create({
      data: {
        ticketId: t.id,
        code: 'HOURS_OUT_OF_RANGE',
        field: 'totalWorked',
        detail: {},
        resolvedAt: new Date(),
        resolution: 'accepted',
      },
    });
    const long = { startTime: '06:00', endTime: '02:00', totalWorked: '20:00' };
    expect((await save(t.id, long, { accept: ['HOURS_OUT_OF_RANGE'] })).status).toBe(400);
    expect((await get(t.id)).version).toBe(0);
  });

  it('marks a ticket typed in by hand as manual, even when it took two saves', async () => {
    const t = await ticket({
      monthId: null,
      firstName: null,
      workerName: null,
      workplaceRaw: null,
      shiftDate: null,
      startMinutes: null,
      endMinutes: null,
      totalMinutes: null,
      status: 'needs_manual_entry',
    });
    await flag(t.id, 'EXTRACTION_ERROR');
    expect((await save(t.id, { endTime: '' })).body.status).toBe('needs_review');
    const res = await save(t.id);
    expect(res.body).toMatchObject({ status: 'verified', verifiedHow: 'manual' });
  });

  it('adds a Hebrew spelling to the names list entry written the same way', async () => {
    await prisma.listEntry.create({ data: { kind: 'name', name: 'Mary-Ann' } });
    const t = await ticket({ firstName: 'מרי', workerName: null });
    await save(t.id, { firstName: 'מרי' }, { workerName: 'Mary Ann' });
    expect(await prisma.listEntry.findMany({ select: { name: true, spellings: true } })).toEqual([
      { name: 'Mary-Ann', spellings: ['מרי'] },
    ]);
  });

  /** How a person settles each flag (section 4.1). Every flag code must be here. */
  const SETTLED_BY: Record<FlagCode, 'save' | 'accept' | 'answer'> = {
    PASS_DISAGREEMENT: 'save',
    FIELD_UNREADABLE: 'save',
    FIELD_EMPTY: 'save',
    CORRECTION_MARKS: 'save',
    VOIDED_TICKET: 'accept',
    TIME_INVALID: 'save',
    TIME_MATH_MISMATCH: 'accept',
    HOURS_OUT_OF_RANGE: 'accept',
    DATE_IN_FUTURE: 'save',
    DATE_TOO_OLD: 'accept',
    DATE_INVALID: 'save',
    SCRIPT_UNEXPECTED: 'accept',
    MARKERS_NOT_FOUND: 'save',
    IMAGE_BLURRY: 'save',
    IMAGE_DARK: 'save',
    WORKPLACE_SIMILAR: 'answer',
    WORKPLACE_NOT_ON_LIST: 'save',
    MATCH_AMBIGUOUS: 'save',
    POSSIBLE_DUPLICATE: 'answer',
    MONTH_CLOSED: 'save',
    NAME_NOT_CONFIRMED: 'save',
    EXTRACTION_ERROR: 'save',
  };
  /** Values the paper really has that raise a flag a person may confirm as written. */
  const AS_WRITTEN: Partial<Record<FlagCode, Partial<typeof VALUES>>> = {
    TIME_MATH_MISMATCH: { totalWorked: '05:00' },
    HOURS_OUT_OF_RANGE: { startTime: '06:00', endTime: '02:00', totalWorked: '20:00' },
    DATE_TOO_OLD: { date: '01/09/2026' },
    SCRIPT_UNEXPECTED: { firstName: 'Kwame2' },
    VOIDED_TICKET: {},
  };

  /** Flags about the reading itself, settled by any save. */
  const READING = [
    'PASS_DISAGREEMENT',
    'FIELD_UNREADABLE',
    'CORRECTION_MARKS',
    'MATCH_AMBIGUOUS',
    'WORKPLACE_NOT_ON_LIST',
    'MARKERS_NOT_FOUND',
    'IMAGE_BLURRY',
    'IMAGE_DARK',
    'EXTRACTION_ERROR',
  ];
  /** A value that raises the flag, stored and saved once as it is before it is corrected. */
  const UNCORRECTED: Partial<
    Record<
      FlagCode,
      {
        stored: Record<string, unknown>;
        values: Partial<typeof VALUES>;
        more?: Record<string, unknown>;
      }
    >
  > = {
    FIELD_EMPTY: { stored: { endMinutes: null }, values: { endTime: '' } },
    TIME_INVALID: { stored: { endMinutes: null }, values: { endTime: '25:00' } },
    DATE_INVALID: { stored: { monthId: null, shiftDate: null }, values: { date: '31/02/2026' } },
    DATE_IN_FUTURE: { stored: { monthId: null, shiftDate: null }, values: { date: '30/11/2026' } },
    MONTH_CLOSED: {
      stored: { monthId: null, shiftDate: new Date('2026-10-20') },
      values: { date: '20/10/2026' },
    },
    NAME_NOT_CONFIRMED: {
      stored: { firstName: 'דנה', workerName: null },
      values: { firstName: 'דנה' },
      more: { workerName: null },
    },
  };

  it('has a way to settle every flag code', () => {
    expect(Object.keys(SETTLED_BY).sort()).toEqual([...FLAG_CODES].sort());
  });

  for (const code of FLAG_CODES) {
    it(`settles ${code} (${SETTLED_BY[code]})`, async () => {
      if (SETTLED_BY[code] === 'answer') {
        const a = await ticket({ workplaceRaw: 'בית הדר' });
        await ticket({
          workplaceRaw: code === 'WORKPLACE_SIMILAR' ? 'בית הדרים' : 'בית הדר',
          startMinutes: 840,
          ...(code === 'WORKPLACE_SIMILAR' && { workerName: 'Dana', firstName: 'Dana' }),
        });
        await organiser.organise(monthId);
        const question = (await get(a.id)).flags.find((f) => f.code === code)!;
        const decision = code === 'WORKPLACE_SIMILAR' ? 'different_place' : 'keep_both';
        const res = await owner.send('POST', `/api/flags/${question.id}/resolve`, { decision });
        expect(res.status).toBe(204);
        expect(await open(a.id)).toEqual([]);
        return;
      }
      const manual = code === 'EXTRACTION_ERROR';
      const bad = UNCORRECTED[code];
      if (code === 'MONTH_CLOSED') {
        const october = await monthOf(prisma, new Date('2026-10-20'));
        await prisma.month.update({ where: { id: october.id }, data: { status: 'closed' } });
      }
      const t = await ticket(
        manual
          ? {
              monthId: null,
              firstName: null,
              workerName: null,
              workplaceRaw: null,
              shiftDate: null,
              startMinutes: null,
              endMinutes: null,
              totalMinutes: null,
              status: 'needs_manual_entry',
            }
          : (bad?.stored ?? {}),
      );
      await flag(t.id, code);
      if (bad) {
        // Saved as it is, the flag is raised again; only the correction settles it.
        const res = await save(t.id, bad.values, bad.more ?? {});
        expect(res.status).toBe(200);
        expect(await open(t.id)).toContain(code);
        if (bad.values.date) expect(res.body.monthId).toBeNull();
      }
      const accept = SETTLED_BY[code] === 'accept';
      const fixed = code === 'NAME_NOT_CONFIRMED' ? { firstName: 'דנה' } : AS_WRITTEN[code];
      const more = code === 'NAME_NOT_CONFIRMED' ? { workerName: 'Dana' } : {};
      const res = await save(t.id, fixed, accept ? { accept: [code] } : more);
      expect(res.status).toBe(200);
      expect(await open(t.id)).toEqual([]);
      const after = await get(t.id);
      expect(after.status).toBe('verified');
      if (manual) expect(res.body.verifiedHow).toBe('manual');
      if (READING.includes(code)) {
        const user = await prisma.user.findFirstOrThrow();
        const [f] = after.flags.filter((f) => f.code === code);
        // Nothing was retyped, so the reading is confirmed; a manual entry changed every box.
        expect(f).toMatchObject({
          resolution: manual ? 'changed' : 'confirmed',
          resolvedById: user.id,
        });
      }
      if (accept) {
        const flags = (await get(t.id)).flags.filter((f) => f.code === code);
        expect(flags.some((f) => f.resolution === 'accepted')).toBe(true);
      }
    });
  }
});
