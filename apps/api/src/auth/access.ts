// Every route declares who may call it (section 11); the guard refuses any route that does not.
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.ts';
import { CSRF_COOKIE, CSRF_HEADER, type Req, readCookie, SESSION_COOKIE } from './http.ts';
import { sameSecret } from './tokens.ts';

/** `public`: no login needed. `reviewer`: any logged-in user. `admin`: admins only. */
export type AccessLevel = 'public' | 'reviewer' | 'admin';
const ACCESS = 'access';
export const Access = (level: AccessLevel) => SetMetadata(ACCESS, level);

/** The logged-in user of a `reviewer` or `admin` route. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>().user!,
);

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const level = this.reflector.getAllAndOverride<AccessLevel | undefined>(ACCESS, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // A route that forgot to declare its access is refused, never opened by mistake.
    if (!level) throw new ForbiddenException('This route has no access rule.');
    const req = ctx.switchToHttp().getRequest<Req>();
    if (level === 'public') {
      // Logging in has no session to check a CSRF token against. A form on another site can
      // only send form or plain text bodies, never JSON, so a change must be sent as JSON.
      const type = String(req.headers['content-type'] ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      if (CHANGES.has(req.method) && type !== 'application/json') {
        throw new ForbiddenException('The page is out of date. Reload it and try again.');
      }
      return true;
    }

    const token = readCookie(req, SESSION_COOKIE);
    const user = token ? await this.auth.userForSession(token) : null;
    if (!user) throw new UnauthorizedException('Please log in.');
    if (CHANGES.has(req.method)) {
      // Double-submit CSRF check: another site can make the browser send our cookies, but it
      // cannot read the CSRF cookie to copy it into the header.
      const header = req.headers[CSRF_HEADER];
      const cookie = readCookie(req, CSRF_COOKIE);
      if (typeof header !== 'string' || !cookie || !sameSecret(header, cookie)) {
        throw new ForbiddenException('The page is out of date. Reload it and try again.');
      }
    }
    if (level === 'admin' && user.role !== 'admin') {
      throw new ForbiddenException('Only an admin can do this.');
    }
    req.user = user;
    req.sessionToken = token;
    return true;
  }
}
