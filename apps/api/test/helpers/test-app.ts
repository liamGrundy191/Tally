// The real API over HTTP, on a throwaway database schema (and file storage bucket, when given).
import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { PgBoss } from 'pg-boss';
import { AppModule } from '../../src/app.module.ts';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { createBoss } from '../../src/queue.ts';
import { ReadingConfig } from '../../src/reading/config.ts';
import { Storage } from '../../src/storage.ts';
import type { TestDatabase } from './test-db.ts';

export async function testApp(
  db: TestDatabase,
  opts: { storage?: Storage; reading?: ReadingConfig; controllers?: Type[] } = {},
) {
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: opts.controllers ?? [],
  })
    .overrideProvider(PrismaClient)
    .useValue(db.prisma)
    .overrideProvider(PgBoss)
    .useValue(createBoss(db.url, db.queueSchema));
  if (opts.storage) builder = builder.overrideProvider(Storage).useValue(opts.storage);
  if (opts.reading) builder = builder.overrideProvider(ReadingConfig).useValue(opts.reading);
  const app = (await builder.compile()).createNestApplication();
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` };
}
