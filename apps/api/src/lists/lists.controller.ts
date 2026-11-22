// The workplace and names lists that help reading (5.4), shared by all months (D42).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { LIST_KINDS, type ListKind, parseList, putListSchema } from '@tally/shared';
import { Access, CurrentUser } from '../auth/access.ts';
import type { SessionUser } from '../auth/http.ts';
import { audit } from '../audit.ts';
import { PrismaClient } from '../generated/prisma/client.ts';
import { validate } from '../validate.ts';

function listKind(kind: string): ListKind {
  if (!(LIST_KINDS as readonly string[]).includes(kind)) {
    throw new NotFoundException('There is no such list.');
  }
  return kind as ListKind;
}

@Controller('lists')
@Access('reviewer')
export class ListsController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get(':kind')
  get(@Param('kind') kind: string) {
    return this.prisma.listEntry.findMany({
      where: { kind: listKind(kind) },
      select: { name: true, spellings: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Replaces the whole list with the pasted text. */
  @Put(':kind')
  async replace(@CurrentUser() user: SessionUser, @Param('kind') k: string, @Body() body: unknown) {
    const kind = listKind(k);
    const parsed = parseList(kind, validate(putListSchema, body).text);
    if (!parsed.ok) throw new BadRequestException(parsed.problem);
    await this.prisma.$transaction(async (tx) => {
      // A review save adding a name, or a "same place" adding a spelling, would otherwise be lost.
      const lock = kind === 'name' ? 'names' : 'workplaces';
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))`;
      const before = await tx.listEntry.deleteMany({ where: { kind } });
      await tx.listEntry.createMany({ data: parsed.entries.map((e) => ({ kind, ...e })) });
      // The counts only: the names are not kept in the audit trail, which outlives the lists.
      await audit(tx, {
        userId: user.id,
        action: 'replace-list',
        entity: 'ListEntry',
        entityId: kind,
        before: { entries: before.count },
        after: { entries: parsed.entries.length },
      });
    });
    return this.get(kind);
  }
}
