import type {IncomingMessage, ServerResponse} from 'node:http';
import {ApiError} from './errors.mts';
import type {PrivateRoute} from './settings.mts';
export type Entrypoint = 'local' | 'private';
const proxyHeader = (name: string) => /^(?:tailscale(?:-|$)|forwarded$|x-forwarded(?:-|$))/.test(name);
const securityHeader = (name: string) => proxyHeader(name) || name.includes('funnel') || ['host', 'origin', 'sec-fetch-site'].includes(name);
function rejected(): never {throw new ApiError('origin_rejected', 'The request does not satisfy this backend entrypoint.', 403);}
/** Inspect wire occurrences before Node joins or discards duplicate header values. */
function securityValues(request: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>();
  const raw = request.rawHeaders ?? [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]?.toLowerCase() ?? '', value = raw[index + 1];
    if (!securityHeader(name)) continue;
    if (values.has(name) || typeof value !== 'string' || !value.length || value.length > 2048 || /[^\x20-\x7e]/.test(value) || value.trim() !== value) rejected();
    values.set(name, value);
  }
  return values;
}
function validateBrowser(request: IncomingMessage, values: ReadonlyMap<string, string>, origin: string): void {
  const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
  const requestOrigin = values.get('origin') ?? request.headers.origin;
  if (unsafe && requestOrigin !== origin) rejected();
  const site = values.get('sec-fetch-site') ?? request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') rejected();
  if (requestOrigin !== undefined && requestOrigin !== origin) rejected();
}
/** Entrypoint checks apply before every asset, API route and body read. */
export class LocalBoundary {
  origin = '';
  private readonly privateRoute?: PrivateRoute;
  constructor(privateRoute?: PrivateRoute) {this.privateRoute = privateRoute;}
  setPort(port:number) {this.origin = `http://127.0.0.1:${port}`;}
  validate(request: IncomingMessage, entrypoint: Entrypoint = 'local'): string {
    const values = securityValues(request);
    const origin = entrypoint === 'private' ? this.privateOrigin(values) : this.localOrigin(request, values);
    validateBrowser(request, values, origin);
    return origin;
  }
  private privateOrigin(values: ReadonlyMap<string, string>): string {
    const config = this.privateRoute;
    if (!config || values.get('host') !== config.host || values.get('x-forwarded-host') !== config.host
      || values.get('x-forwarded-proto') !== 'https' || values.get('tailscale-user-login') !== config.ownerLogin) rejected();
    if ([...values.keys()].some(name => name.includes('funnel') || name === 'forwarded')) rejected();
    return config.origin;
  }
  private localOrigin(request: IncomingMessage, values: ReadonlyMap<string, string>): string {
    if (Object.keys(request.headers).some(proxyHeader) || [...values.keys()].some(proxyHeader)) rejected();
    if (request.headers.host !== new URL(this.origin).host) rejected();
    return this.origin;
  }
}
export function securityHeaders(response: ServerResponse) {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}
