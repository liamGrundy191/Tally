// The background worker (MODE=worker): the same app, taking jobs from the queue instead of
// answering requests.
import type { INestApplicationContext } from '@nestjs/common';
import { AGENCY_TIME_ZONE, type ReadSpeed } from '@tally/shared';
import { PgBoss } from 'pg-boss';
import { Purger } from './months/purge.ts';
import { CHECK_MONTHS, PURGE_MONTH, READ_UPLOAD, RETRY_LIMIT, SPLIT_UPLOAD } from './queue.ts';
import { Reader } from './reading/reader.ts';
import { Splitter } from './uploads/splitter.ts';

export async function startWorker(app: INestApplicationContext) {
  const boss = app.get(PgBoss);
  const splitter = app.get(Splitter);
  const reader = app.get(Reader);
  await boss.work<{ uploadId: string }>(SPLIT_UPLOAD, { localConcurrency: 2 }, ([job]) =>
    splitter.split(job!.data.uploadId, { lastAttempt: job!.retryCount >= RETRY_LIMIT }),
  );
  // Several uploads at once: one in batch mode mostly waits, and must not hold up the next.
  await boss.work<{ uploadId: string; speed?: ReadSpeed }>(
    READ_UPLOAD,
    { localConcurrency: 4 },
    ([job]) => reader.read(job!.data.uploadId, job!.data.speed),
  );
  const purger = app.get(Purger);
  await boss.work<{ monthId: string }>(PURGE_MONTH, ([job]) => purger.purge(job!.data.monthId));
  await boss.work(CHECK_MONTHS, () => purger.check());
  // Every night in Israel time (6.1), and once now: a purge cut short by a restart is finished.
  await boss.schedule(CHECK_MONTHS, '0 3 * * *', null, { tz: AGENCY_TIME_ZONE });
  await boss.send(CHECK_MONTHS);
}
