/**
 * Login / logout / session endpoints. Public by design — see AuthGuard.
 */
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { readCookie } from './auth.guard';
import { SESSION_COOKIE } from './session-cookie';

/** Session cookie lifetime in seconds; matches the server-side expiry. */
function cookieMaxAge(service: AuthService): number {
  return Math.max(1, service.sessionTtlSeconds);
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** What the login page should show, and whether auth is even on. */
  @Get('session')
  session(@Req() req: Request) {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
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
    this.auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  }

  /** Change the app-local password. System accounts are changed on the NAS. */
  @Post('password')
  async password(@Req() req: Request, @Body() body: { current?: string; next?: string }) {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const user = this.auth.resolve(token);
    if (!user) return { ok: false, error: '未登录' };
    if (!body?.next || body.next.length < 4) return { ok: false, error: '新密码至少 4 位' };
    await this.auth.changePassword(user.username, body.current ?? '', body.next);
    return { ok: true };
  }
}