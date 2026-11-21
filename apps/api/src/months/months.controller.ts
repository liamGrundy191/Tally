import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { z } from 'zod';
import { Access } from '../auth/access.ts';
import { MonthsService } from './months.service.ts';

@Controller('months')
@Access('reviewer')
export class MonthsController {
  constructor(private readonly months: MonthsService) {}

  @Get()
  list() {
    return this.months.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new NotFoundException('There is no such month.');
    return this.months.get(id);
  }
}
