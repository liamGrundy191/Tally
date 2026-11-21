import { Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { inviteSchema, updateUserSchema } from '@tally/shared';
import { z } from 'zod';
import { Access, CurrentUser } from '../auth/access.ts';
import type { SessionUser } from '../auth/http.ts';
import { validate } from '../validate.ts';
import { UsersService } from './users.service.ts';

@Controller('users')
@Access('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post('invite')
  invite(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { email, role } = validate(inviteSchema, body);
    return this.users.invite(user.id, email, role, process.env.APP_URL ?? 'http://localhost:5173');
  }

  @Patch(':id')
  update(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(id).success) throw new NotFoundException('There is no such user.');
    return this.users.update(user.id, id, validate(updateUserSchema, body));
  }
}
