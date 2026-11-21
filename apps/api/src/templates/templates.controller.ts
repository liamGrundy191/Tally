// The blank printable ticket (section 9, Ticket template screen).
import { Controller, Get, StreamableFile } from '@nestjs/common';
import { renderTicketPdf } from '@tally/shared/ticket-pdf';
import { Access } from '../auth/access.ts';

@Controller('templates')
@Access('reviewer')
export class TemplatesController {
  @Get('v1/pdf')
  async v1() {
    return new StreamableFile(await renderTicketPdf(), {
      type: 'application/pdf',
      disposition: 'attachment; filename="tickets-v1.pdf"',
    });
  }
}
