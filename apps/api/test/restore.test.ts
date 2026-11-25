// A backup restores to a working app (T4.2, D59): the app keeps nothing outside Postgres and file
// storage, so a standard dump of its two schemas, restored into a new database, has every row and
// starts the job queue. A closed month comes back closed, with nothing but its summary.
// pg_dump runs inside the Postgres container, so its version always matches the server's (CI's
// service container and the local compose one use the same image).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/db.ts';
import type { PrismaClient } from '../src/generated/prisma/client.ts';
import { createBoss, READ_UPLOAD, startQueue } from '../src/queue.ts';
import { createAdmin } from '../src/users/create-admin.ts';
import { databaseUrl, databaseUrlFor, testDatabase } from './helpers/test-db.ts';

const run = promisify(execFile);
const IMAGE = 'postgres:16.16-alpine'; // docker/compose.dev.yml and .github/workflows/ci.yml

async function postgresContainer() {
  try {
    // The one serving the test database's port: another Postgres (the home Tally) may be running.
    const port = new URL(databaseUrl!).port || '5432';
    const filters = ['--filter', `ancestor=${IMAGE}`, '--filter', `publish=${port}`];
    const { stdout } = await run('docker', ['ps', '-q', ...filters]);
    return stdout.trim().split('\n')[0] || undefined;
  } catch {
    return undefined; // no Docker
  }
}

const container = databaseUrl ? await postgresContainer() : undefined;
if (databaseUrl && !container && process.env.CI) {
  throw new Error(`CI must run Postgres in a ${IMAGE} container for the restore test.`);
}

/** Every table of the two schemas, with its row count. */
async function counts(prisma: PrismaClient, schemas: string[]) {
  const tables = await prisma.$queryRawUnsafe<{ s: string; t: string }[]>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
     WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE' ORDER BY 1, 2`,
    schemas,
  );
  const out: Record<string, number> = {};
  for (const { s, t } of tables) {
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${s}"."${t}"`,
    );
    out[`${s}.${t}`] = Number(row!.n);
  }
  return out;
}

describe.skipIf(!container)('restoring a backup (T4.2)', () => {
  const db = testDatabase();
  const prisma = db.prisma;
  const schemas = [db.schema, db.queueSchema!];
  const copy = `restore_${randomBytes(4).toString('hex')}`;
  let restored: PrismaClient | undefined;

  afterAll(async () => {
    await restored?.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${copy}" WITH (FORCE)`);
    await db.drop();
  });

  it('brings back every row, a closed month still closed, and a working queue', async () => {
    await db.migrate();
    const userId = (await createAdmin(prisma, 'owner@example.com', 'owner password 1')).id;
    const open = await prisma.month.create({ data: { year: 2026, month: 12 } });
    await prisma.month.create({
      data: {
        year: 2026,
        month: 11,
        status: 'closed',
        closedAt: new Date(),
        summaryTicketCount: 45,
        summaryTotalMinutes: 21110,
      },
    });
    const upload = await prisma.upload.create({
      data: {
        uploadedById: userId,
        originalFilename: 'week.pdf',
        sha256: 'abc',
        mime: 'application/pdf',
        pageCount: 1,
      },
    });
    await prisma.ticket.create({
      data: { uploadId: upload.id, monthId: open.id, pageIndex: 0, s3KeyPage: 'pages/x/0.jpg' },
    });
    const boss = createBoss(db.url, db.queueSchema);
    await startQueue(boss);
    await boss.send(READ_UPLOAD, { uploadId: upload.id });
    await boss.stop();

    const url = new URL(databaseUrl!);
    const user = decodeURIComponent(url.username);
    const name = url.pathname.slice(1);
    const dump = (
      await run(
        'docker',
        ['exec', container!, 'pg_dump', '-U', user, '-d', name, '-Fc', '--no-owner'].concat(
          schemas.flatMap((s) => ['--schema', s]),
        ),
        { encoding: 'buffer', maxBuffer: 1 << 28 },
      )
    ).stdout;
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${copy}"`);
    const restore = run('docker', [
      'exec',
      '-i',
      container!,
      'pg_restore',
      '-U',
      user,
      '-d',
      copy,
      '--no-owner',
    ]);
    restore.child.stdin!.end(dump);
    await restore;

    restored = createPrisma(databaseUrlFor(copy), db.schema);
    const before = await counts(prisma, schemas);
    expect(Object.keys(before).length).toBeGreaterThan(10);
    expect(await counts(restored, schemas)).toEqual(before);

    const months = await restored.month.findMany({
      include: { tickets: true },
      orderBy: { month: 'asc' },
    });
    expect(months.map((m) => [m.status, m.tickets.length, m.summaryTotalMinutes])).toEqual([
      ['closed', 0, 21110],
      ['open', 1, null],
    ]);

    const again = createBoss(databaseUrlFor(copy), db.queueSchema);
    await again.start();
    expect(await again.getQueue(READ_UPLOAD)).not.toBeNull();
    await again.stop();
  }, 120_000);
});
