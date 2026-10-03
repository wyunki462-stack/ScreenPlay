/**
 * Login / logout / session endpoints. Public by design — see AuthGuard.
 */
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, type PasswordChangeResult } from './auth.service';
import { readCookie } from './auth.guard';
import { SESSION_COOKIE } from './session-cookie';

/** Session cookie lifetime in seconds; matches the server-side expiry. */
function cookieMaxAge(service: AuthService): number {
  return Math.max(1, service.sessionTtlSeconds);
}

/**
 * Resolve the caller's session token from the cookie (Web / browser) or from an
 * `Authorization: Bearer` header (the Flutter Android client, which keeps no
 * cookie jar and therefore sends the token it got from `Set-Cookie`).
 *
 * Mirrors `AuthGuard.currentUser` so both credential channels agree on who the
 * caller is; cookie behaviour is untouched, the header is purely additive.
 */
function sessionTokenOf(req: Request): string | undefined {
  const cookieToken = readCookie(req.headers.cookie, SESSION_COOKIE);
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
  return cookieToken || bearer || undefined;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** What the login page should show, and whether auth is even on. */
  @Get('session')
  session(@Req() req: Request) {
    const token = sessionTokenOf(req);
    const user = this.auth.resolve(token);
    return { ...this.auth.describe(), authenticated: !!user, user };
  }

  @Post('login')
  async login(
    @Body() body: { username?: string; password?: string; remember?: boolean },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const username = (body?.username ?? '').trim();
    const password = body?.password ?? '';
    const result = await this.auth.login(username, password, req.headers['user-agent']);

    // Persistent cookie → a browser restart keeps the user signed in. `remember:
    // false` gives a session-scoped cookie instead.
    const secure = (req.headers['x-forwarded-proto'] ?? '').toString().includes('https');
    const attrs = [
      `${SESSION_COOKIE}=${encodeURIComponent(result.token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (body?.remember !== false) attrs.push(`Max-Age=${cookieMaxAge(this.auth)}`);
    if (secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));

    return { ok: true, user: result.user, expiresAt: result.expiresAt };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.auth.logout(sessionTokenOf(req));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  }

  /**
   * Change the app-local password. System accounts are changed on the NAS.
   *
   * Everything — including a wrong current password — comes back as HTTP 200
   * with `{ ok: false, code, error }`. A 401 here would be read by the Web
   * client as "the session went away" (it broadcasts 401 to the login gate), so
   * a simple typo must not be able to sign the user out.
   */
  @Post('password')
  async password(
    @Req() req: Request,
    @Body() body: { current?: string; next?: string },
  ): Promise<PasswordChangeResult> {
    const token = sessionTokenOf(req);
    const user = this.auth.resolve(token);
    if (!user) {
      return { ok: false, code: 'unauthenticated', error: '未登录或会话已过期，请重新登录' };
    }
    return this.auth.changePassword(user, body?.current ?? '', body?.next ?? '', token);
  }
}