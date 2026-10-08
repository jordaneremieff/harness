import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './errors.mts';

const COOKIE = 'pi_ui_session';
const token = () => randomBytes(32).toString('base64url');
function equal(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Memory-only credentials revoke on backend restart. No endpoint issues launch secrets. */
export class Auth {
  readonly capability = token();
  private consumed = false;
  private issuedAt: number;
  private sessions = new Set<string>();
  origin = '';
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now=now; this.issuedAt = now(); }
  setPort(port: number) { this.origin = `http://127.0.0.1:${port}`; }
  validate(request: IncomingMessage) {
    if (request.headers.host !== new URL(this.origin).host) throw new ApiError('origin_rejected', 'The request host is not this backend.', 403);
    const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
    if (unsafe && request.headers.origin !== this.origin) throw new ApiError('origin_rejected', 'The request origin is not this backend.', 403);
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new ApiError('origin_rejected', 'Cross-site requests are not allowed.', 403);
    if (request.headers.origin && request.headers.origin !== this.origin) throw new ApiError('origin_rejected', 'The request origin is not this backend.', 403);
  }
  launch(capability: string, response: ServerResponse) {
    if (this.consumed || this.now() - this.issuedAt >= 300_000 || !equal(capability, this.capability)) {
      throw new ApiError('unauthorized', 'Open the launch link from this Mac.', 401);
    }
    this.consumed = true;
    const session = token(); this.sessions.add(session);
    response.setHeader('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`);
    return session;
  }
  session(request: IncomingMessage) {
    const values = (request.headers.cookie ?? '').split(';').map(s => s.trim());
    const matches = values.filter(s => s.startsWith(`${COOKIE}=`));
    const value = matches.length === 1 ? matches[0]?.slice(COOKIE.length + 1) : undefined;
    if (!value || !this.sessions.has(value)) throw new ApiError('unauthorized', 'Open the launch link from this Mac.', 401);
    return value;
  }
  logout(session: string, response: ServerResponse) {
    this.sessions.delete(session);
    response.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }
  close() { this.sessions.clear(); }
}
export function securityHeaders(response: ServerResponse) {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}
