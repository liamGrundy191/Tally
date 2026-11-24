import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './http-setup.js';
import { flushReports, initSentry, reportError, safeError } from './observability.js';
import { startWorker } from './worker.js';

// One JSON line per event in production, readable locally (section 10, D59).
const logger = new ConsoleLogger({ json: process.env.NODE_ENV === 'production' });

async function bootstrap() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example).');
  initSentry();
  if (process.env.MODE === 'worker') {
    const worker = await NestFactory.createApplicationContext(AppModule, { logger });
    worker.enableShutdownHooks();
    await startWorker(worker);
    return;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}

// Node would stop anyway; this only keeps the error's text out of the log (D59).
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (e: unknown) => {
    logger.fatal({ msg: event, ...safeError(e) });
    reportError(e);
    void flushReports().finally(() => process.exit(1));
  });
}

// Starting up touches no ticket yet: the full text ("DATABASE_URL is not set") helps most.
bootstrap().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
