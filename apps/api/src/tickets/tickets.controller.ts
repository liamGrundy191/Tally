import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  listTicketsSchema,
  saveFreeFormSchema,
  saveTicketSchema,
  ticketVersionSchema,
} from '@tally/shared';
import { z } from 'zod';
import { Access, CurrentUser } from '../auth/access.ts';
import type { SessionUser } from '../auth/http.ts';
import { validate } from '../validate.ts';
import { TicketsService } from './tickets.service.ts';

const ticketId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw new NotFoundException('There is no such ticket.');
  return id;
};

@Controller('tickets')
@Access('reviewer')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.tickets.list(validate(listTicketsSchema, query));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tickets.get(ticketId(id));
  }

  /** The scan straightened to the slip, so the review screen can outline each box on it. */
  @Get(':id/slip')
  @Header('Cache-Control', 'private, no-store')
  async slip(@Param('id') id: string) {
    return new StreamableFile(await this.tickets.slip(ticketId(id)), { type: 'image/jpeg' });
  }

  /** Saves the values; 409 if the ticket changed since it was opened. */
  @Put(':id')
  save(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.save(user.id, ticketId(id), validate(saveTicketSchema, body));
  }

  /** Another ticket's shifts, typed from its scan (D68); 409 if they changed since it was opened. */
  @Put(':id/free-form')
  saveFreeForm(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.saveFreeForm(user.id, ticketId(id), validate(saveFreeFormSchema, body));
  }

  @Post(':id/exclude')
  @HttpCode(204)
  async exclude(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const { version } = validate(ticketVersionSchema, body);
    await this.tickets.exclude(user.id, ticketId(id), version);
  }

  @Post(':id/reprocess')
  @HttpCode(204)
  async reprocess(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { version } = validate(ticketVersionSchema, body);
    await this.tickets.reprocess(user.id, ticketId(id), version);
  }
}

/** The uploads and how far each has come, polled every 3 seconds (section 8). */
@Controller('progress')
@Access('reviewer')
export class ProgressController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  progress() {
    return this.tickets.progress();
  }
}
