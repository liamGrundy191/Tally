// The job queue: pg-boss, on the same Postgres (section 3). A job is added in the same database
// transaction as the rows it is about, so neither can exist without the other.
import { Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

/** Splits an uploaded file into page images, one ticket per page (step 2). */
export const SPLIT_UPLOAD = 'split-upload';
/** Reads every ticket of one split upload (steps 3–7). */
export const READ_UPLOAD = 'read-upload';

/** Retries after the first attempt: 5 attempts in all (section 10). */
export const RETRY_LIMIT = 4;

export const createBoss = (url: string, schema?: string) =>
  new PgBoss({ connectionString: url, ...(schema && { schema }) });

/** Creates the queue's tables and the queues, if they do not exist yet. */
export async function startQueue(boss: PgBoss) {
  const log = new Logger('Queue');
  boss.on('error', (e) => log.error(e));
  await boss.start();
  // A job that fails is tried again, 5 attempts in all, waiting longer each time (section 10).
  const retries = { retryLimit: RETRY_LIMIT, retryBackoff: true, retryDelay: 5 };
  await boss.createQueue(SPLIT_UPLOAD, { ...retries, expireInSeconds: 30 * 60 });
  // Batch mode usually takes an hour or so per round, so a reading job may run for hours (pg-boss
  // allows 24). The worker sends a heartbeat while it runs: if the worker dies, the job is taken
  // up again within a minute; a job that runs out of time is tried again too. Either way the saved
  // answers are reused.
  await boss.createQueue(READ_UPLOAD, {
    ...retries,
    expireInSeconds: 24 * 60 * 60,
    heartbeatSeconds: 60,
  });
}
