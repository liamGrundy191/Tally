// The background worker (MODE=worker): the same app, taking jobs from the queue instead of
// answering requests.
import { type INestApplicationContext, Logger } from '@nestjs/common';
import { AGENCY_TIME_ZONE, type ReadSpeed } from '@tally/shared';
import { type Job, PgBoss } from 'pg-boss';
import { Purger } from './months/purge.ts';
import { reportError, safeError } from './observability.ts';
import { CHECK_MONTHS, PURGE_MONTH, READ_UPLOAD, RETRY_LIMIT, SPLIT_UPLOAD } from './queue.ts';
import { Reader } from './reading/reader.ts';
import { Splitter } from './uploads/splitter.ts';

const log = new Logger('Worker');

/**
 * A job's handler. A failure is logged with the job's ids and the error's safe parts, reported on
 * the last attempt only, and passed on to pg-boss without its text, which pg-boss would keep in its
 * own table (D59).
 */
export function job<T extends { uploadId?: string; monthId?: string }>(
  queue: string,
  run: (data: T, lastAttempt: boolean) => Promise<unknown>,
) {
  return async ([j]: Job<T>[]) => {
    const lastAttempt = j!.retryCount >= RETRY_LIMIT;
    try {
      return await run(j!.data, lastAttempt);
    } catch (e) {
      const safe = safeError(e);
      const { uploadId, monthId } = j!.data ?? {};
      const ids = { queue, jobId: j!.id, uploadId, monthId, attempt: j!.retryCount + 1 };
      log[lastAttempt ? 'error' : 'warn']({ msg: 'job failed', ...ids, ...safe });
      if (lastAttempt) reportError(e, { queue, jobId: j!.id });
      // No `cause`: pg-boss would store the original error's text with it.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${queue} failed: ${safe.code ?? safe.error}`);
    }
  };
}

export async function startWorker(app: INestApplicationContext) {
  const boss = app.get(PgBoss);
  const splitter = app.get(Splitter);
  const reader = app.get(Reader);
  await boss.work<{ uploadId: string }>(
    SPLIT_UPLOAD,
    { localConcurrency: 2 },
    job(SPLIT_UPLOAD, (d, lastAttempt) => splitter.split(d.uploadId, { lastAttempt })),
  );
  // Several uploads at once: one in batch mode mostly waits, and must not hold up the next.
  await boss.work<{ uploadId: string; speed?: ReadSpeed }>(
    READ_UPLOAD,
    { localConcurrency: 4 },
    job(READ_UPLOAD, (d) => reader.read(d.uploadId, d.speed)),
  );
  const purger = app.get(Purger);
  await boss.work<{ monthId: string }>(
    PURGE_MONTH,
    job(PURGE_MONTH, (d) => purger.purge(d.monthId)),
  );
  await boss.work(
    CHECK_MONTHS,
    job(CHECK_MONTHS, () => purger.check()),
  );
  // Every night in Israel time (6.1), and once now: a purge cut short by a restart is finished.
  await boss.schedule(CHECK_MONTHS, '0 3 * * *', null, { tz: AGENCY_TIME_ZONE });
  await boss.send(CHECK_MONTHS);
}
