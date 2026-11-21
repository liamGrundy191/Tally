// Uploading scans (plan sections 4 and 8): the limits and request bodies, shared by the API and
// the web app so the web app can warn before uploading.
import { z } from 'zod';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
/** Files per request; a weekly batch is a few PDFs or a few dozen photos. */
export const MAX_FILES_PER_REQUEST = 100;

/** `uploads/<random UUID>`, as /uploads/sign gives it. The UUID becomes the upload's id. */
export const UPLOAD_KEY =
  /^uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const signUploadsSchema = z.object({
  count: z.int().min(1).max(MAX_FILES_PER_REQUEST),
});

/** Now: read straight away. Batch: Anthropic's batch service, half the price, usually within an hour (D26). */
export const READ_SPEEDS = ['batch', 'now'] as const;
export type ReadSpeed = (typeof READ_SPEEDS)[number];

export const completeUploadsSchema = z.object({
  speed: z.enum(READ_SPEEDS).default('batch'),
  files: z
    .array(
      z.object({
        key: z.string().regex(UPLOAD_KEY, 'That file was not uploaded here.'),
        name: z.string().trim().min(1).max(255),
      }),
    )
    .min(1)
    .max(MAX_FILES_PER_REQUEST),
});

/** What happened to each file. `duplicate` and `rejected` come with a message for the user. */
export type UploadResult =
  | { key: string; status: 'queued'; uploadId: string; pages: number }
  | { key: string; status: 'duplicate' | 'rejected'; message: string };
