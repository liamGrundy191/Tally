import { Controller, Get, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { Access } from '../auth/access.ts';
import { ExcelExporter } from './excel.ts';
import { MonthsService } from './months.service.ts';

const monthId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw new NotFoundException('There is no such month.');
  return id;
};

@Controller('months')
@Access('reviewer')
export class MonthsController {
  constructor(
    private readonly months: MonthsService,
    private readonly excel: ExcelExporter,
  ) {}

  @Get()
  list() {
    return this.months.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.months.get(monthId(id));
  }

  /** The month's Excel file (6.2), made from the ready tickets as they are now. */
  @Get(':id/excel')
  async download(@Param('id') id: string) {
    const { file, filename } = await this.excel.export(monthId(id));
    return new StreamableFile(file, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
