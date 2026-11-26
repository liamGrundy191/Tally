import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { completeUploadsSchema, signUploadsSchema } from '@tally/shared';
import { Access, CurrentUser } from '../auth/access.ts';
import type { SessionUser } from '../auth/http.ts';
import { validate } from '../validate.ts';
import { UploadsService } from './uploads.service.ts';

@Controller('uploads')
@Access('reviewer')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('sign')
  @HttpCode(200)
  sign(@Body() body: unknown) {
    return this.uploads.sign(validate(signUploadsSchema, body).count);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const { speed, freeForm, files } = validate(completeUploadsSchema, body);
    return this.uploads.complete(user.id, speed, files, freeForm);
  }
}
