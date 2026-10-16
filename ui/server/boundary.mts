import type {IncomingMessage, ServerResponse} from 'node:http';
import {ApiError} from './errors.mts';

/** Loopback request checks apply to every asset and API route. */
export class LocalBoundary {
  origin = '';
  setPort(port:number) {this.origin = `http://127.0.0.1:${port}`;}
  validate(request: IncomingMessage) {
    if (request.headers.host !== new URL(this.origin).host) throw new ApiError('origin_rejected', 'The request host is not this backend.', 403);
    const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
    if (unsafe && request.headers.origin !== this.origin) throw new ApiError('origin_rejected', 'The request origin is not this backend.', 403);
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new ApiError('origin_rejected', 'Cross-site requests are not allowed.', 403);
    if (request.headers.origin && request.headers.origin !== this.origin) throw new ApiError('origin_rejected', 'The request origin is not this backend.', 403);
  }
}
export function securityHeaders(response: ServerResponse) {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}
