// Closing a month (6.1): the request body, shared by the API and the web app.
import { z } from 'zod';

/** The month's name as typed in the Close window ("November 2026"), checked again by the server. */
export const closeMonthSchema = z.object({ name: z.string().max(50) });
