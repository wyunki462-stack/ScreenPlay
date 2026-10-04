/**
 * Session guard for the whole API.
 *
 * The session token travels in an httpOnly cookie so browser JS cannot read it,
 * with a Bearer header accepted as well for scripted checks. `/api/health` and
 * the auth endpoints stay public — health must work before anyone logs in (the
 * container healthcheck depends on it), and the login page needs to reach auth.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './session-cookie';

export const PUBLIC_PATHS = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/logout',
  // Password change resolves the cookie itself and answers `{ ok: false }` for
  // an absent session. Keeping it public means the response shape is uniform and
  // that a wrong-password / signed-out attempt is a normal JSON reply instead of
  // a guard 401 (which the Web client would broadcast as "session lost").
  '/api/auth/password',
  // First-run account creation must be reachable without a session, otherwise
  // there would be no way to get in on a fresh Windows install.
  '/api/auth/setup',
];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.auth.enabled) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const res = context.switchToHttp().getResponse<Response>();
    const path = (req.path || req.url || '').split('?')[0];

    // Static SPA assets and anything outside /api must stay reachable, otherwise
    // the login page itself could not load.
    if (!path.startsWith('/api/')) return true;
    if (PUBLIC_PATHS.includes(path)) return true;

    const user = this.currentUser(req);
    if (!user) throw new UnauthorizedException('未登录或会话已过期');
    req.user = user;
    // Keep the cookie alive on activity so an active user is not signed out.
    res.setHeader('Cache-Control', 'no-store');
    return true;
  }

  /** Resolve the caller from the cookie or an Authorization header. */
  currentUser(req: Request) {
    const cookieToken = readCookie(req.headers.cookie, SESSION_COOKIE);
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    return this.auth.resolve(cookieToken || bearer);
  }
}

/** Minimal cookie reader — avoids adding a cookie-parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}