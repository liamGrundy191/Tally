// The background worker (MODE=worker): the same app, taking jobs from the queue instead of
// answering requests.
import type { INestApplicationContext } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { READ_UPLOAD, RETRY_LIMIT, SPLIT_UPLOAD } from './queue.ts';
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
  await boss.work<{ uploadId: string }>(READ_UPLOAD, { localConcurrency: 4 }, ([job]) =>
    reader.read(job!.data.uploadId),
  );
}
