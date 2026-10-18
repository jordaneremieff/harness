import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {LocalHttp, type Asset, type DevelopmentHttp, type HttpBackend} from './http.mts';
import {Journal} from './journal.mts';
import type {UserStylesheet} from './user-stylesheet.mts';
import type {HealthSnapshot} from '../shared/health.ts';

const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body></body></html>';
const assets = () => new Map<string, Asset>([['/', {type: 'text/html; charset=utf-8', data: Buffer.from(html)}], ['/style.css', {type: 'text/css; charset=utf-8', data: Buffer.from('a{}')}]]);
async function fixture(context: TestContext, userStylesheet?: () => Promise<UserStylesheet>) {
  const backend: HttpBackend = {journal: new Journal(), dispatch: async () => {throw new Error('Static routes must not dispatch.');}, workspace: async () => {throw new Error('unused');}, observe: async () => {}, detached: () => {}};
  const development: DevelopmentHttp = {...(userStylesheet ? {userStylesheet} : {}), health: () => ({startedAt: '2026-10-15T00:00:00.000Z', supervisorRestarts: 0, services: [], build: {state: 'static'}})};
  const http = new LocalHttp(backend, assets(), undefined, development), origin = new URL(await http.listen(0)).origin;
  context.after(() => http.close());
  return {origin, get: (path: string, method = 'GET') => fetch(`${origin}${path}`, {method, headers: {Origin: origin}})};
}
const applied = (css: string): UserStylesheet => ({state: 'applied', data: Buffer.from(css)});

test('an applied stylesheet is linked last in the head and served as uncached same-origin CSS', async context => {
  let css = ':root { --canvas: #000; }';
  const app = await fixture(context, async () => applied(css));
  const page = await (await app.get('/')).text();
  assert.match(page, /<link rel="stylesheet" href="\/style\.css"><link rel="stylesheet" href="\/user\.css" data-user-stylesheet><\/head>/);
  const sheet = await app.get('/user.css');
  assert.equal(sheet.status, 200); assert.equal(sheet.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(sheet.headers.get('cache-control'), 'no-cache'); assert.ok(sheet.headers.get('content-security-policy')?.includes("default-src 'none'"));
  assert.equal(await sheet.text(), css);
  css = ':root { --canvas: #fff; }';
  assert.equal(await (await app.get('/user.css')).text(), css, 'each request reads the file again');
  const head = await app.get('/user.css', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const post = await app.get('/user.css', 'POST'); assert.equal(post.status, 405); await post.text();
});
for (const state of ['none', 'missing', 'too-large', 'unreadable', 'invalid'] as const) {
  test(`a ${state} stylesheet adds no link and /user.css is not found`, async context => {
    const app = await fixture(context, async () => ({state}));
    const page = await (await app.get('/')).text();
    assert.equal(page, html); assert.doesNotMatch(page, /user\.css/);
    const sheet = await app.get('/user.css'); assert.equal(sheet.status, 404); await sheet.text();
  });
}
test('without a stylesheet source the page is unchanged and the route does not exist', async context => {
  const app = await fixture(context);
  assert.equal(await (await app.get('/')).text(), html);
  const sheet = await app.get('/user.css'); assert.equal(sheet.status, 404); await sheet.text();
});
test('health names only a fixed stylesheet state', async context => {
  for (const state of ['none', 'applied', 'missing', 'too-large', 'unreadable', 'invalid'] as const) {
    const app = await fixture(context, async () => state === 'applied' ? applied('a{}') : {state});
    const result = await (await app.get('/api/health')).json() as {data: HealthSnapshot};
    assert.deepEqual(result.data.userStylesheet, {state});
  }
  const none = await fixture(context); assert.deepEqual(((await (await none.get('/api/health')).json()) as {data: HealthSnapshot}).data.userStylesheet, {state: 'none'});
});
