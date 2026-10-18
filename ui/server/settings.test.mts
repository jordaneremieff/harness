import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readSettings, settings } from './settings.mts';

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
  assert.deepEqual(snapshot, {userStylesheet: undefined, origin: 'default', status: 'unset', diagnostics: []});
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
