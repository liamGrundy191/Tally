// Logs and error reports carry codes and ids, never ticket values, names or secrets (T4.2, D59).
// Names here are invented.
import { Controller, Get, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Access } from '../src/auth/access.ts';
import { Prisma } from '../src/generated/prisma/client.ts';
import { initSentry, safeError, scrub } from '../src/observability.ts';
import { job } from '../src/worker.ts';
import { testApp } from './helpers/test-app.ts';
import { databaseUrl, testDatabase } from './helpers/test-db.ts';

const prismaError = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed: (firstName)=(Kwame)', {
    code: 'P2002',
    clientVersion: '7',
  });

/** Everything written to the logs while `run` runs, as one string. */
async function logsOf(run: () => Promise<unknown>) {
  const out: string[] = [];
  const keep = (...a: unknown[]) => void out.push(JSON.stringify(a));
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (keep(s), true)),
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (keep(s), true)),
    ...(['log', 'warn', 'error', 'fatal'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(keep),
    ),
  ];
  try {
    await run();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return out.join('\n');
}

/** Sentry with a transport that keeps what would be sent, as text. */
function fakeSentry() {
  const sent: string[] = [];
  initSentry(
    { SENTRY_DSN: 'https://public@example.invalid/1' },
    {
      transport: (o) =>
        Sentry.createTransport(o, async (req) => {
          sent.push(typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body));
          return {};
        }),
    },
  );
  return sent;
}

describe('safeError', () => {
  it('keeps the code of a database error, never its text', () => {
    const s = safeError(prismaError());
    expect(s.code).toBe('P2002');
    expect(JSON.stringify(s)).not.toContain('Kwame');
  });

  it('keeps the text of a system call error, which names no ticket', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
    });
    expect(safeError(e).message).toBe('connect ECONNREFUSED 10.0.0.5:5432');
  });

  it("keeps only the code of Node's other errors, which can quote a value", () => {
    const e = Object.assign(new TypeError('The argument "name" is invalid. Received "Kwame"'), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
    const s = safeError(e);
    expect(s.code).toBe('ERR_INVALID_ARG_VALUE');
    expect(JSON.stringify(s)).not.toContain('Kwame');
  });

  it('keeps no line of a message that looks like a stack frame', () => {
    const s = safeError(new Error('Two places:\n   at Golan farm\n   at Kwame'));
    expect(s.frames!.length).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toMatch(/Golan|Kwame/);
  });

  it('drops the text of any other error, and of things that are not errors', () => {
    expect(safeError(new Error('Sheet "חוות גולן" is invalid')).message).toBeUndefined();
    expect(JSON.stringify(safeError('Kwame'))).not.toContain('Kwame');
  });
});

describe('Sentry', () => {
  afterEach(() => Sentry.close());

  it('is off without SENTRY_DSN', () => {
    expect(initSentry({})).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
  });

  it('sends only the error type, its code and where it happened', () => {
    const event = scrub(
      {
        type: undefined,
        message: 'Kwame',
        request: { cookies: { tally_session: 'secret' }, data: 'Kwame', query_string: 'n=Kwame' },
        user: { email: 'kwame@example.com' },
        breadcrumbs: [{ message: 'Kwame' }],
        extra: { name: 'Kwame' },
        contexts: { app: { name: 'Kwame' } },
        tags: { queue: 'read-upload' },
        exception: {
          values: [
            {
              type: 'PrismaClientKnownRequestError',
              value: 'Unique constraint failed: (firstName)=(Kwame)',
              mechanism: { type: 'generic', handled: true, data: { name: 'Kwame' } },
              stacktrace: { frames: [{ filename: 'reader.ts', lineno: 3, vars: { n: 'Kwame' } }] },
            },
          ],
        },
      },
      { originalException: prismaError() },
    );
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/Kwame|secret/);
    expect(event?.tags).toEqual({ queue: 'read-upload' });
    expect(event?.exception?.values?.[0]).toMatchObject({
      type: 'PrismaClientKnownRequestError',
      value: 'P2002',
      stacktrace: { frames: [{ filename: 'reader.ts', lineno: 3 }] },
    });
  });
});

describe('a job that fails', () => {
  afterEach(() => Sentry.close());
  const failing = job('read-upload', async () => {
    throw prismaError();
  });
  const attempt = (retryCount: number) =>
    failing([{ id: 'j1', retryCount, data: { uploadId: 'u1' } } as never]);

  it('is logged with its ids and tried again, with no ticket text kept anywhere', async () => {
    const sent = fakeSentry();
    let thrown: unknown;
    const logs = await logsOf(() => attempt(0).catch((e: unknown) => (thrown = e)));
    expect(logs).toContain('u1');
    expect(logs).toContain('P2002');
    expect(logs).not.toContain('Kwame');
    // pg-boss keeps the error's text in its own table.
    expect((thrown as Error).message).not.toContain('Kwame');
    await Sentry.flush(1000);
    expect(sent).toEqual([]);
  });

  it('is reported once on its last attempt', async () => {
    const sent = fakeSentry();
    await logsOf(() => attempt(4).catch(() => undefined));
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('Kwame');
  });
});

@Controller('boom')
@Access('public')
class BoomController {
  @Get()
  boom(): never {
    throw prismaError();
  }
}

describe.skipIf(!databaseUrl)('an unexpected error on a request', () => {
  const db = testDatabase();
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await db.migrate();
    const { app, base: b } = await testApp(db, { controllers: [BoomController] });
    base = b;
    close = () => app.close();
  }, 120_000);
  afterAll(async () => {
    await close();
    await db.drop();
  });
  afterEach(() => Sentry.close());

  it("answers Nest's usual 500, and logs and reports no ticket text or secret", async () => {
    const sent = fakeSentry();
    let res!: Response;
    const logs = await logsOf(async () => {
      res = await fetch(`${base}/api/boom?name=Kwame`, {
        headers: { cookie: 'tally_session=secret' },
      });
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
    expect(logs).toContain('P2002');
    for (const text of [logs, ...sent]) expect(text).not.toMatch(/Kwame|secret/);
  });
});
