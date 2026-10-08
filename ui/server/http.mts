import { readFile, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LIMITS, ROUTES } from '../shared/api.ts';
import { Auth, securityHeaders } from './auth.mts';
import { ApiError, errorView } from './errors.mts';
import type { Journal } from './journal.mts';
import { SessionStore, validateSessionProject } from './sessions.mts';

export type RequestContext = {method: string; parts: string[]; url: URL; body: Record<string, unknown>;
  operationId?: string; workspace?: string; session: string};
export type HttpBackend = {journal: Journal; dispatch(context: RequestContext): Promise<unknown>;
  workspace(id?: string): Promise<string>; observe(workspace: string): Promise<void>; detached(workspace: string): void};
export type Asset = {path: string; type: string};
const MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};
/** Build outputs are inventoried once. Requests never resolve filesystem paths. */
export async function assetMap(root = fileURLToPath(new URL('../', import.meta.url))) {
  const assets = new Map<string, Asset>([['/', {path: join(root, 'web/index.html'), type: MIME['.html']}],
    ['/style.css', {path: join(root, 'web/style.css'), type: MIME['.css']}]]);
  let files: string[] = [];
  try { files = await readdir(join(root, 'dist/web')); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (files.length > 256) throw new ApiError('capacity', 'The browser build contains too many assets.', 503);
  for (const name of files) if (/^[a-zA-Z0-9_-]+\.js$/.test(name)) assets.set(`/web/${name}`, {path: join(root, 'dist/web', name), type: MIME['.js']});
  assets.set('/shared/api.js', {path: join(root, 'dist/shared/api.js'), type: MIME['.js']});
  return assets;
}
function matchRoute(method: string, parts: string[]) {
  let pathKnown = false;
  for (const route of [...ROUTES, 'GET /api/sessions', 'GET /api/projects']) {
    const [verb, path] = route.split(' '); const expected = path?.split('/').filter(Boolean) ?? [];
    if (expected.length !== parts.length || !expected.every((part, index) => part.startsWith(':') || part === parts[index])) continue;
    pathKnown = true; if (method === verb) return;
  }
  throw new ApiError('invalid_request', pathKnown ? 'The route does not accept this method.' : 'The route does not exist.', pathKnown ? 405 : 404);
}
function pathParts(pathname: string) {
  if (pathname.includes('\\') || pathname.includes('//') || (pathname !== '/' && pathname.endsWith('/')) || /%2f|%5c/i.test(pathname)) throw new ApiError('invalid_request', 'The route path is invalid.', 404);
  try {
    return pathname.split('/').filter(Boolean).map(part => {
      const value = decodeURIComponent(part);
      if (value === '.' || value === '..' || value.length > LIMITS.pathChars || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid');
      return value;
    });
  } catch { throw new ApiError('invalid_request', 'The route path is invalid.', 404); }
}
async function readBody(request: IncomingMessage) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > LIMITS.requestBytes) { request.resume(); throw new ApiError('payload_too_large', 'The request body is too large.', 413); }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    request.resume(); throw new ApiError('invalid_request', 'Use a UTF-8 JSON request body.', 400);
  }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
    if (bytes > LIMITS.requestBytes) { request.resume(); throw new ApiError('payload_too_large', 'The request body is too large.', 413); }
    chunks.push(buffer);
  }
  try {
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
    return value as Record<string, unknown>;
  } catch { throw new ApiError('invalid_request', 'The request body is not a JSON object.'); }
}
function respond(response: ServerResponse, data: unknown, status = 200) {
  const json = JSON.stringify({ok: true, data});
  if (Buffer.byteLength(json) > LIMITS.displayBytes) throw new ApiError('payload_too_large', 'The response exceeds the display bound.', 413);
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); response.end(json);
}
function operationKey(request: IncomingMessage) {
  const header = request.headers['idempotency-key'];
  if (Array.isArray(header) || (header && header.length > LIMITS.idChars)) throw new ApiError('invalid_request', 'The operation key is invalid.');
  return header;
}
/** Bounded request admission uses elapsed-time token accounting, never a refill timer. */
export class LocalHttp {
  readonly server: Server;
  readonly auth = new Auth();
  private stopped = false;
  private active = 0;
  private buckets = new Map<string, {tokens: number; at: number}>();
  readonly backend: HttpBackend;
  private assets: Map<string, Asset>;
  private sessions: Pick<SessionStore, 'sessions' | 'projects' | 'titles'>;
  constructor(backend: HttpBackend, assets: Map<string, Asset>, sessions: Pick<SessionStore, 'sessions' | 'projects' | 'titles'> = new SessionStore()) {
    this.backend = backend; this.assets = assets; this.sessions = sessions;
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.maxHeadersCount = 64;
  }
  async listen(port = 4318) {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', () => {this.server.off('error', reject); resolve();}); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    this.auth.setPort(address.port); return `${this.auth.origin}/#launch=${this.auth.capability}`;
  }
  stopAdmission() { this.stopped = true; }
  async close() {
    this.stopAdmission(); this.backend.journal.close(); this.auth.close();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private rate(key: string) {
    const now = performance.now(); const bucket = this.buckets.get(key) ?? {tokens: 240, at: now};
    bucket.tokens = Math.min(240, bucket.tokens + (now - bucket.at) * 0.12); bucket.at = now;
    if (bucket.tokens < 1) throw new ApiError('capacity', 'The request rate exceeds the local bound.', 429, 'read');
    bucket.tokens--; this.buckets.set(key, bucket);
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    securityHeaders(response);
    try {
      if (this.stopped) throw new ApiError('not_ready', 'The backend no longer accepts requests.', 503);
      this.auth.validate(request); this.rate('loopback');
      if (this.active >= 64) throw new ApiError('capacity', 'Too many requests are active.', 429, 'read');
      this.active++;
      try { await this.route(request, response); } finally { this.active--; }
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof ApiError ? error.status : error && typeof error==='object' && 'status' in error && typeof error.status==='number' ? error.status : 500;
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify({ok: false, error: errorView(error)}));
    }
  }
  private async route(request: IncomingMessage, response: ServerResponse) {
    const rawPath=(request.url??'/').split('?')[0]??'/';
    pathParts(rawPath);
    const url = new URL(request.url ?? '/', this.auth.origin);
    const method = request.method ?? 'GET'; const parts = pathParts(url.pathname);
    const asset = this.assets.get(url.pathname);
    if (asset) return this.staticAsset(method, asset, response);
    matchRoute(method, parts);
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(request);
    if (url.pathname === '/api/auth/launch') return this.launch(body, response);
    const session = this.auth.session(request);
    if (url.pathname === '/api/auth/logout') return this.logout(session, response);
    if (url.pathname === '/api/events') return this.events(request, response, url, session);
    if (await this.savedMetadata(url, response)) return;
    await this.validateResume(method, url, body);
    const header = operationKey(request);
    const data = await this.backend.dispatch({method, parts, url, body, session, operationId: header, workspace: url.searchParams.get('workspace') ?? undefined});
    respond(response, data, method === 'POST' && url.pathname === '/api/primaries' ? 202 : 200);
  }
  private async savedMetadata(url: URL, response: ServerResponse): Promise<boolean> {
    if (url.pathname === '/api/projects') { respond(response, await this.sessions.projects(url.searchParams.get('cursor'))); return true; }
    if (url.pathname === '/api/sessions') {
      const project = url.searchParams.get('project') ?? ''; const titles = url.searchParams.get('titles');
      respond(response, titles ? await this.sessions.titles(project, titles) : await this.sessions.sessions(project, url.searchParams.get('cursor'))); return true;
    }
    return false;
  }
  private async validateResume(method: string, url: URL, body: Record<string, unknown>) {
    if (method !== 'POST' || url.pathname !== '/api/primaries') return;
    if (typeof body.sessionFile === 'string' && typeof body.cwd === 'string') await validateSessionProject(body.cwd, body.sessionFile);
  }
  private launch(body: Record<string, unknown>, response: ServerResponse) {
    if (typeof body.capability !== 'string' || body.capability.length > 256 || Object.keys(body).length !== 1) throw new ApiError('invalid_request', 'The launch request is invalid.');
    this.auth.launch(body.capability, response); respond(response, {authenticated: true});
  }
  private logout(session: string, response: ServerResponse) {
    this.auth.logout(session, response); this.backend.journal.revoke(session); respond(response, {authenticated: false});
  }
  private async staticAsset(method: string, asset: Asset, response: ServerResponse) {
    if (method !== 'GET' && method !== 'HEAD') throw new ApiError('invalid_request', 'The asset does not accept this method.', 405);
    let data: Buffer;
    try { data = await readFile(asset.path); } catch { throw new ApiError('not_ready', 'Build the browser assets before use.', 503); }
    if (data.length > 2 * 1024 * 1024) throw new ApiError('payload_too_large', 'The asset exceeds the size bound.', 413);
    response.writeHead(200, {'Content-Type': asset.type, 'Content-Length': data.length}); response.end(method === 'HEAD' ? undefined : data);
  }
  private async events(request: IncomingMessage, response: ServerResponse, url: URL, session: string) {
    const workspace = await this.backend.workspace(url.searchParams.get('workspace') ?? undefined);
    if (this.backend.journal.workspaceClients(workspace) >= 8) throw new ApiError('capacity', 'Too many event streams use this workspace.', 429);
    const last = request.headers['last-event-id'];
    if (Array.isArray(last)) throw new ApiError('invalid_request', 'The replay cursor is invalid.');
    this.backend.journal.attach(response, workspace, session, last ?? url.searchParams.get('after') ?? undefined, () => this.backend.detached(workspace));
    if (this.backend.journal.workspaceClients(workspace)) void this.backend.observe(workspace).catch(() => {
      this.backend.journal.publish('notice', undefined, {level: 'warning', message: 'The selected agent observation is unavailable.'}, workspace);
    });
  }
}
