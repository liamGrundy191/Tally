import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Checks a request body against its shared schema; the first problem is shown to the user. */
export function validate<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues[0]!.message);
  return result.data;
}
