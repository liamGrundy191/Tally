// The background worker (MODE=worker): the same app, taking jobs from the queue instead of
// answering requests.
import type { INestApplicationContext } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { SPLIT_UPLOAD } from './queue.ts';
import { Splitter } from './uploads/splitter.ts';

export async function startWorker(app: INestApplicationContext) {
  const boss = app.get(PgBoss);
  const splitter = app.get(Splitter);
  await boss.work<{ uploadId: string }>(SPLIT_UPLOAD, { localConcurrency: 2 }, ([job]) =>
    splitter.split(job!.data.uploadId),
  );
}
