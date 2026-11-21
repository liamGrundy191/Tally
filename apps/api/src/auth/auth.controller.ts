import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { acceptInviteSchema, loginSchema } from '@tally/shared';
import { UsersService } from '../users/users.service.ts';
import { validate } from '../validate.ts';
import { Access, CurrentUser } from './access.ts';
import { AuthService } from './auth.service.ts';
import {
  CSRF_COOKIE,
  csrfCookie,
  type Req as Request,
  type Res as Response,
  readCookie,
  SESSION_COOKIE,
  type SessionUser,
  sessionCookie,
} from './http.ts';
import { newToken } from './tokens.ts';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Access('public')
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email, password } = validate(loginSchema, body);
    const { token, user } = await this.auth.login(email, password, req.ip ?? 'unknown');
    this.startSession(req, res, token);
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  @Access('reviewer')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.sessionToken!);
    res.clearCookie(SESSION_COOKIE, sessionCookie);
  }

  /** The web app asks this first; it also gives back a CSRF cookie the browser has lost. */
  @Get('me')
  @Access('reviewer')
  me(
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!readCookie(req, CSRF_COOKIE)) res.cookie(CSRF_COOKIE, newToken(), csrfCookie);
    return user;
  }

  @Post('accept-invite')
  @HttpCode(200)
  @Access('public')
  async acceptInvite(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, password } = validate(acceptInviteSchema, body);
    const user = await this.users.acceptInvite(token, password);
    this.startSession(req, res, await this.auth.openSession(user.id));
    return user;
  }

  /** Sets the session cookie, and a CSRF cookie for the web app to copy into its requests. */
  private startSession(req: Request, res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, sessionCookie);
    if (!readCookie(req, CSRF_COOKIE)) res.cookie(CSRF_COOKIE, newToken(), csrfCookie);
  }
}
