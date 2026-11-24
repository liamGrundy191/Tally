// What the app tells its operators (T4.2, D59): logs and error reports carry error codes, ids and
// where the code failed, never ticket values, names, emails or secrets. A database or library error's
// text can quote the values it was given ("(firstName)=(Kwame)"), so it is dropped; the text of an
// error the app chose to answer with, or of a system error ("connect ECONNREFUSED"), is kept.
import { type ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

export interface SafeError {
  error: string;
  code?: string | number;
  status?: number;
  message?: string;
  frames?: string[];
}

export function safeError(e: unknown): SafeError {
  if (!(e instanceof Error)) return { error: typeof e };
  const { code, syscall } = e as { code?: unknown; syscall?: unknown };
  // A system call's error ("connect ECONNREFUSED 10.0.0.5:5432") names no ticket; Node's other
  // errors (ERR_…) can quote the value they were given, so only their code is kept.
  const own = e instanceof HttpException || typeof syscall === 'string';
  return {
    error: e.name,
    ...((typeof code === 'string' || typeof code === 'number') && { code }),
    ...(e instanceof HttpException && { status: e.getStatus() }),
    ...(own && { message: e.message }),
    // The stack starts with the message, which may span lines that look like frames.
    frames: (e.stack ?? '')
      .split('\n')
      .slice(e.message.split('\n').length)
      .filter((l) => /^\s+at /.test(l))
      .map((l) => l.trim()),
  };
}

/** Error reports (section 10): on only when SENTRY_DSN is set, never in tests unless one asks. */
export function initSentry(
  env: NodeJS.ProcessEnv = process.env,
  extra: Partial<Sentry.NodeOptions> = {},
) {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // No automatic capture of requests, logs or local variables: only what reportError sends.
    defaultIntegrations: false,
    enableRuntimeChannelInjection: false,
    beforeBreadcrumb: () => null,
    beforeSend: scrub,
    ...extra,
  });
  return true;
}

/** Keeps only the error's type, its safe text or code, where it happened, and the given ids. */
export function scrub(event: Sentry.ErrorEvent, hint: Sentry.EventHint): Sentry.ErrorEvent {
  const safe = safeError(hint.originalException);
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    sdk: event.sdk,
    tags: event.tags,
    exception: {
      values: event.exception?.values?.map((v) => ({
        type: v.type,
        value: safe.message ?? String(safe.code ?? ''),
        mechanism: v.mechanism && { type: v.mechanism.type, handled: v.mechanism.handled },
        stacktrace: v.stacktrace && {
          frames: v.stacktrace.frames?.map((f) => ({
            filename: f.filename,
            function: f.function,
            lineno: f.lineno,
            colno: f.colno,
            in_app: f.in_app,
          })),
        },
      })),
    },
  };
}

/** Sends an error to Sentry (if on), tagged with ids only. */
export function reportError(e: unknown, tags: Record<string, string> = {}) {
  Sentry.captureException(e, { tags });
}

export const flushReports = (ms = 2000) => Sentry.flush(ms);

/**
 * Every error of a request. One the app answered on purpose (a refusal, 4xx) goes out as usual;
 * anything else is logged and reported safely and answered with Nest's usual 500, so Nest's own
 * handler never logs its text.
 */
@Catch()
export class SafeErrorFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Http');

  override catch(e: unknown, host: ArgumentsHost) {
    if (e instanceof HttpException && e.getStatus() < 500) return super.catch(e, host);
    const req = host.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
    // The route's pattern, never the address: a query string can hold a name.
    const route = req.route?.path ?? 'unknown';
    this.log.error({ msg: 'request failed', method: req.method, route, ...safeError(e) });
    reportError(e, { route });
    super.catch(
      e instanceof HttpException
        ? e
        : new HttpException({ statusCode: 500, message: 'Internal server error' }, 500),
      host,
    );
  }
}
