import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { Auth, securityHeaders } from './auth.mts';

const origin = 'http://127.0.0.1:43123';
function request(method = 'GET', headers: IncomingMessage['headers'] = {}) {
  return {method, headers: {host: '127.0.0.1:43123', ...headers}} as IncomingMessage;
}
function response() {
  const headers = new Map<string, string>();
  return {headers, http: {setHeader(name: string, value: string) { headers.set(name, value); }} as unknown as ServerResponse};
}
function auth(now?: () => number) { const value = new Auth(now); value.setPort(43123); return value; }
const rejected = (code: string, status: number) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & {code: string}).code, code);
  assert.equal((error as Error & {status: number}).status, status);
  return true;
};

test('only the exact host and port are trusted, never forwarded headers', () => {
  const value = auth();
  value.validate(request());
  for (const host of [undefined, 'localhost:43123', '127.0.0.1', '127.0.0.1:43124', '127.0.0.1:43123.', '[::1]:43123', '127.0.0.1:43123,evil.invalid']) {
    assert.throws(() => value.validate(request('GET', {host, 'x-forwarded-host': '127.0.0.1:43123', forwarded: 'host=127.0.0.1:43123'})), rejected('origin_rejected', 403));
  }
});

test('each mutation requires exact Origin and safe reads reject a supplied foreign Origin', () => {
  const value = auth();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    value.validate(request(method, {origin}));
    for (const wrong of [undefined, 'null', 'http://localhost:43123', `${origin}/`, 'https://127.0.0.1:43123', 'http://127.0.0.1:43124']) {
      assert.throws(() => value.validate(request(method, {origin: wrong})), rejected('origin_rejected', 403));
    }
  }
  for (const method of ['GET', 'HEAD']) {
    value.validate(request(method)); value.validate(request(method, {origin}));
    assert.throws(() => value.validate(request(method, {origin: 'http://evil.invalid'})), rejected('origin_rejected', 403));
  }
});

test('fetch metadata permits only same-origin, none, or absent', () => {
  const value = auth();
  for (const site of [undefined, 'same-origin', 'none']) value.validate(request('POST', {origin, 'sec-fetch-site': site}));
  for (const site of ['same-site', 'cross-site', 'Same-Origin']) {
    assert.throws(() => value.validate(request('GET', {'sec-fetch-site': site})), rejected('origin_rejected', 403));
  }
});

test('launch tokens are random 256-bit values, unrelated to the single-use cookie', () => {
  const value = auth(); const output = response();
  assert.equal(Buffer.from(value.capability, 'base64url').length, 32);
  assert.notEqual(value.capability, auth().capability);
  for (const wrong of ['', 'wrong', `${value.capability}x`, value.capability.slice(1)]) {
    assert.throws(() => value.launch(wrong, output.http), rejected('unauthorized', 401));
    assert.equal(output.headers.size, 0);
  }
  const session = value.launch(value.capability, output.http);
  assert.notEqual(session, value.capability);
  assert.equal(Buffer.from(session, 'base64url').length, 32);
  assert.equal(output.headers.get('Set-Cookie'), `pi_ui_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
  assert.throws(() => value.launch(value.capability, output.http), rejected('unauthorized', 401));
  assert.equal(value.session(request('GET', {cookie: `other=x; pi_ui_session=${session}; extra=y`})), session);
});

test('unused launch capability expires at exactly five minutes without a timer', () => {
  let now = 1000;
  const valid = auth(() => now); const expired = auth(() => now);
  now += 299999; valid.launch(valid.capability, response().http);
  now += 1;
  assert.throws(() => expired.launch(expired.capability, response().http), rejected('unauthorized', 401));
});

test('cookies require one exact issued value and reject duplicates or launch tokens', () => {
  const value = auth(); const session = value.launch(value.capability, response().http);
  for (const cookie of [undefined, '', 'pi_ui_session=', `pi_ui_session=${value.capability}`, `pi_ui_session=${session}x`, `pi_ui_session=${session}; pi_ui_session=${session}`, `pi_ui_session=${session}; pi_ui_session=wrong`, `pi_ui_session_extra=${session}`]) {
    assert.throws(() => value.session(request('GET', {cookie})), rejected('unauthorized', 401));
  }
});

test('logout, shutdown, and a backend restart revoke cookies', () => {
  const value = auth(); const output = response(); const session = value.launch(value.capability, output.http);
  const incoming = request('GET', {cookie: `pi_ui_session=${session}`});
  assert.throws(() => auth().session(incoming), rejected('unauthorized', 401));
  value.logout(session, output.http);
  assert.equal(output.headers.get('Set-Cookie'), 'pi_ui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  assert.throws(() => value.session(incoming), rejected('unauthorized', 401));
  const second = auth(); const token = second.launch(second.capability, response().http); second.close();
  assert.throws(() => second.session(request('GET', {cookie: `pi_ui_session=${token}`})), rejected('unauthorized', 401));
});

test('security headers prohibit inline/eval content, framing, caching, and referrer leakage', () => {
  const output = response(); securityHeaders(output.http);
  assert.equal(output.headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.equal(output.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(output.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(output.headers.get('Cache-Control'), 'no-store');
});
