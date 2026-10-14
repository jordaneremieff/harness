import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LIMITS, ROUTES } from '../shared/api.ts';
import { Auth, securityHeaders } from './auth.mts';
import { ApiError, errorView } from './errors.mts';
import { IMAGE_BYTES, ImageResponse } from './images.mts';
import { isImageRoute } from './image-request.mts';
import type { Journal } from './journal.mts';
import {FileResponse, type Files} from './files.mts';
import {dispatchFiles, isFileRoute,fileWatchClientId} from './routes-files.mts';
import { SessionStore, validateSessionProject } from './sessions.mts';
import type { AssetGenerations } from './asset-generations.mts';
import type { DiagnosticSink } from './diagnostics.mts';
import type { UiIdentity } from '../shared/version.ts';
import { identityDocument } from './version.mts';
export type DevelopmentHttp = {generations?:AssetGenerations;diagnostics?:DiagnosticSink;identity?:UiIdentity;files?:Files};

export type RequestContext = {method: string; parts: string[]; url: URL; body: Record<string, unknown>;
  operationId?: string; workspace?: string; session: string; signal?: AbortSignal};
export type ImageUploadContext = Omit<RequestContext, 'body' | 'signal'> & {signal: AbortSignal; authorize(): void};
export type ImageUploadHeaders = {mimeType: 'image/png' | 'image/jpeg'; declaredBytes?: number};
export type HttpBackend = {journal: Journal; dispatch(context: RequestContext): Promise<unknown>;
  uploadImage?(context: ImageUploadContext, headers: ImageUploadHeaders, body: AsyncIterable<Uint8Array>): Promise<unknown>;
  workspace(id?: string): Promise<string>; observe(workspace: string): Promise<void>; detached(workspace: string): void;
  moveFiles?(rootId:string,from:string,to:string,work:()=>Promise<import('../shared/files.ts').FileMutation>):Promise<import('../shared/files.ts').FileMutation>;
  createFiles?(rootId:string,path:string,work:()=>Promise<import('../shared/files.ts').FileMutation>):Promise<import('../shared/files.ts').FileMutation>};
export type Asset = {type: string; data: Buffer};
export const ASSET_FILE_BYTES = 2 * 1024 * 1024;
export const ASSET_TOTAL_BYTES = 16 * 1024 * 1024;
export const ASSET_ENTRY_LIMIT = 256;
const MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'};
function missingAsset(path: string) {
  return new ApiError('not_ready', `Browser assets are missing: ${path}. Run npm run ui:build before starting.`, 503);
}
/** Known malformed-build filesystem codes become build guidance with the relative path; other failures propagate. */
function buildPathError(error: unknown, path: string): unknown {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') return missingAsset(path);
  if (code === 'ENOTDIR') return new ApiError('not_ready', `Browser asset path is not a directory where one is expected: ${path}. Run npm run ui:build before starting.`, 503);
  return error;
}
/** Reads at most limit + 1 bytes so growth after any metadata check still crosses the bound. */
async function readBounded(root: string, path: string, limit: number, buffer: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  try {
    // Nonblocking open lets a special file in the build fail startup instead of waiting for a writer.
    const file = await open(join(root, path), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new ApiError('not_ready', `Browser asset is not a regular file: ${path}. Run npm run ui:build before starting.`, 503);
      while (length <= limit) {
        const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, limit + 1 - length), null);
        if (!bytesRead) break;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); length += bytesRead;
      }
    } finally { await file.close(); }
  } catch (error) { throw buildPathError(error, path); }
  return Buffer.concat(chunks, length);
}
/** Startup retains bounded browser bytes. Requests never access the filesystem. */
export async function assetMap(root = fileURLToPath(new URL('../', import.meta.url))) {
  const assets = new Map<string, Asset>();
  const files: string[] = []; let entries = 0;
  try {
    const directory = await opendir(join(root, 'dist/web'), {bufferSize: 1});
    for await (const entry of directory) {
      if (++entries > ASSET_ENTRY_LIMIT) throw new ApiError('capacity', `Browser assets exceed ${ASSET_ENTRY_LIMIT} entries: dist/web. Remove extra build files and run npm run ui:build before starting.`, 503);
      if (/^[a-zA-Z0-9_-]+\.js$/.test(entry.name)) files.push(entry.name);
    }
  } catch (error) { throw buildPathError(error, 'dist/web'); }
  if (!files.includes('app.js')) throw missingAsset('dist/web/app.js');
  let retained = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const add = async (route: string, path: string, type: string) => {
    const limit = Math.min(ASSET_FILE_BYTES, ASSET_TOTAL_BYTES - retained);
    const data = await readBounded(root, path, limit, buffer); const length = data.length;
    if (length > ASSET_FILE_BYTES) throw new ApiError('capacity', `Browser asset exceeds the ${ASSET_FILE_BYTES}-byte per-file bound: ${path}. Reduce the asset and run npm run ui:build before starting.`, 503);
    if (length > limit) throw new ApiError('capacity', `Browser assets exceed the ${ASSET_TOTAL_BYTES}-byte total bound at ${path}. Reduce the build and run npm run ui:build before starting.`, 503);
    retained += length; assets.set(route, {type, data});
  };
  await add('/', 'web/index.html', MIME['.html']);
  await add('/style.css', 'web/style.css', MIME['.css']);
  await add('/favicon.svg', 'web/favicon.svg', MIME['.svg']);
  for (const name of files) await add(`/web/${name}`, `dist/web/${name}`, MIME['.js']);
  await add('/shared/api.js', 'dist/shared/api.js', MIME['.js']);
  await add('/shared/version.js', 'dist/shared/version.js', MIME['.js']);
  await add('/shared/files.js', 'dist/shared/files.js', MIME['.js']);
  return assets;
}
function matchRoute(method: string, parts: string[]) {
  let pathKnown = false;
  for (const route of [...ROUTES, 'GET /api/sessions', 'GET /api/projects', 'POST /api/agents/:identity/start']) {
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
async function readBody(request: IncomingMessage, limit: number = LIMITS.requestBytes) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > limit) { request.resume(); throw new ApiError('payload_too_large', 'The request body is too large.', 413); }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    request.resume(); throw new ApiError('invalid_request', 'Use a UTF-8 JSON request body.', 400);
  }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
    if (bytes > limit) { request.resume(); throw new ApiError('payload_too_large', 'The request body is too large.', 413); }
    chunks.push(buffer);
  }
  try {
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
    return value as Record<string, unknown>;
  } catch { throw new ApiError('invalid_request', 'The request body is not a JSON object.'); }
}
function fileMutationRoute(method:string,parts:string[]):boolean {return method === 'PUT' && parts.length === 5 && parts[1] === 'files' && parts[2] === 'roots' && (parts[4] === 'draft' || parts[4] === 'text');}
function requestBody(request:IncomingMessage,method:string,parts:string[]):Promise<Record<string,unknown>> {
  const fileMutation = fileMutationRoute(method,parts);
  return method === 'GET' || method === 'DELETE' ? Promise.resolve({}) : readBody(request,fileMutation ? LIMITS.fileResponseBytes : LIMITS.requestBytes);
}
function respond(response: ServerResponse, data: unknown, status = 200) {
  const json = JSON.stringify({ok: true, data});
  if (Buffer.byteLength(json) > LIMITS.displayBytes) throw new ApiError('payload_too_large', 'The response exceeds the display bound.', 413);
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); response.end(json);
}
function requireMethod(method:string,expected:string) {if(method!==expected) throw new ApiError('invalid_request','The route does not accept this method.',405);}
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
  private imageReads = 0;
  private buckets = new Map<string, {tokens: number; at: number}>();
  readonly backend: HttpBackend;
  private assets: Map<string, Asset>;
  private sessions: Pick<SessionStore, 'sessions' | 'projects' | 'titles'>;
  private development:DevelopmentHttp;
  private buildStreams=new Map<ServerResponse,string>();
  constructor(backend: HttpBackend, assets: Map<string, Asset>, sessions: Pick<SessionStore, 'sessions' | 'projects' | 'titles'> = new SessionStore(), development:DevelopmentHttp = {}) {
    this.backend = backend; this.assets = assets; this.sessions = sessions;this.development=development;
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
    for(const response of this.buildStreams.keys()) response.end();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private rate(key: string) {
    const now = performance.now(); const bucket = this.buckets.get(key) ?? {tokens: 240, at: now};
    bucket.tokens = Math.min(240, bucket.tokens + (now - bucket.at) * 0.12); bucket.at = now;
    if (bucket.tokens < 1) throw new ApiError('capacity', 'The request rate exceeds the local bound.', 429, 'read');
    bucket.tokens--; this.buckets.set(key, bucket);
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    securityHeaders(response);const started=performance.now();
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
    } finally {this.recordRequest(request,started);}
  }
  private recordRequest(request:IncomingMessage,started:number) {
    if(!this.development.diagnostics) return;
    try {this.auth.session(request);this.development.diagnostics.request(performance.now()-started);} catch { /* Pre-auth requests produce no diagnostics. */ }
  }
  private async route(request: IncomingMessage, response: ServerResponse) {
    const rawPath=(request.url??'/').split('?')[0]??'/';
    pathParts(rawPath);
    const url = new URL(request.url ?? '/', this.auth.origin);
    const method = request.method ?? 'GET'; const parts = pathParts(url.pathname);
    if(await this.developmentRoute(request,response,url,method)) return;
    const asset = this.assets.get(url.pathname);
    if (asset) return this.staticAsset(method, url.pathname === '/' ? this.versionDocument(asset) : asset, response);
    if (!isFileRoute(parts)) matchRoute(method, parts);
    if (this.savedImageRoute(method, parts, 'POST', 6)) return this.uploadImage(request, response, url, parts, this.auth.session(request));
    if (fileMutationRoute(method,parts)) this.auth.session(request);
    const body = await requestBody(request,method,parts);
    if (url.pathname === '/api/auth/launch') return this.launch(body, response);
    const session = this.auth.session(request);
    if (url.pathname === '/api/auth/logout') return this.logout(session, response);
    if (url.pathname === '/api/events') return this.events(request, response, url, session);
    if (await this.savedMetadata(url, response)) return;
    await this.validateResume(method, url, body);
    return this.dispatchRequest(request,response,url,method,parts,body,session);
  }
  private savedImageRoute(method: string, parts: string[], expectedMethod: string, length: number): boolean {
    return method === expectedMethod && parts.length === length && parts[1] === 'workspaces' && parts[3] === 'targets' && parts[5] === 'images';
  }
  private async dispatchRequest(request:IncomingMessage,response:ServerResponse,url:URL,method:string,parts:string[],body:Record<string,unknown>,session:string) {
    const context={method,parts,url,body,session,operationId:operationKey(request),workspace:url.searchParams.get('workspace')??undefined};
    if(isImageRoute(method,parts) || this.savedImageRoute(method, parts, 'GET', 7)) return this.image(context,response);
    const controller=new AbortController();
    const cancel=()=>{if(!response.writableEnded) controller.abort();};
    request.once('aborted',cancel);response.once('close',cancel);
    try {
      const captured = {...context,signal:controller.signal};
      const data = isFileRoute(parts) ? this.development.files ? await dispatchFiles(this.development.files,this.backend,captured) : (()=> {throw new ApiError('file_unavailable','File access is unavailable.',503,'read');})() : await this.backend.dispatch(captured);
      if (!controller.signal.aborted) {
        if (data instanceof FileResponse) {response.writeHead(data.status,{'Content-Type':'application/json; charset=utf-8'});response.end(data.json);}
        else respond(response,data,method==='POST'&&url.pathname==='/api/primaries'?202:200);
      }
    }
    finally {request.off('aborted',cancel);response.off('close',cancel);}
  }
  private imageUploads = 0;
  private async uploadImage(request: IncomingMessage, response: ServerResponse, url: URL, parts: string[], session: string): Promise<void> {
    if (!this.backend.uploadImage) throw new ApiError('unsupported', 'Image intake is unavailable.', 503);
    if (this.imageUploads >= LIMITS.imageUploads) throw new ApiError('capacity', 'Two image uploads are already active.', 429, 'read');
    const mimeType = request.headers['content-type'];
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') throw new ApiError('invalid_request', 'Image intake requires raw PNG or JPEG bytes.');
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > LIMITS.imageBytes)) throw new ApiError('payload_too_large', 'Image intake exceeds its byte bound.', 413);
    if (operationKey(request)) throw new ApiError('invalid_request', 'Image intake does not accept an operation key.');
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    const timer = setTimeout(() => controller.abort(), LIMITS.imageReceiveMs); timer.unref();
    request.once('aborted', cancel); response.once('close', cancel); this.imageUploads++;
    const authorize = () => {
      if (controller.signal.aborted) throw new ApiError('not_ready', 'Image intake ended or exceeded its receive deadline.', 408);
      if (this.stopped) throw new ApiError('not_ready', 'The backend no longer accepts requests.', 503);
      if (this.auth.session(request) !== session) throw new ApiError('unauthorized', 'The browser session changed.', 401);
    };
    const iterator = request.iterator({destroyOnReturn: false});
    let rejectAbort: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    void aborted.catch(() => {});
    const abort = () => rejectAbort(new ApiError('not_ready', 'Image receive deadline or connection ended.', 408));
    controller.signal.addEventListener('abort', abort, {once: true});
    const body = async function* (): AsyncGenerator<Uint8Array> {
      let bytes = 0;
      while (true) {
        authorize(); const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) return;
        if (!(next.value instanceof Uint8Array)) throw new ApiError('invalid_request', 'Image intake requires byte chunks.');
        bytes += next.value.byteLength;
        if (bytes > LIMITS.imageBytes) throw new ApiError('payload_too_large', 'Image intake exceeds its byte bound.', 413);
        yield next.value;
      }
    };
    try {
      const data = await this.backend.uploadImage({method: 'POST', parts, url, session, signal: controller.signal, authorize}, {mimeType, ...(length !== undefined ? {declaredBytes: Number(length)} : {})}, body());
      authorize(); respond(response, data);
    } catch (error) { if (!response.headersSent) response.setHeader('Connection', 'close'); throw error; }
    finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abort); request.off('aborted', cancel); response.off('close', cancel);
      void iterator.return?.().catch(() => {}); request.resume(); this.imageUploads--;
    }
  }
  private async developmentRoute(request:IncomingMessage,response:ServerResponse,url:URL,method:string):Promise<boolean> {
    const generations=this.development.generations;
    if(generations&&(url.pathname==='/'||url.pathname.startsWith('/_ui/'))) {this.generationAsset(generations,response,url,method);return true;}
    if(!url.pathname.startsWith('/api/dev/')||(!generations&&!this.development.diagnostics)) return false;
    const session=this.auth.session(request);
    if(url.pathname==='/api/dev/diagnostics'&&this.development.diagnostics) {
      requireMethod(method,'POST');const body=await readBody(request,16*1024);
      respond(response,this.development.diagnostics.ingest(session,body,Buffer.byteLength(JSON.stringify(body))));return true;
    }
    if(!generations) return false;
    if(url.pathname==='/api/dev/events') {requireMethod(method,'GET');this.developmentEvents(generations,response,url,session);return true;}
    if(url.pathname==='/api/dev/ack'||url.pathname==='/api/dev/release') {requireMethod(method,'POST');await this.developmentAck(generations,request,response,url,session);return true;}
    return false;
  }
  private generationAsset(generations:AssetGenerations,response:ServerResponse,url:URL,method:string) {
    if(method!=='GET'&&method!=='HEAD') throw new ApiError('invalid_request','The asset does not accept this method.',405);
    if(url.pathname==='/') return this.generationPage(generations,response,url,method);
    const match=/^\/_ui\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);
    const route=match?.[2];
    if(route==='/'||route==='/index.html') throw new ApiError('invalid_request','Browser documents require the leased root route.',404);
    const asset=match?generations.asset(match[1]??'',route??''):undefined;
    if(!asset) throw new ApiError('not_ready','The browser generation is unavailable.',409);this.staticAsset(method,asset,response);
  }
  private generationPage(generations:AssetGenerations,response:ServerResponse,url:URL,method:string) {
    const id=url.searchParams.get('generation')??generations.status().generation;
    if(method==='HEAD') {const asset=generations.documentHead(id);if(!asset) throw new ApiError('not_ready','The browser generation is unavailable.',409);this.staticAsset(method,this.versionDocument(asset,generations.identity(id)),response);return;}
    try {const page=generations.document(id);response.setHeader('X-UI-Generation',page.generation);this.staticAsset(method,this.versionDocument(page.asset,generations.identity(id)),response);}
    catch {throw new ApiError('capacity','The browser generation or page capacity is unavailable.',409);}
  }
  private versionDocument(asset: Asset, build?: {digest: string; builtAt?: string}): Asset {
    const identity = this.development.identity; if (!identity) return asset;
    return identityDocument(asset, identity.git && build ? {...identity, assets: build} : identity, ASSET_FILE_BYTES);
  }
  private developmentEvents(generations:AssetGenerations,response:ServerResponse,url:URL,session:string) {
    const client=url.searchParams.get('client')??'';
    try {generations.bind(client,session);} catch {throw new ApiError('invalid_request','The page lease is unavailable.',409);}
    let unsubscribe:(()=>unknown)|undefined;
    try {unsubscribe=generations.subscribe(client,session,status=> {
      if(response.destroyed) return;
      if(!response.headersSent) response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive'});
      if(response.writableLength>4096||!response.write(`event: build\ndata: ${JSON.stringify(status)}\n\n`)) response.end();
    });} catch {throw new ApiError('capacity','The page already has an update stream.',429);}
    this.buildStreams.set(response,session);response.once('close',()=>{unsubscribe?.();this.buildStreams.delete(response);});
  }
  private async developmentAck(generations:AssetGenerations,request:IncomingMessage,response:ServerResponse,url:URL,session:string) {
    const body=await readBody(request,1024);const allowed=url.pathname.endsWith('/ack')?['client','generation','cssGeneration']:['client'];
    if(Object.keys(body).length!==allowed.length||!allowed.every(key=>typeof body[key]==='string')) throw new ApiError('invalid_request','The generation acknowledgment is invalid.');
    try {if(url.pathname.endsWith('/ack')) generations.acknowledge(body.client as string,session,body.generation as string,body.cssGeneration as string);else generations.release(body.client as string,session);}
    catch {throw new ApiError('invalid_request','The page generation is unavailable.',409);}
    respond(response,generations.status());
  }
  private async image(context: RequestContext, response: ServerResponse): Promise<void> {
    if (this.imageReads >= 2) throw new ApiError('capacity', 'Two image reads are already active; retry this image.', 429, 'read');
    this.imageReads++;
    try {
      const result = await this.backend.dispatch(context);
      if (!(result instanceof ImageResponse) || !(result.image.data instanceof Uint8Array) || result.image.data.byteLength > IMAGE_BYTES || !['image/png','image/jpeg'].includes(result.image.mimeType)) throw new ApiError('invalid_request', 'The image response is invalid.', 422);
      if (response.destroyed) return;
      response.writeHead(200, {'Content-Type': result.image.mimeType, 'Content-Length': result.image.data.byteLength, 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin'});
      await new Promise<void>(resolve => { response.once('close',resolve); response.end(result.image.data,resolve); });
    } finally { this.imageReads--; }
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
    this.auth.logout(session, response); this.backend.journal.revoke(session);this.development.diagnostics?.revoke(session);
    for(const [stream,owner] of this.buildStreams) if(owner===session) stream.end();
    respond(response, {authenticated: false});
  }
  private staticAsset(method: string, asset: Asset, response: ServerResponse) {
    if (method !== 'GET' && method !== 'HEAD') throw new ApiError('invalid_request', 'The asset does not accept this method.', 405);
    response.writeHead(200, {'Content-Type': asset.type, 'Content-Length': asset.data.length}); response.end(method === 'HEAD' ? undefined : asset.data);
  }
  private async events(request: IncomingMessage, response: ServerResponse, url: URL, session: string) {
    const workspace = await this.backend.workspace(url.searchParams.get('workspace') ?? undefined);
    const rawClient = url.searchParams.get('clientId'),clientId = rawClient === null ? undefined : fileWatchClientId(rawClient);
    if (url.searchParams.getAll('clientId').length > 1) throw new ApiError('invalid_request','The page scope repeats.');
    if (this.backend.journal.workspaceClients(workspace) >= LIMITS.eventClients && !(clientId && this.backend.journal.hasClient(workspace,session,clientId))) throw new ApiError('capacity', 'Too many event streams use this workspace.', 429);
    const last = request.headers['last-event-id'];
    if (Array.isArray(last)) throw new ApiError('invalid_request', 'The replay cursor is invalid.');
    this.backend.journal.attach(response, workspace, session, last ?? url.searchParams.get('after') ?? undefined, () => {
      this.backend.detached(workspace);
      if (clientId) this.development.files?.releaseWatch(workspace,clientId);
    },clientId);
    if (this.backend.journal.workspaceClients(workspace)) void this.backend.observe(workspace).catch(() => {
      this.backend.journal.publish('notice', undefined, {level: 'warning', message: 'The selected agent observation is unavailable.'}, workspace);
    });
  }
}
