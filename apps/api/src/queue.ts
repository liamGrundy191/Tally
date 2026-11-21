// The job queue: pg-boss, on the same Postgres (section 3). A job is added in the same database
// transaction as the rows it is about, so neither can exist without the other.
import { Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

/** Splits an uploaded file into page images, one ticket per page (step 2). */
export const SPLIT_UPLOAD = 'split-upload';
/** Reads one ticket (steps 3–7; the worker for it comes in T1.4). */
export const READ_TICKET = 'read-ticket';

export const createBoss = (url: string, schema?: string) =>
  new PgBoss({ connectionString: url, ...(schema && { schema }) });

/** Creates the queue's tables and the queues, if they do not exist yet. */
export async function startQueue(boss: PgBoss) {
  const log = new Logger('Queue');
  boss.on('error', (e) => log.error(e));
  await boss.start();
  for (const name of [SPLIT_UPLOAD, READ_TICKET]) {
    // A job that fails is retried 5 times, waiting longer each time (section 10).
    await boss.createQueue(name, { retryLimit: 5, retryBackoff: true, expireInSeconds: 30 * 60 });
  }
}
