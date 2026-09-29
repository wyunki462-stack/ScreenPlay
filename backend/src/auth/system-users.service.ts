/**
 * Reads the NAS host's user database and verifies login attempts against it.
 *
 * The container is unprivileged and cannot call PAM, so docker-compose mounts
 * the host's `/etc/passwd`, `/etc/shadow` and `/etc/group` read-only. Password
 * verification happens here with {@link verifyUnixCrypt}; hashes are compared in
 * memory and never stored, logged, or returned by the API.
 *
 * When the files are absent (the mount was not added) the provider reports
 * itself unavailable and the caller falls back to app-local accounts, so the app
 * is never left with no way to sign in.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config/configuration';
import { parseCryptHash, verifyUnixCrypt } from './unix-crypt';

export interface SystemUser {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  /** Login is possible: has a password hash and a real shell. */
  loginable: boolean;
  /** Password hash field from shadow — never leaves the backend. */
  hash: string | null;
}

/** Accounts that exist on every Linux box and must never be login targets. */
const RESERVED = new Set([
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news',
  'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody',
  'systemd-network', 'systemd-resolve', 'systemd-timesync', 'messagebus',
  'syslog', 'uuidd', 'tcpdump', 'sshd', 'landscape', 'pollinate', 'ec2-instance-connect',
]);

@Injectable()
export class SystemUsersService {
  private readonly logger = new Logger(SystemUsersService.name);
  private cache: { users: Map<string, SystemUser>; at: number } | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private path(key: 'authPasswdPath' | 'authShadowPath' | 'authGroupPath'): string {
    return this.config.get(key, { infer: true });
  }

  private readOrNull(file: string): string | null {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /** True when the host user database is mounted and readable. */
  available(): boolean {
    return (
      this.readOrNull(this.path('authPasswdPath')) !== null &&
      this.readOrNull(this.path('authShadowPath')) !== null
    );
  }

  /** Why the system provider is unavailable, for the UI to display. */
  unavailableReason(): string | null {
    if (this.readOrNull(this.path('authPasswdPath')) === null) {
      return `未挂载宿主用户库（${this.path('authPasswdPath')} 不存在）`;
    }
    if (this.readOrNull(this.path('authShadowPath')) === null) {
      const why = `未挂载或无权读取密码库（${this.path('authShadowPath')}）`;
      return why;
    }
    return null;
  }

  /** Parsed system accounts. Cached for 30s — the user db rarely changes. */
  users(): Map<string, SystemUser> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 30_000) return this.cache.users;

    const users = new Map<string, SystemUser>();
    const passwd = this.readOrNull(this.path('authPasswdPath'));
    if (!passwd) {
      this.cache = { users, at: now };
      return users;
    }

    const shadow = new Map<string, string>();
    const shadowText = this.readOrNull(this.path('authShadowPath'));
    if (shadowText) {
      for (const line of shadowText.split('\n')) {
        const f = line.split(':');
        if (f.length >= 2 && f[0]) shadow.set(f[0], f[1]);
      }
    }

    for (const line of passwd.split('\n')) {
      const f = line.split(':');
      if (f.length < 7 || !f[0]) continue;
      const uid = Number.parseInt(f[2], 10);
      const gid = Number.parseInt(f[3], 10);
      if (!Number.isFinite(uid) || !Number.isFinite(gid)) continue;

      const hash = shadow.get(f[0]) ?? null;
      // System/daemon accounts (uid < 1000) are not meant for interactive
      // login, and locked entries start with '!' or '*' or are empty.
      const hasPassword = !!hash && !hash.startsWith('!') && !hash.startsWith('*') && hash.length > 0;
      const realShell = !!f[6] && !/nologin|false$/.test(f[6]);

      users.set(f[0], {
        username: f[0],
        uid,
        gid,
        gecos: f[4] ?? '',
        home: f[5] ?? '',
        shell: f[6] ?? '',
        loginable: hasPassword && realShell && uid >= 1000 && !RESERVED.has(f[0]),
        hash,
      });
    }

    this.cache = { users, at: now };
    return users;
  }

  /** System accounts that can actually be signed in as (for the login page). */
  loginableUsers(): Array<Pick<SystemUser, 'username' | 'gecos' | 'uid'>> {
    const allowed = this.config.get('authAllowedUsers', { infer: true });
    return [...this.users().values()]
      .filter((u) => u.loginable && (allowed.length === 0 || allowed.includes(u.username)))
      .map(({ username, gecos, uid }) => ({ username, gecos, uid }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  /**
   * Verify a password against the host account.
   *
   * Returns `true`/`false`, or `null` when the password cannot be checked here
   * (account not found, no usable hash, or an unsupported hash scheme such as
   * yescrypt) so the caller can report a precise reason.
   */
  verify(username: string, password: string): boolean | null {
    const user = this.users().get(username);
    if (!user || !user.loginable || !user.hash) return null;
    if (!parseCryptHash(user.hash)) return null;
    return verifyUnixCrypt(password, user.hash);
  }

  /** True when the stored hash uses a scheme we cannot verify in pure JS. */
  isUnsupportedHash(username: string): boolean {
    const user = this.users().get(username);
    if (!user?.hash) return false;
    const scheme = parseCryptHash(user.hash)?.scheme;
    return scheme === '$y$' || (!scheme && user.hash.startsWith('$'));
  }

  logUnavailable(): void {
    const reason = this.unavailableReason();
    if (reason) this.logger.warn(`系统账户登录不可用：${reason}`);
  }
}