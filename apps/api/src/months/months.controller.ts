import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { Access } from '../auth/access.ts';
import { ExcelExporter } from './excel.ts';
import { WorkplacePdfExporter } from './pdfs.ts';
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
    private readonly pdfs: WorkplacePdfExporter,
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
  @Header('Cache-Control', 'private, no-store')
  async download(@Param('id') id: string) {
    const { file, filename } = await this.excel.export(monthId(id));
    return new StreamableFile(file, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** The workplace PDFs (6.3): all of them in one ZIP, or one workplace's with ?workplace=. */
  @Get(':id/pdfs')
  @Header('Cache-Control', 'private, no-store')
  async workplacePdfs(@Param('id') id: string, @Query('workplace') workplace?: string) {
    if (workplace !== undefined) {
      if (!z.uuid().safeParse(workplace).success) {
        throw new NotFoundException('This workplace has no ready tickets in this month.');
      }
      const file = await this.pdfs.one(monthId(id), workplace);
      // A Hebrew name needs filename* (RFC 5987); the plain one is for browsers without it.
      const encoded = encodeURIComponent(file.filename).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return new StreamableFile(file.pdf, {
        type: 'application/pdf',
        disposition: `attachment; filename="workplace.pdf"; filename*=UTF-8''${encoded}`,
      });
    }
    const file = await this.pdfs.all(monthId(id));
    return new StreamableFile(Readable.from(file.zip), {
      type: 'application/zip',
      disposition: `attachment; filename="${file.filename}"`,
    });
  }
}
