import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readPrivateRoute, readSettings, settings } from './settings.mts';

async function agentDir(context: TestContext, document?: unknown, raw?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ui-settings-test-'));
  context.after(() => rm(dir, {recursive: true, force: true}));
  if (raw !== undefined) await writeFile(join(dir, 'harness.json'), raw);
  else if (document !== undefined) await writeFile(join(dir, 'harness.json'), JSON.stringify(document));
  return dir;
}

test('the declaration names the ui section, the path type and the environment override', () => {
  assert.equal(settings.slice, 'ui');
  assert.equal(settings.fields.userStylesheet.type, 'path');
  assert.equal(settings.fields.userStylesheet.env, 'PI_UI_USER_STYLESHEET');
});
test('a missing document leaves the stylesheet unset without a diagnostic', async context => {
  const snapshot = readSettings({agentDir: await agentDir(context), env: {}});
  assert.deepEqual(snapshot, {privateRoute: undefined, privateStatus: 'disabled', userStylesheet: undefined, origin: 'default', status: 'unset', diagnostics: []});
});
test('a relative document path resolves against the agent directory and an absolute path is kept', async context => {
  const dir = await agentDir(context, {version: 1, ui: {userStylesheet: 'ui/mine.css'}});
  assert.equal(readSettings({agentDir: dir, env: {}}).userStylesheet, join(dir, 'ui/mine.css'));
  const absolute = await agentDir(context, {version: 1, ui: {userStylesheet: '/elsewhere/mine.css'}});
  assert.equal(readSettings({agentDir: absolute, env: {}}).userStylesheet, '/elsewhere/mine.css');
});
test('a present environment value wins over the document, including an empty value that is invalid', async context => {
  const dir = await agentDir(context, {version: 1, ui: {userStylesheet: 'file.css'}});
  const chosen = readSettings({agentDir: dir, env: {PI_UI_USER_STYLESHEET: 'env.css'}});
  assert.equal(chosen.userStylesheet, join(dir, 'env.css')); assert.equal(chosen.origin, 'env');
  const empty = readSettings({agentDir: dir, env: {PI_UI_USER_STYLESHEET: ''}});
  assert.equal(empty.userStylesheet, undefined); assert.equal(empty.status, 'invalid');
  assert.deepEqual(empty.diagnostics, [{field: 'ui.userStylesheet', source: 'env', code: 'invalid'}]);
});
test('invalid document values, unknown keys and a malformed document produce fixed diagnostics only', async context => {
  const invalid = readSettings({agentDir: await agentDir(context, {version: 1, ui: {userStylesheet: 5, other: true}}), env: {}});
  assert.equal(invalid.status, 'invalid');
  assert.deepEqual(invalid.diagnostics.map(item => `${item.field}:${item.code}`).sort(), ['ui.other:unknown', 'ui.userStylesheet:invalid']);
  for (const document of [{ui: {userStylesheet: 'x.css'}}, {version: 2}]) {
    const snapshot = readSettings({agentDir: await agentDir(context, document), env: {}});
    assert.equal(snapshot.status, 'unset'); assert.deepEqual(snapshot.diagnostics, [{field: 'document', source: 'file', code: 'document'}]);
  }
  const broken = readSettings({agentDir: await agentDir(context, undefined, '{not json'), env: {}});
  assert.deepEqual(broken.diagnostics, [{field: 'document', source: 'file', code: 'document'}]);
  const section = readSettings({agentDir: await agentDir(context, {version: 1, ui: []}), env: {}});
  assert.deepEqual(section.diagnostics, [{field: 'ui', source: 'file', code: 'invalid'}]);
});
test('the environment still selects a stylesheet when the document is unreadable, and PI_HARNESS_FILE selects another document', async context => {
  const dir = await agentDir(context, undefined, '{not json');
  assert.equal(readSettings({agentDir: dir, env: {PI_UI_USER_STYLESHEET: '/a.css'}}).userStylesheet, '/a.css');
  await writeFile(join(dir, 'other.json'), JSON.stringify({version: 1, ui: {userStylesheet: 'b.css'}}));
  assert.equal(readSettings({agentDir: dir, env: {PI_HARNESS_FILE: 'other.json'}}).userStylesheet, join(dir, 'b.css'));
});
const privateOrigin = 'https://desktop.example.ts.net', privateOwnerLogin = 'Owner@example.com';
test('private access is disabled by absence and complete configuration is immutable and independent of stylesheet validity', async context => {
  const dir = await agentDir(context);
  assert.equal(readPrivateRoute({agentDir: dir, env: {}}), undefined);
  await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin, privateOwnerLogin, userStylesheet: 5}}));
  const snapshot = readSettings({agentDir: dir, env: {}});
  assert.equal(snapshot.status, 'invalid'); assert.equal(snapshot.privateStatus, 'valid');
  assert.deepEqual(snapshot.privateRoute, {origin: privateOrigin, host: 'desktop.example.ts.net', ownerLogin: privateOwnerLogin, port: 4319});
  assert.ok(Object.isFrozen(snapshot.privateRoute));
  await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin, userStylesheet: 'valid.css'}}));
  const partial = readSettings({agentDir: dir, env: {}});
  assert.equal(partial.status, 'valid'); assert.equal(partial.privateStatus, 'invalid');
  assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/);
});
test('private environment overrides select each field without fallback for an invalid present value', async context => {
  const dir = await agentDir(context, {version: 1, ui: {privateOrigin, privateOwnerLogin}});
  const env = {PI_UI_PRIVATE_ORIGIN: 'https://other.example.ts.net', PI_UI_PRIVATE_OWNER_LOGIN: 'other@example.com', PI_UI_PRIVATE_PORT: '4320'};
  assert.deepEqual(readPrivateRoute({agentDir: dir, env}), {origin: env.PI_UI_PRIVATE_ORIGIN, host: 'other.example.ts.net', ownerLogin: env.PI_UI_PRIVATE_OWNER_LOGIN, port: 4320});
  for (const invalid of [{PI_UI_PRIVATE_ORIGIN: ''}, {PI_UI_PRIVATE_OWNER_LOGIN: ''}, {PI_UI_PRIVATE_PORT: ''}]) assert.throws(() => readPrivateRoute({agentDir: dir, env: invalid}), /invalid or incomplete/);
});
test('private origins reject every alternate authority and non-origin shape; logins remain bounded exact ASCII', async context => {
  const dir = await agentDir(context);
  const origins = ['', 'http://desktop.example.ts.net', 'https://desktop.example.ts.net:443', 'https://desktop.example.ts.net:444',
    'https://desktop.example.ts.net/', 'https://desktop.example.ts.net/a', 'https://desktop.example.ts.net?x', 'https://desktop.example.ts.net#x',
    'https://user@desktop.example.ts.net', 'https://*.example.ts.net', 'https://desktop.example.ts.net.evil.test',
    'https://127.0.0.1', 'https://desktop.EXAMPLE.ts.net', 'https://-desktop.example.ts.net', 'https://desktop.example.ts.net.',
    `https://${'a'.repeat(64)}.example.ts.net`, `https://${'a.'.repeat(130)}ts.net`, null, 7];
  for (const origin of origins) {
    await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin: origin, privateOwnerLogin}}));
    assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/, String(origin));
  }
  for (const login of ['', ' owner@example.com', 'owner@example.com ', 'owner\n@example.com', 'ownér@example.com', 'owner,other', 'a'.repeat(255), null, 8]) {
    await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin, privateOwnerLogin: login}}));
    assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/);
  }
  for (const partial of [{privateOrigin}, {privateOwnerLogin}, {privatePort: 4319}, {privateOrigin, privatePort: 4319}, {privateOwnerLogin, privatePort: 4319}]) {
    await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: partial}));
    assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/);
  }
});
test('an unreadable or malformed private configuration document fails closed, not as disabled', async context => {
  const dir = await agentDir(context, undefined, '{bad');
  assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/);
  for (const document of [{version: 2}, {version: 1, ui: []}]) {
    await writeFile(join(dir, 'harness.json'), JSON.stringify(document));
    assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/);
  }
});

test('private ports accept only bounded integer document values or decimal environment values', async context => {
  const dir = await agentDir(context);
  for (const privatePort of [1, 4319, 65535]) {
    await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin, privateOwnerLogin, privatePort}}));
    assert.equal(readPrivateRoute({agentDir: dir, env: {}})?.port, privatePort);
  }
  for (const privatePort of [0, -1, 65536, 1.5, null, true, '4319', '', {}, []]) {
    await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin, privateOwnerLogin, privatePort}}));
    assert.throws(() => readPrivateRoute({agentDir: dir, env: {}}), /invalid or incomplete/, JSON.stringify(privatePort));
  }
  await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1, ui: {privateOrigin, privateOwnerLogin, privatePort: 4320}}));
  for (const value of ['1', '4319', '65535']) assert.equal(readPrivateRoute({agentDir: dir, env: {PI_UI_PRIVATE_PORT: value}})?.port, Number(value));
  for (const value of ['', '0', '-1', '65536', '1.5', '4319 ', ' 4319', '0x10', '1e3', 'NaN', 'Infinity']) {
    assert.throws(() => readPrivateRoute({agentDir: dir, env: {PI_UI_PRIVATE_PORT: value}}), /invalid or incomplete/, value);
  }
  await writeFile(join(dir, 'harness.json'), JSON.stringify({version: 1}));
  assert.throws(() => readPrivateRoute({agentDir: dir, env: {PI_UI_PRIVATE_PORT: '4319'}}), /invalid or incomplete/);
  assert.equal(settings.fields.privatePort.env, 'PI_UI_PRIVATE_PORT');
  assert.equal(settings.fields.privatePort.default, 4319);
});
