import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './http-setup.js';
import { startWorker } from './worker.js';

async function bootstrap() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example).');
  if (process.env.MODE === 'worker') {
    const worker = await NestFactory.createApplicationContext(AppModule);
    worker.enableShutdownHooks();
    await startWorker(worker);
    return;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
