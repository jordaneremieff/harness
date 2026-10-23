import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {createConnection} from 'node:net';
import test, {type TestContext} from 'node:test';
import {LocalHttp, type HttpBackend} from './http.mts';
import {Journal} from './journal.mts';
import type {PrivateRoute} from './settings.mts';
const config: PrivateRoute = Object.freeze({origin: 'https://desktop.example.ts.net', host: 'desktop.example.ts.net', ownerLogin: 'Owner@example.com', port: 4319});
const ownerHeaders = {Host: config.host, 'X-Forwarded-Host': config.host, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': config.ownerLogin};
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function fixture(context: TestContext, enabled = true) {
  const port = await availablePort();
  const counts = {dispatch: 0, workspace: 0, observe: 0, sheet: 0, health: 0, upload: 0};
  const backend: HttpBackend = {journal: new Journal(), dispatch: async () => {counts.dispatch++; return {};}, workspace: async () => {counts.workspace++; return 'fixture';}, observe: async () => {counts.observe++;}, detached: () => {}, uploadImage: async () => {counts.upload++; return {};}};
  const http = new LocalHttp(backend, new Map([['/', {type: 'text/html', data: Buffer.from('<html><head></head><body>private fixture</body></html>')}]]), undefined,
    {userStylesheet: async () => {counts.sheet++; return {state: 'none'};}, health: () => {counts.health++; return {startedAt: '2026-10-23T00:00:00Z', supervisorRestarts: 0, services: [], build: {state: 'static'}};}}, enabled ? {...config, port} : undefined);
  const origin = new URL(await http.listen(0)).origin, privateOrigin = `http://127.0.0.1:${port}`;
  context.after(() => http.close());
  return {privateOrigin, http, backend, counts, origin};
}
async function send(target: {origin: string}, path = '/', method = 'GET', headers: Record<string, string | undefined> = {}, body?: string): Promise<{status: number; text: string}> {
  return new Promise((accept, reject) => {
    const options = {path, method, agent: false as const, headers: {...headers, ...(body === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body))})}};
    const receive = (response: import('node:http').IncomingMessage) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => {text += chunk;}); response.on('error', reject);
      response.on('end', () => accept({status: response.statusCode ?? 0, text}));
    };
    const req = request(target.origin, options, receive);
    req.setTimeout(3000, () => req.destroy(new Error('Private HTTP fixture deadline.'))); req.on('error', reject); req.end(body);
  });
}
async function wire(origin: string, headers: string[], method = 'GET', route = '/'): Promise<number> {
  return new Promise((accept, reject) => {
    const socket = createConnection({host: '127.0.0.1', port: Number(new URL(origin).port)}); let bytes = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Private wire fixture deadline.')));
    socket.on('error', reject); socket.on('data', chunk => {bytes += chunk.toString();});
    socket.on('end', () => accept(Number(/^HTTP\/1\.1 (\d+)/.exec(bytes)?.[1])));
    socket.on('connect', () => socket.write(`${method} ${route} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`));
  });
}
const lines = () => Object.entries(ownerHeaders).map(([name, value]) => `${name}: ${value}`);
test('the private TCP listener accepts the exact owner while desktop TCP remains local, open and separate', async context => {
  const f = await fixture(context);
  assert.equal((await send({origin: f.privateOrigin}, '/', 'GET', ownerHeaders)).status, 200);
  assert.equal((await send({origin: f.origin})).status, 200);
  assert.ok(f.http.privateServer);
  assert.equal((f.http.privateServer.address() as {address: string}).address, '127.0.0.1');
  assert.notEqual(new URL(f.privateOrigin).port, new URL(f.origin).port);
  assert.equal((f.http.server.address() as {address: string}).address, '127.0.0.1');
  for (const enabled of [true, false]) {
    const app = enabled ? f : await fixture(context, false);
    for (const forged of [{'Tailscale-User-Login': config.ownerLogin}, {'Tailscale-Funnel-Request': '?1'}, {'Tailscale-App-Capabilities': '{}'},
      {'X-Forwarded-Host': '127.0.0.1'}, {'X-Forwarded-Proto': 'https'}, {'X-Forwarded-For': '100.64.0.1'}, {Forwarded: 'host=localhost'}, {Host: config.host}]) {
      assert.equal((await send({origin: app.origin}, '/', 'GET', forged)).status, 403);
    }
    if (!enabled) assert.equal(app.http.privateServer, undefined);
  }
});
test('private requests reject absent, non-owner, tagged and Funnel identity without local fallback', async context => {
  const f = await fixture(context);
  for (const patch of [{'Tailscale-User-Login': ''}, {'Tailscale-User-Login': 'other@example.com'}, {'Tailscale-User-Login': 'owner@example.com'},
    {'Tailscale-User-Login': 'tag:server'}, {'Tailscale-Funnel-Request': '?1'}, {'Tailscale-Funnel-Request': '?0'}, {'X-Funnel-Request': '1'},
    {'X-Forwarded-Host': new URL(f.origin).host}, {'X-Forwarded-Proto': 'http'}, {Host: 'localhost'}, {Host: `${config.host}:443`}, {Host: new URL(f.origin).host}, {Host: 'localhost:80'},
    {'X-Forwarded-Host': `${config.host}:443`}, {Forwarded: `host=${config.host}`}]) {
    assert.equal((await send({origin: f.privateOrigin}, '/', 'GET', {...ownerHeaders, ...patch})).status, 403, JSON.stringify(patch));
  }
  for (const missing of Object.keys(ownerHeaders)) {
    const headers: Record<string, string> = {...ownerHeaders}; delete headers[missing];
    // Prevent Node's client from silently supplying Host for the missing-host case.
    assert.equal(await wire(f.privateOrigin, Object.entries(headers).map(([name, value]) => `${name}: ${value}`)), missing === 'Host' ? 400 : 403);
  }
});
test('wire duplicates and malformed security values fail before Node normalisation hides them', async context => {
  const f = await fixture(context);
  for (const [name, value] of Object.entries({...ownerHeaders, Origin: config.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '100.64.0.1', 'Tailscale-User-Name': 'Fixture Owner'})) {
    const base = [...lines(), ...(!Object.hasOwn(ownerHeaders, name) ? [`${name}: ${value}`] : [])];
    assert.equal(await wire(f.privateOrigin, [...base, `${name.toLowerCase()}: ${value}`]), 403, name);
  }
  for (const patch of [{'X-Forwarded-Host': `${config.host},evil.test`}, {'Tailscale-User-Login': `${config.ownerLogin},other@example.com`}, {'Sec-Fetch-Site': ''}]) {
    assert.equal((await send({origin: f.privateOrigin}, '/', 'GET', {...ownerHeaders, ...patch})).status, 403);
  }
  assert.equal(await wire(f.privateOrigin, [...lines(), 'Tailscale-User-Name: Fixture\tOwner']), 403);
  const extra = Array.from({length: 64}, (_, index) => `X-Fixture-${index}: harmless`);
  for (const suffix of ['Origin: http://127.0.0.1', 'Sec-Fetch-Site: cross-site', `Tailscale-User-Login: ${config.ownerLogin}`]) {
    assert.equal(await wire(f.privateOrigin, [...lines(), ...extra, suffix]), 403);
  }
});
test('private browser admission uses the external origin for unsafe methods and read metadata', async context => {
  const f = await fixture(context);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const origin of [undefined, f.origin, `${config.origin}/`, 'null', 'https://other.example.ts.net']) {
      const headers = {...ownerHeaders, ...(origin === undefined ? {} : {Origin: origin})};
      assert.equal((await send({origin: f.privateOrigin}, '/api/operations', method, headers, '{}')).status, 403);
    }
  }
  assert.equal((await send({origin: f.privateOrigin}, '/api/operations', 'POST', {...ownerHeaders, Origin: config.origin}, '{}')).status, 200);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await send({origin: f.privateOrigin}, '/', method, {...ownerHeaders, Origin: f.origin})).status, 403);
    for (const site of ['same-origin', 'none']) assert.equal((await send({origin: f.privateOrigin}, '/', method, {...ownerHeaders, Origin: config.origin, 'Sec-Fetch-Site': site})).status, 200);
    for (const site of ['same-site', 'cross-site']) assert.equal((await send({origin: f.privateOrigin}, '/', method, {...ownerHeaders, 'Sec-Fetch-Site': site})).status, 403);
  }
});
test('unauthenticated requests cannot reach assets, stylesheet reads, health, body parsing, files, images, streams or dispatch', async context => {
  const f = await fixture(context), headers = lines().filter(line => !line.startsWith('Tailscale-User-Login:'));
  for (const route of ['/', '/style.css', '/user.css', '/api/health', '/api/bootstrap', '/api/events', '/api/dev/events', '/api/files/roots', '/api/control/layout']) {
    assert.equal(await wire(f.privateOrigin, headers, 'GET', route), 403, route);
  }
  for (const route of ['/api/operations', '/api/client-errors', '/api/workspaces/a/drafts/b/images', '/api/control/requests']) {
    assert.equal(await wire(f.privateOrigin, [...headers, `Origin: ${config.origin}`, 'Content-Type: application/json', 'Content-Length: 99999'], 'POST', route), 403, route);
  }
  assert.deepEqual(f.counts, {dispatch: 0, workspace: 0, observe: 0, sheet: 0, health: 0, upload: 0});
});
test('one admission fence stops both listeners, waits for private effects and then permits an explicit resume', async context => {
  const f = await fixture(context);
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>(accept => {entered = accept;}), held = new Promise<void>(accept => {release = accept;});
  f.backend.dispatch = async () => {entered(); await held; return {};};
  const pending = send({origin: f.privateOrigin}, '/api/bootstrap', 'GET', ownerHeaders); await active;
  const fence = f.http.fence();
  assert.equal((await send({origin: f.origin})).status, 503);
  assert.equal((await send({origin: f.privateOrigin}, '/', 'GET', ownerHeaders)).status, 503);
  release(); assert.equal((await pending).status, 200); await fence;
  f.http.resumeAdmission();
  assert.equal((await send({origin: f.origin})).status, 200);
  assert.equal((await send({origin: f.privateOrigin}, '/', 'GET', ownerHeaders)).status, 200);
});
test('close ends authenticated streams on both listeners and permits replacement on the same private port', async context => {
  const f = await fixture(context);
  const stream = (privateEntry: boolean) => new Promise<{ended: Promise<void>}>((accept, reject) => {
    const options = {path: '/api/events', agent: false as const, headers: privateEntry ? ownerHeaders : {}};
    const receive = (response: import('node:http').IncomingMessage) => {assert.equal(response.statusCode, 200); response.resume(); accept({ended: new Promise<void>(resolve => response.once('end', resolve))});};
    const req = request(privateEntry ? f.privateOrigin : f.origin, options, receive);
    req.on('error', reject); req.end();
  });
  const streams = await Promise.all([stream(false), stream(true)]);
  await f.http.close(); await Promise.all(streams.map(value => value.ended));
  assert.equal(f.http.server.listening, false); assert.equal(f.http.privateServer?.listening, false);
  await assert.rejects(send({origin: f.privateOrigin}, '/', 'GET', ownerHeaders), {code: 'ECONNREFUSED'});
  const replacement = new LocalHttp({...f.backend, journal: new Journal()}, new Map(), undefined, {}, {...config, port: Number(new URL(f.privateOrigin).port)});
  await replacement.listen(0); await replacement.close();
});

for (const side of ['desktop', 'private'] as const) {
  test(`a ${side} bind failure closes both listeners without admission`, async context => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
    const occupiedPort = (occupied.address() as {port: number}).port;
    const privatePort = side === 'private' ? occupiedPort : await availablePort();
    const app = new LocalHttp({journal: new Journal(), dispatch: async () => ({}), workspace: async () => 'fixture', observe: async () => {}, detached: () => {}}, new Map(), undefined, {}, {...config, port: privatePort});
    context.after(() => app.close());
    let desktopPort: number | undefined;
    app.server.once('listening', () => {desktopPort = (app.server.address() as {port: number}).port;});
    await assert.rejects(app.listen(side === 'desktop' ? occupiedPort : 0), {code: 'EADDRINUSE'});
    assert.equal(app.server.listening, false); assert.equal(app.privateServer?.listening, false);
    app.resumeAdmission();
    if (desktopPort) await assert.rejects(send({origin: `http://127.0.0.1:${desktopPort}`}), {code: 'ECONNREFUSED'});
    if (side === 'desktop') await assert.rejects(send({origin: `http://127.0.0.1:${privatePort}`}), {code: 'ECONNREFUSED'});
  });
}
for (const automatic of [false, true]) {
  test(`the actual desktop port never becomes the private port with automatic=${automatic}`, async context => {
    const port = await availablePort();
    const app = new LocalHttp({journal: new Journal(), dispatch: async () => ({}), workspace: async () => 'fixture', observe: async () => {}, detached: () => {}}, new Map(), undefined, {}, {...config, port});
    context.after(() => app.close());
    if (automatic) {
      const bind = app.server.listen;
      context.mock.method(app.server, 'listen', (...args: unknown[]) => {
        assert.equal(args[0], 0); args[0] = port;
        return Reflect.apply(bind, app.server, args);
      });
    }
    await assert.rejects(app.listen(automatic ? 0 : port), /must differ from the desktop port/);
    assert.equal(app.server.listening, false); assert.equal(app.privateServer?.listening, false);
    await assert.rejects(send({origin: `http://127.0.0.1:${port}`}), {code: 'ECONNREFUSED'});
  });
}
test('desktop admission stays closed until the private bind completes', async context => {
  const port = await availablePort();
  const app = new LocalHttp({journal: new Journal(), dispatch: async () => ({}), workspace: async () => 'fixture', observe: async () => {}, detached: () => {}}, new Map(), undefined, {}, {...config, port});
  context.after(() => app.close());
  const server = app.privateServer; assert.ok(server);
  const bind = server.listen;
  let entered!: () => void, argumentsForBind: unknown[] = [];
  const pendingBind = new Promise<void>(resolve => {entered = resolve;});
  context.mock.method(server, 'listen', (...args: unknown[]) => {
    argumentsForBind = args; entered(); return server;
  });
  const startup = app.listen(0); await pendingBind;
  const origin = `http://127.0.0.1:${(app.server.address() as {port: number}).port}`;
  try {assert.equal((await send({origin})).status, 503);}
  finally {Reflect.apply(bind, server, argumentsForBind); await startup;}
  assert.equal((await send({origin: `http://127.0.0.1:${port}`}, '/api/bootstrap', 'GET', ownerHeaders)).status, 200);
});
