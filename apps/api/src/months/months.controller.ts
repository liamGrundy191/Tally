import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { addMorningSchema, closeMonthSchema } from '@tally/shared';
import { z } from 'zod';
import { Access, CurrentUser } from '../auth/access.ts';
import type { SessionUser } from '../auth/http.ts';
import { validate } from '../validate.ts';
import { ExcelExporter } from './excel.ts';
import { WorkplacePdfExporter } from './pdfs.ts';
import { MonthsService } from './months.service.ts';
import { Purger } from './purge.ts';

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
    private readonly purger: Purger,
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
  async download(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    // Counted from before the file is read: a save meanwhile is not in it (D66).
    const madeAt = new Date();
    const { file, filename } = await this.excel.export(monthId(id));
    await this.months.recordDownload(user.id, id, 'excel', madeAt);
    return new StreamableFile(file, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** The workplace PDFs (6.3): all of them in one ZIP, or one workplace's with ?workplace=. */
  @Get(':id/pdfs')
  @Header('Cache-Control', 'private, no-store')
  async workplacePdfs(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('workplace') workplace?: string,
  ) {
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
    const madeAt = new Date();
    const file = await this.pdfs.all(monthId(id));
    // Only all the PDFs count towards closing (6.1), not one workplace's.
    await this.months.recordDownload(user.id, id, 'pdfs', madeAt);
    return new StreamableFile(Readable.from(file.zip), {
      type: 'application/zip',
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  /** Morning hours for a place (D66): only the totals sheet's בוקר column. */
  @Post(':id/morning')
  @HttpCode(204)
  async addMorning(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { place, hours } = validate(addMorningSchema, body);
    await this.months.addMorning(user.id, monthId(id), place, hours);
  }

  @Delete(':id/morning/:entry')
  @HttpCode(204)
  async removeMorning(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('entry') entry: string,
  ) {
    if (!z.uuid().safeParse(entry).success) {
      throw new NotFoundException('There are no such morning hours.');
    }
    await this.months.removeMorning(user.id, monthId(id), entry);
  }

  /** Close month (6.1): the month's name typed, both files downloaded, every ticket settled. */
  @Post(':id/close')
  @HttpCode(202)
  async close(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    // The month is looked up first, so an unknown one is a 404 whatever was sent; a missing or
    // wrong name is then refused as not the month's name.
    const name = closeMonthSchema.safeParse(body).data?.name ?? '';
    await this.purger.close(user.id, monthId(id), name);
  }
}
