import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ApiError } from './errors.mts';

const COOKIE = 'pi_ui_session';
export const AUTH_SESSION_LIMIT = 64;
const AUTH_BYTES = 8192;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function unsafeAuth(): ApiError { return new ApiError('not_ready', 'Private browser authentication state is unavailable.', 503); }
function privateEntry(info: Stats, directory = false): boolean {
  return (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}
/** Launch capabilities are transient; only bounded session hashes survive restart. */
export class Auth {
  readonly capability = token();
  private consumed = false;
  private issuedAt: number;
  private sessions = new Set<string>();
  private directory?: string;
  private failed = false;
  private closed = false;
  private pending: Promise<unknown> = Promise.resolve();
  origin = '';
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now=now; this.issuedAt = now(); }
  /** The caller holds the private state-root lock before opening this writer. */
  static async open(stateDir: string): Promise<Auth> {
    const auth = new Auth();
    if (!privateEntry(await lstat(stateDir), true)) throw unsafeAuth();
    auth.directory = stateDir;
    const sessions = await auth.read();
    if (sessions) auth.sessions = sessions;
    return auth;
  }
  private async read(): Promise<Set<string> | undefined> {
    const path = join(this.directory as string, 'auth.json');
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw unsafeAuth(); }
    try {
      const info = await file.stat();
      if (!privateEntry(info) || info.size > AUTH_BYTES) throw unsafeAuth();
      const buffer = Buffer.alloc(AUTH_BYTES + 1); let bytes = 0;
      while (bytes < buffer.length) {const next = await file.read(buffer, bytes, buffer.length - bytes, null); if (!next.bytesRead) break; bytes += next.bytesRead;}
      if (bytes > AUTH_BYTES) throw unsafeAuth();
      const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0, bytes)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsafeAuth();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 2 || record.format !== 'ui.auth/1' || !Array.isArray(record.sessions) || record.sessions.length > AUTH_SESSION_LIMIT || !record.sessions.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) || new Set(record.sessions).size !== record.sessions.length) throw unsafeAuth();
      return new Set(record.sessions as string[]);
    } catch { throw unsafeAuth(); }
    finally { await file.close(); }
  }
  private async publish(sessions: Set<string>): Promise<void> {
    if (!this.directory) return;
    const directory = this.directory, path = join(directory, 'auth.json'), temporary = join(directory, `.auth-${token()}.tmp`);
    try {
      if (!privateEntry(await lstat(directory), true)) throw unsafeAuth();
      await this.read();
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {await file.writeFile(JSON.stringify({format:'ui.auth/1',sessions:[...sessions]})); await file.sync();} finally {await file.close();}
      await rename(temporary, path);
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {await parent.sync();} finally {await parent.close();}
    } catch {this.failed = true; throw unsafeAuth();}
    finally {await unlink(temporary).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failed = true;});}
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.pending.catch(() => {}).then(() => {if (this.failed || this.closed) throw unsafeAuth(); return work();});
    this.pending = pending; return pending;
  }
  setPort(port: number) { this.origin = `http://127.0.0.1:${port}`; }
  validate(request: IncomingMessage) {
    if (request.headers.host !== new URL(this.origin).host) throw new ApiError('origin_rejected', 'The request host is not this backend.', 403);
    const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
    if (unsafe && request.headers.origin !== this.origin) throw new ApiError('origin_rejected', 'The request origin is not this backend.', 403);
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new ApiError('origin_rejected', 'Cross-site requests are not allowed.', 403);
    if (request.headers.origin && request.headers.origin !== this.origin) throw new ApiError('origin_rejected', 'The request origin is not this backend.', 403);
  }
  launch(capability: string, response: ServerResponse): Promise<string> {
    return this.serialize(async () => {
      if (this.consumed || this.now() - this.issuedAt >= 300_000 || !equal(capability, this.capability)) throw new ApiError('unauthorized', 'This launch link is no longer valid.', 401);
      if (this.sessions.size >= AUTH_SESSION_LIMIT) throw new ApiError('capacity', 'The browser session limit is reached. Sign out another browser before you use this launch link.', 429);
      const session = token(), sessions = new Set(this.sessions); sessions.add(hash(session));
      await this.publish(sessions); if (this.closed) throw unsafeAuth(); this.sessions = sessions; this.consumed = true;
      response.setHeader('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return session;
    });
  }
  session(request: IncomingMessage) {
    const values = (request.headers.cookie ?? '').split(';').map(s => s.trim());
    const matches = values.filter(s => s.startsWith(`${COOKIE}=`));
    const value = matches.length === 1 ? matches[0]?.slice(COOKIE.length + 1) : undefined;
    let matched = 0;
    if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) {const digest = hash(value); for (const session of this.sessions) matched |= Number(equal(digest, session));}
    if (this.failed || this.closed || !value || !matched) throw new ApiError('unauthorized', 'This browser is not authenticated.', 401);
    return value;
  }
  logout(session: string, response: ServerResponse): Promise<void> {
    return this.serialize(async () => {
      const sessions = new Set(this.sessions); sessions.delete(hash(session));
      await this.publish(sessions); if (this.closed) throw unsafeAuth(); this.sessions = sessions;
      response.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    });
  }
  async close(): Promise<void> { this.closed = true; await this.pending.catch(() => {}); this.sessions.clear(); }
}
export function securityHeaders(response: ServerResponse) {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}
