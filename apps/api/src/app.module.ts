import { Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PgBoss } from 'pg-boss';
import { AccessGuard } from './auth/access.ts';
import { AuthController } from './auth/auth.controller.ts';
import { AuthService } from './auth/auth.service.ts';
import { createPrisma } from './db.ts';
import { HealthController } from './health.controller.ts';
import { flushReports } from './observability.ts';
import { PrismaClient } from './generated/prisma/client.ts';
import { ListsController } from './lists/lists.controller.ts';
import { MonthsController } from './months/months.controller.ts';
import { FlagsController } from './months/flags.controller.ts';
import { ExcelExporter } from './months/excel.ts';
import { WorkplacePdfExporter } from './months/pdfs.ts';
import { MonthsService } from './months/months.service.ts';
import { Organiser } from './months/organiser.ts';
import { Purger } from './months/purge.ts';
import { createBoss, startQueue } from './queue.ts';
import { ReadingConfig } from './reading/config.ts';
import { Reader } from './reading/reader.ts';
import { Storage } from './storage.ts';
import { TemplatesController } from './templates/templates.controller.ts';
import { ProgressController, TicketsController } from './tickets/tickets.controller.ts';
import { TicketsService } from './tickets/tickets.service.ts';
import { Splitter } from './uploads/splitter.ts';
import { UploadsController } from './uploads/uploads.controller.ts';
import { UploadsService } from './uploads/uploads.service.ts';
import { UsersController } from './users/users.controller.ts';
import { UsersService } from './users/users.service.ts';

@Module({
  controllers: [
    AuthController,
    UsersController,
    UploadsController,
    MonthsController,
    ListsController,
    FlagsController,
    TicketsController,
    ProgressController,
    TemplatesController,
    HealthController,
  ],
  providers: [
    // Connect on first use or on start; main.ts refuses to start without DATABASE_URL.
    { provide: PrismaClient, useFactory: () => createPrisma(process.env.DATABASE_URL ?? '') },
    { provide: PgBoss, useFactory: () => createBoss(process.env.DATABASE_URL ?? '') },
    { provide: Storage, useFactory: () => Storage.fromEnv() },
    { provide: ReadingConfig, useFactory: () => ReadingConfig.fromEnv() },
    AuthService,
    UsersService,
    UploadsService,
    Splitter,
    Reader,
    MonthsService,
    ExcelExporter,
    WorkplacePdfExporter,
    Organiser,
    Purger,
    TicketsService,
    // Every route must declare its access (section 11).
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly boss: PgBoss,
  ) {}

  onModuleInit() {
    return startQueue(this.boss);
  }

  async onModuleDestroy() {
    await this.boss.stop();
    await this.prisma.$disconnect();
    await flushReports();
  }
}
