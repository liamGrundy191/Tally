import { Body, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { resolveFlagSchema } from '@tally/shared';
import { z } from 'zod';
import { Access, CurrentUser } from '../auth/access.ts';
import type { SessionUser } from '../auth/http.ts';
import { validate } from '../validate.ts';
import { Organiser } from './organiser.ts';

@Controller('flags')
@Access('reviewer')
export class FlagsController {
  constructor(private readonly organiser: Organiser) {}

  /** Same place / different place, or replace / keep both / ignore (5.2, 5.3). */
  @Post(':id/resolve')
  @HttpCode(204)
  async resolve(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(id).success) throw new NotFoundException('There is no such question.');
    const { decision, keepGroupId } = validate(resolveFlagSchema, body);
    await this.organiser.resolve(user.id, id, decision, keepGroupId);
  }
}
