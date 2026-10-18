import assert from 'node:assert/strict';
import test from 'node:test';
import type {OperationView} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
const {app, arrive, settle, agentControl, primaryFixture, agentFixture, targetFixture, hostDocument} = await createAppFixture();

test('an agent composer reads its host commands once on the first slash, shows their source, and runs one only after Run command', async t => {
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original; Reflect.deleteProperty(hostDocument, 'execCommand');});
  const identity = 'agent-commands-app', target = {kind: 'agent' as const, identity};
  const reads: string[] = [], runs: {path: string; body: unknown; key: string | null}[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === `/api/agents/${identity}/commands`) { reads.push(url.search); return Response.json({ok: true, data: {items: [{name: 'ping', description: 'Reply with pong', source: 'alpha'}, {name: 'status', description: 'Show status', source: 'beta'}], incomplete: false}}); }
    if (url.pathname === `/api/agents/${identity}/command`) {
      runs.push({path: url.pathname, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('Idempotency-Key')});
      const view: OperationView = {id: runs.at(-1)?.key ?? '', kind: 'agent.command', target, state: 'completed', createdAt: 'a', updatedAt: 'b', receipt: {kind: 'command', name: 'ping', text: 'pong', truncated: false}};
      return Response.json({ok: true, data: view});
    }
    if (url.pathname === '/api/operations') return Response.json({ok: true, data: {operationId: `reserved-${Math.random().toString(16).slice(2)}`}});
    return original(input, init);
  };
  Object.defineProperty(hostDocument, 'execCommand', {configurable: true, value: (_command: string, _ui: boolean, value: string) => {
    const editor = hostDocument.activeElement as unknown as {value: string; selectionStart: number; selectionEnd: number; setSelectionRange(a: number, b: number): void; dispatch(name: string): void};
    const at = editor.selectionStart; editor.value = editor.value.slice(0, at) + value + editor.value.slice(editor.selectionEnd); editor.setSelectionRange(at + value.length, at + value.length); editor.dispatch('input'); return true;
  }});
  const row = agentFixture(identity, {capabilities: {history: true, observe: true, input: true, abort: true, configure: false, commands: true}});
  await arrive({workspace: {id: 'agent-commands', revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: 12100})], roster: [row], targets: [targetFixture('agent-commands-draft', target, {draft: {revision: 1, text: '', mode: 'followUp', images: [], persisted: true}})]});
  await settle();
  const editor = agentControl('editor') as HostNode & {placeholder: string};
  assert.equal(editor.placeholder, 'Message Unnamed conversation…');
  assert.equal(reads.length, 0, 'nothing is read before a slash');
  editor.focus(); editor.value = 'hello'; editor.setSelectionRange(5, 5); editor.dispatch('input'); await settle(); assert.equal(reads.length, 0);
  editor.value = '/'; editor.setSelectionRange(1, 1); editor.dispatch('input'); await settle();
  assert.equal(reads.length, 1); assert.match(reads[0] ?? '', /workspace=agent-commands/);
  const menu = agentControl('commands'); assert.equal(menu.hidden, false);
  assert.deepEqual(menu.querySelectorAll('.command-name').map(node => node.textContent), ['/ping', '/status']); assert.deepEqual(menu.querySelectorAll('.command-source').map(node => node.textContent), ['alpha', 'beta']);
  editor.value = '/pi'; editor.setSelectionRange(3, 3); editor.dispatch('input'); await settle(); assert.equal(reads.length, 1, 'the same epoch reuses the list');
  const send = agentControl('send'); assert.equal(send.textContent, 'Send');
  editor.dispatch('keydown', {key: 'Enter'}); await settle(); assert.equal(editor.value, '/ping ', 'Enter inserts the name and sends nothing'); assert.equal(runs.length, 0);
  assert.equal(send.textContent, 'Run command');
  const composer = app.agentComposer(); const sending = composer.send(); await settle(); await sending;
  assert.equal(runs.length, 1); assert.deepEqual(runs[0]?.body, {name: 'ping'}); assert.equal(editor.value, ''); assert.equal(send.textContent, 'Send');
  assert.match(agentControl('receipt').textContent, /Command \/ping ran/);
});
