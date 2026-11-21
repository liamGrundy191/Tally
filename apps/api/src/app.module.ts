import { Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './auth/access.ts';
import { AuthController } from './auth/auth.controller.ts';
import { AuthService } from './auth/auth.service.ts';
import { createPrisma } from './db.ts';
import { PrismaClient } from './generated/prisma/client.ts';
import { UsersController } from './users/users.controller.ts';
import { UsersService } from './users/users.service.ts';

@Module({
  controllers: [AuthController, UsersController],
  providers: [
    // Connects on the first query; main.ts refuses to start without DATABASE_URL.
    { provide: PrismaClient, useFactory: () => createPrisma(process.env.DATABASE_URL ?? '') },
    AuthService,
    UsersService,
    // Every route must declare its access (section 11).
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(private readonly prisma: PrismaClient) {}

  onModuleDestroy() {
    return this.prisma.$disconnect();
  }
}
