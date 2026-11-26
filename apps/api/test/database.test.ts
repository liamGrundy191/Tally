// T1.1 "Done when": the migrations apply to an empty database, and the seed creates an admin.
// Each run uses its own empty schema and drops it afterwards (helpers/test-db.ts).
import { verify } from 'argon2';
import { afterAll, describe, expect, it } from 'vitest';
import { AccountError, createAdmin } from '../src/users/create-admin.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

describe.skipIf(!databaseUrl)('the database', () => {
  const db = testDatabase();
  const { prisma, schema, migrate } = db;
  afterAll(() => db.drop());

  it('applies the migrations to an empty database, and a second run changes nothing', async () => {
    expect(await migrate()).toMatch(/applied|Applying/i);
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY 1`;
    expect(tables.map((t) => t.table_name)).toEqual([
      'AuditEntry',
      'Download',
      'Flag',
      'Invite',
      'ListEntry',
      'LoginFailure',
      'Month',
      'MorningHours',
      'Reading',
      'Session',
      'Ticket',
      'Upload',
      'User',
      'WorkplaceGroup',
      '_prisma_migrations',
    ]);
    expect(await migrate()).toMatch(/No pending migrations/i);
  }, 120_000); // the Prisma command line takes several seconds to start

  it('deletes a month with everything in it, and nothing else (section 6.4)', async () => {
    const user = await prisma.user.create({
      data: { email: 'owner@example.com', passwordHash: 'x', role: 'admin' },
    });
    const upload = await prisma.upload.create({
      data: {
        uploadedById: user.id,
        originalFilename: 'a.pdf',
        sha256: 'a',
        mime: 'application/pdf',
      },
    });
    const [november, december] = await Promise.all(
      [11, 12].map((month) => prisma.month.create({ data: { year: 2026, month } })),
    );
    for (const [i, m] of [november!, december!].entries()) {
      const ticket = await prisma.ticket.create({
        data: { uploadId: upload.id, monthId: m.id, pageIndex: i, s3KeyPage: `p${i}` },
      });
      await prisma.flag.create({
        data: { ticketId: ticket.id, code: 'FIELD_UNREADABLE', detail: {} },
      });
    }
    await prisma.listEntry.create({ data: { kind: 'name', name: 'Dana' } });
    await prisma.month.delete({ where: { id: november!.id } });
    expect(await prisma.ticket.count()).toBe(1);
    expect(await prisma.flag.count()).toBe(1);
    expect(await prisma.listEntry.count()).toBe(1); // the lists belong to no month (D42)
    expect(await prisma.user.count()).toBe(1);
    await prisma.upload.deleteMany(); // and its tickets
    await prisma.month.deleteMany();
    await prisma.listEntry.deleteMany();
    await prisma.user.deleteMany();
  });

  describe('creating the first admin (pnpm seed:admin)', () => {
    it('creates an admin whose password is stored as an argon2id hash', async () => {
      const admin = await createAdmin(prisma, '  Owner@Example.com ', 'correct horse battery');
      expect(admin).toMatchObject({ email: 'owner@example.com', role: 'admin' });
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
      expect(stored.passwordHash).not.toContain('correct horse');
      expect(await verify(stored.passwordHash, 'correct horse battery')).toBe(true);
      expect(await verify(stored.passwordHash, 'wrong password!!')).toBe(false);
    });

    it('refuses an email already in use, whatever its capital letters', async () => {
      await expect(
        createAdmin(prisma, 'OWNER@example.com', 'another long password'),
      ).rejects.toThrow(AccountError);
      expect(await prisma.user.count()).toBe(1);
    });

    it('refuses a short password or an invalid email, and creates nothing', async () => {
      await expect(createAdmin(prisma, 'new@example.com', 'short pass')).rejects.toThrow(
        /at least 12 characters/,
      );
      await expect(createAdmin(prisma, 'not an email', 'a long enough password')).rejects.toThrow(
        /not a valid email/,
      );
      expect(await prisma.user.count()).toBe(1);
    });
  });
});
