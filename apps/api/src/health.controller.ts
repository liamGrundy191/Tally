// GET /api/health (section 8): open to anyone, for the server's own checks. "ok" when the database,
// file storage and the job queue answer within 3 s each; 503 "unavailable" otherwise, naming
// nothing (the failing check is in the logs). One answer serves every caller for 5 s, so a flood
// of requests costs at most one round of checks every 5 s.
import { Controller, Get, Header, Logger, Res } from '@nestjs/common';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { PgBoss } from 'pg-boss';
import { Access } from './auth/access.ts';
import { PrismaClient } from './generated/prisma/client.ts';
import { safeError } from './observability.ts';
import { READ_UPLOAD } from './queue.ts';
import { Storage } from './storage.ts';

const LIMIT_MS = 3000;
const REUSE_MS = 5000;

@Controller('health')
@Access('public')
export class HealthController {
  private readonly log = new Logger('Health');
  private last?: { at: number; ok: Promise<boolean> };

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: Storage,
    private readonly boss: PgBoss,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async health(@Res({ passthrough: true }) res: { status(code: number): void }) {
    if (!this.last || Date.now() - this.last.at > REUSE_MS) {
      this.last = { at: Date.now(), ok: this.check() };
    }
    const ok = await this.last.ok;
    res.status(ok ? 200 : 503);
    return ok ? 'ok' : 'unavailable';
  }

  private async check() {
    const within = (name: string, work: () => Promise<unknown>) =>
      Promise.race([
        work(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
            LIMIT_MS,
          ).unref(),
        ),
      ]).then(
        () => true,
        (e: unknown) => {
          this.log.warn({ msg: 'health check failed', check: name, ...safeError(e) });
          return false;
        },
      );
    const all = await Promise.all([
      within('database', () => this.prisma.$queryRaw`SELECT 1`),
      within('storage', () =>
        this.storage.s3.send(new HeadBucketCommand({ Bucket: this.storage.bucket }), {
          abortSignal: AbortSignal.timeout(LIMIT_MS),
        }),
      ),
      within('queue', async () => {
        if (!(await this.boss.getQueue(READ_UPLOAD))) throw new Error('no queue');
      }),
    ]);
    return all.every(Boolean);
  }
}
