/**
 * Local-only authentication.
 *
 * Two providers, both entirely on-box:
 *   - `system` — verify against the NAS host's own accounts (see
 *     {@link SystemUsersService}); the password is checked against the mounted
 *     shadow hash and never stored.
 *   - `local`  — app-managed accounts with scrypt hashes in the app database.
 *     Used when the host user database is not mounted, so a fresh install still
 *     has a way in.
 *
 * Sessions live in the SQLite data volume, so a container restart keeps the user
 * signed in. Nothing here talks to any external service.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { SystemUsersService } from './system-users.service';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/** scrypt cost. N=16384/r=8/p=1 is the standard interactive-login setting. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export interface SessionUser {
  username: string;
  displayName: string;
  provider: 'system' | 'local';
  uid?: number;
}

export interface LoginResult {
  token: string;
  expiresAt: number;
  user: SessionUser;
}

/** Shortest password the API accepts (`POST /api/auth/password`). */
export const PASSWORD_MIN_LENGTH = 4;
/** Sane upper bound; scrypt cost grows with the input, nothing real is this long. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Outcome of a password change. Business failures are values, not exceptions: a
 * mistyped current password must not surface as HTTP 401, because the Web client
 * treats any 401 as "the session is gone" and would bounce the user to the login
 * screen.
 */
export interface PasswordChangeResult {
  ok: boolean;
  /** Stable machine-readable reason, present only when `ok === false`. */
  code?:
    | 'unauthenticated'
    | 'not_local'
    | 'wrong_current'
    | 'blank'
    | 'too_short'
    | 'too_long'
    | 'same';
  /** Human-readable (Chinese) reason for the UI. */
  error?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly systemUsers: SystemUsersService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('认证已禁用（AUTH_DISABLED=1）——所有接口无需登录即可访问');
      return;
    }

    const dropped = this.pruneSessions();
    if (dropped > 0) this.logger.log(`清理过期会话 ${dropped} 个`);

    const provider = this.effectiveProvider();
    if (provider === 'system') {
      const count = this.systemUsers.loginableUsers().length;
      this.logger.log(`认证模式：NAS 系统账户（检测到 ${count} 个可登录账户）`);
    } else {
      this.systemUsers.logUnavailable();
      this.logger.warn('认证模式：本地账户（回退）。如需使用 NAS 系统账户，请按 docker-compose.yml 挂载宿主 /etc。');
    }

    if (this.enabled && this.setupAllowed) {
      // First-run setup mode (Windows desktop default): do NOT seed an account —
      // the login page creates it instead, so the user picks their own password.
      this.logger.log('本地认证已开启：尚未创建账户，请在登录页创建（AUTH_ALLOW_SETUP=1 生效）');
      return;
    }

    // Always seed a local admin so there is a way in even if the mount is later
    // removed or the system account cannot be verified.
    await this.ensureLocalAdmin();
  }

  get enabled(): boolean {
    return this.config.get('authEnabled', { infer: true });
  }

  get mode(): 'system' | 'local' {
    return this.config.get('authMode', { infer: true });
  }

  /** Whether the first-run "create account" flow is enabled (`AUTH_ALLOW_SETUP`). */
  get setupAllowed(): boolean {
    return this.config.get('authAllowSetup', { infer: true });
  }

  /** How many app-local accounts exist (NAS system accounts are never counted). */
  localUserCount(): number {
    return this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM auth_users')?.c ?? 0;
  }

  /** This server still has to be set up before anyone can sign in. */
  needsSetup(): boolean {
    return this.enabled && this.setupAllowed && this.localUserCount() === 0;
  }

  private sessionTtlMs(): number {
    return this.config.get('authSessionDays', { infer: true }) * 24 * 3600 * 1000;
  }

  /** Session lifetime in seconds — drives the cookie Max-Age. */
  get sessionTtlSeconds(): number {
    return Math.round(this.sessionTtlMs() / 1000);
  }

  /** Which provider a login would actually use right now. */
  effectiveProvider(): 'system' | 'local' {
    if (this.mode === 'local') return 'local';
    return this.systemUsers.available() ? 'system' : 'local';
  }

  // ---------------------------------------------------------------- scrypt ---

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT.keylen, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 64 * 1024 * 1024,
    });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  private async verifyScrypt(password: string, stored: string): Promise<boolean> {
    const f = stored.split('$');
    if (f.length !== 6 || f[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, keyB64] = f;
    try {
      const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Buffer.from(keyB64, 'base64').length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: 64 * 1024 * 1024,
      });
      const expected = Buffer.from(keyB64, 'base64');
      return key.length === expected.length && timingSafeEqual(key, expected);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------- local accounts ---

  private findLocal(username: string): { password_hash: string; display_name: string | null } | null {
    return (
      this.db.get<{ password_hash: string; display_name: string | null }>(
        'SELECT password_hash, display_name FROM auth_users WHERE username = ?',
        [username],
      ) ?? null
    );
  }

  /** Create the local admin on first run so the app is never unreachable. */
  async ensureLocalAdmin(): Promise<void> {
    const existing = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM auth_users');
    if ((existing?.c ?? 0) > 0) return;

    const configured = this.config.get('authAdminPassword', { infer: true });
    const generated: string | null = configured ? null : randomBytes(9).toString('base64url');
    const password: string = configured || generated || randomBytes(9).toString('base64url');
    await this.setLocalPassword('admin', password, '管理员');
    if (generated) {
      // Printed once, then only recoverable by setting AUTH_ADMIN_PASSWORD.
      this.logger.warn(
        `已创建本地管理员账户 admin，初始密码：${generated}（请登录后立即修改；` +
          `设置 AUTH_ADMIN_PASSWORD 可固定初始密码）`,
      );
    } else {
      this.logger.log('已按 AUTH_ADMIN_PASSWORD 创建本地管理员账户 admin');
    }
  }

  async setLocalPassword(username: string, password: string, displayName?: string): Promise<void> {
    const hash = await this.hashPassword(password);
    const now = Date.now();
    const existing = this.findLocal(username);
    if (existing) {
      this.db.run('UPDATE auth_users SET password_hash = ?, display_name = COALESCE(?, display_name), updated_at = ? WHERE username = ?', [
        hash,
        displayName ?? null,
        now,
        username,
      ]);
    } else {
      this.db.run(
        'INSERT INTO auth_users (username, password_hash, display_name, created_at, updated_at) VALUES (?,?,?,?,?)',
        [username, hash, displayName ?? username, now, now],
      );
    }
  }

  // ------------------------------------------------------------ sessions ---

  private createSession(username: string, provider: 'system' | 'local', userAgent?: string): LoginResult {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs();
    this.db.run(
      `INSERT INTO auth_sessions (token, username, provider, created_at, expires_at, last_seen, user_agent)
       VALUES (?,?,?,?,?,?,?)`,
      [token, username, provider, now, expiresAt, now, userAgent ?? null],
    );
    return {
      token,
      expiresAt,
      user: {
        username,
        displayName: this.displayName(username, provider),
        provider,
        ...(provider === 'system' ? { uid: this.systemUsers.users().get(username)?.uid } : {}),
      },
    };
  }

  private displayName(username: string, provider: 'system' | 'local'): string {
    if (provider === 'system') {
      const gecos = this.systemUsers.users().get(username)?.gecos ?? '';
      const name = gecos.split(',')[0].trim();
      return name || username;
    }
    const local = this.findLocal(username);
    return local?.display_name ?? username;
  }

  /** Resolve a session token, expiring it when past its deadline. */
  resolve(token: string | undefined): SessionUser | null {
    if (!token) return null;
    const row = this.db.get<{
      username: string;
      provider: 'system' | 'local';
      expires_at: number;
    }>('SELECT username, provider, expires_at FROM auth_sessions WHERE token = ?', [token]);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.db.run('DELETE FROM auth_sessions WHERE token = ?', [token]);
      return null;
    }
    this.db.run('UPDATE auth_sessions SET last_seen = ? WHERE token = ?', [Date.now(), token]);
    return {
      username: row.username,
      provider: row.provider,
      displayName: this.displayName(row.username, row.provider),
      ...(row.provider === 'system' ? { uid: this.systemUsers.users().get(row.username)?.uid } : {}),
    };
  }

  logout(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM auth_sessions WHERE token = ?', [token]);
  }

  /** Drop expired rows; called at boot. */
  pruneSessions(): number {
    const res = this.db.run('DELETE FROM auth_sessions WHERE expires_at <= ?', [Date.now()]);
    return res.changes;
  }

  // --------------------------------------------------------------- setup ---

  /**
   * Create the very first app-local account (Windows desktop first-run flow).
   *
   * Only reachable while `AUTH_ALLOW_SETUP` is on and no local account exists;
   * once one account is written this permanently refuses, so the endpoint cannot
   * be reused to add accounts later. Linux/Docker keeps the seeded `admin` path
   * because the switch defaults to off.
   */
  async setup(username: string, password: string, userAgent?: string): Promise<LoginResult> {
    if (!this.enabled || !this.setupAllowed) {
      throw new ForbiddenException('当前服务端未开启首次创建账户（需要 AUTH_ALLOW_SETUP=1）');
    }
    if (this.localUserCount() > 0) {
      throw new ForbiddenException('该服务端已经创建过账户，请直接登录');
    }
    const name = username.trim();
    if (!/^[A-Za-z0-9._-]{2,32}$/.test(name)) {
      throw new BadRequestException('用户名需为 2–32 位字母、数字、点、下划线或连字符');
    }
    if (password.length < 8) {
      throw new BadRequestException('密码至少 8 位');
    }
    await this.setLocalPassword(name, password, name);
    this.logger.log(`已创建首个本地账户：${name}（首次创建账户流程）`);
    return this.createSession(name, 'local', userAgent);
  }

  // --------------------------------------------------------------- login ---

  async login(username: string, password: string, userAgent?: string): Promise<LoginResult> {
    if (this.needsSetup()) {
      throw new UnauthorizedException('该服务端还没有账户，请先在服务器本机打开网页创建账户');
    }

    const provider = this.effectiveProvider();

    if (provider === 'system') {
      const verdict = this.systemUsers.verify(username, password);
      if (verdict === true) {
        this.logger.log(`系统账户登录成功：${username}`);
        return this.createSession(username, 'system', userAgent);
      }
      if (verdict === null) {
        // The account exists but cannot be checked here. Fall through to a local
        // account of the same name before giving up.
        const local = this.findLocal(username);
        if (local && (await this.verifyScrypt(password, local.password_hash))) {
          this.logger.log(`本地账户登录成功：${username}`);
          return this.createSession(username, 'local', userAgent);
        }
        const reason = this.systemUsers.isUnsupportedHash(username)
          ? '该账户的密码使用 yescrypt 等本程序无法校验的算法，请在 .env 设置 AUTH_MODE=local 并使用本地账户'
          : '用户名或密码错误';
        throw new UnauthorizedException(reason);
      }
      // Wrong password: still allow a local account with the same name.
      const local = this.findLocal(username);
      if (local && (await this.verifyScrypt(password, local.password_hash))) {
        return this.createSession(username, 'local', userAgent);
      }
      throw new UnauthorizedException('用户名或密码错误');
    }

    const local = this.findLocal(username);
    if (!local) throw new UnauthorizedException('用户名或密码错误');
    if (!(await this.verifyScrypt(password, local.password_hash))) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    return this.createSession(username, 'local', userAgent);
  }

  /**
   * Change the password of an app-local account.
   *
   * System (NAS) accounts are refused with an explicit reason instead of a silent
   * no-op: their password lives in the host shadow file, so writing a local hash
   * for the same username would not change how they sign in.
   *
   * On success every *other* session of this user is revoked, so a password
   * change really does lock out anyone holding a stolen cookie — while the
   * caller's own session (`keepToken`) stays valid, so the tab that made the
   * change is not signed out.
   */
  async changePassword(
    user: SessionUser,
    current: string,
    next: string,
    keepToken?: string,
  ): Promise<PasswordChangeResult> {
    if (user.provider === 'system') {
      return {
        ok: false,
        code: 'not_local',
        error: '当前登录的是 NAS 系统账户，其密码请在 NAS 上修改',
      };
    }

    const local = this.findLocal(user.username);
    if (!local) {
      return { ok: false, code: 'not_local', error: '该账户不是本地账户，请在 NAS 上修改密码' };
    }
    if (!(await this.verifyScrypt(current, local.password_hash))) {
      return { ok: false, code: 'wrong_current', error: '当前密码不正确' };
    }
    if (!next || next.trim().length === 0) {
      return { ok: false, code: 'blank', error: '新密码不能为空' };
    }
    if (next.length < PASSWORD_MIN_LENGTH) {
      return { ok: false, code: 'too_short', error: `新密码至少 ${PASSWORD_MIN_LENGTH} 位` };
    }
    if (next.length > PASSWORD_MAX_LENGTH) {
      return { ok: false, code: 'too_long', error: `新密码不能超过 ${PASSWORD_MAX_LENGTH} 位` };
    }
    if (next === current) {
      return { ok: false, code: 'same', error: '新密码不能与原密码相同' };
    }

    await this.setLocalPassword(user.username, next);
    const dropped = this.revokeOtherSessions(user.username, keepToken);
    this.logger.log(
      `本地账户 ${user.username} 已修改密码${dropped > 0 ? `，并注销了 ${dropped} 个其它会话` : ''}`,
    );
    return { ok: true };
  }

  /**
   * Drop every session of `username` except `keepToken` (the one that asked for
   * the change). Returns how many sessions were removed.
   */
  revokeOtherSessions(username: string, keepToken?: string): number {
    const res = keepToken
      ? this.db.run('DELETE FROM auth_sessions WHERE username = ? AND token != ?', [username, keepToken])
      : this.db.run('DELETE FROM auth_sessions WHERE username = ?', [username]);
    return res.changes;
  }

  /** Everything the login page needs to render itself. */
  describe(): {
    enabled: boolean;
    mode: 'system' | 'local';
    provider: 'system' | 'local';
    systemAvailable: boolean;
    reason: string | null;
    allowSetup: boolean;
    needsSetup: boolean;
    users: Array<{ username: string; gecos: string; uid: number }>;
  } {
    const systemAvailable = this.systemUsers.available();
    return {
      enabled: this.enabled,
      mode: this.mode,
      provider: this.effectiveProvider(),
      systemAvailable,
      reason: this.mode === 'system' ? this.systemUsers.unavailableReason() : null,
      allowSetup: this.setupAllowed,
      needsSetup: this.needsSetup(),
      users: systemAvailable ? this.systemUsers.loginableUsers() : [],
    };
  }
}