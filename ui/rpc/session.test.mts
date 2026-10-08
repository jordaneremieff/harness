import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PrimarySession } from './session.mts';
import { FakeChild } from './fake-child.mts';
import type { RpcRecord } from './client.mts';
import type { EventData, EventName } from '../shared/api.ts';

function create(options: Partial<ConstructorParameters<typeof PrimarySession>[0]> = {}) {
  const child = new FakeChild(); const published: { name: EventName; data: EventData[EventName] }[] = [];
  child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'primary', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn,
    publish: (name, _target, data) => published.push({ name, data: structuredClone(data) }), ...options });
  return { child, session, published };
}
const message = (content: unknown = [], timestamp = 1) => ({ role: 'assistant', content, timestamp });

test('readiness waits for state/resources/history; handled prompt requires no settled event', async () => {
  const { child, session } = create(); await session.start();
  assert.equal(session.view.lifecycle, 'ready'); assert.equal(session.models[0]?.provider, 'acceptance-fixture');
  assert.equal(session.commands[0]?.name, 'fixture'); assert.equal(session.resourcesRevision, 1);
  assert.deepEqual(child.spawnArgs, ['--mode', 'rpc']);
  assert.deepEqual(await session.input('/fixture', 'followUp'), { disposition: 'handled' });
  assert.equal(child.writes.at(-1)?.streamingBehavior, 'followUp');
  await assert.rejects(session.input('/model', 'prompt'), { code: 'unsupported' });
  await session.input('/model literal', 'prompt', true); await session.close();
});
test('startup exit rejects without replacement or automatic prompt', async () => {
  const { child, session } = create(); child.onCommand = () => child.exit();
  await assert.rejects(session.start()); assert.equal(session.view.lifecycle, 'failed');
  assert.equal(child.writes.length, 1); assert.equal(child.writes[0]?.type, 'get_state');
});
test('startup trust dialog pauses deadline and responses have no command correlation', async () => {
  const { child, session } = create({ startupTimeoutMs: 1 });
  let startup: RpcRecord | undefined;
  child.onCommand = (record) => {
    if (record.type === 'get_state' && !startup) { startup = record; child.event({ type: 'extension_ui_request', id: 'trust', method: 'confirm', title: 'Trust?' }); }
    else if (record.type === 'extension_ui_response' && startup) child.defaults(startup);
    else child.defaults(record);
  };
  const start = session.start(); await child.command('get_state');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.view.pendingDialogs.length, 1);
  await session.respond('trust', { epoch: 1, confirmed: false }); await start;
  const responses = child.writes.filter((record) => record.type === 'extension_ui_response'); assert.equal(responses.length, 1);
  assert.equal(responses[0]?.id, 'trust'); await session.close();
});
test('concurrent dialogs validate method/epoch and answer once; timeout is local expiry only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, session, published } = create(); await session.start();
  child.event({ type: 'extension_ui_request', id: 'a', method: 'select', title: 'Choose', options: ['one', 'two'] });
  child.event({ type: 'extension_ui_request', id: 'b', method: 'editor', title: 'Edit', prefill: 'text' });
  await assert.rejects(session.respond('a', { epoch: 9, value: 'one' }), { code: 'stale_epoch' });
  await assert.rejects(session.respond('a', { epoch: 1, value: 'other' }), { code: 'invalid_request' });
  const key = session.view.pendingDialogs.find((dialog) => dialog.id === 'a')?.optionKeys?.[0]; assert.ok(key);
  await session.respond('a', { epoch: 1, value: key }); await assert.rejects(session.respond('a', { epoch: 1, value: key }));
  assert.equal(child.writes.find((record) => record.type === 'extension_ui_response' && record.id === 'a')?.value, 'one');
  child.event({ type: 'extension_ui_request', id: 'c', method: 'input', title: 'Timed', timeout: 0 });
  t.mock.timers.tick(1);
  assert.ok(published.some((event) => event.name === 'extension.expired' && (event.data as EventData['extension.expired']).id === 'c'));
  assert.equal(child.writes.filter((record) => record.id === 'c').length, 0);
  await session.transition({ epoch: 1, action: 'new' }); assert.equal(session.view.pendingDialogs.length, 0); await session.close();
});
test('extension keyed status/widget clearing remains in authoritative state', async () => {
  const { child, session } = create(); await session.start();
  child.event({ type: 'extension_ui_request', id: '1', method: 'setStatus', statusKey: 'status', statusText: 'Ready' });
  child.event({ type: 'extension_ui_request', id: '2', method: 'setWidget', widgetKey: 'widget', widgetLines: ['Line'] });
  assert.equal(session.view.extension?.statuses.status, 'Ready');
  child.event({ type: 'extension_ui_request', id: '3', method: 'setStatus', statusKey: 'status' });
  child.event({ type: 'extension_ui_request', id: '4', method: 'setWidget', widgetKey: 'widget' });
  assert.deepEqual(session.view.extension, { statuses: {}, widgets: {} }); await session.close();
});
test('select publishes protected labels and opaque keys but returns the exact original upstream', async () => {
  const { child, session, published } = create(); await session.start();
  const originals = ['\x1b[31mBearer syntheticTokenAlpha_123\x1b[0m', '\x1b[32mBearer syntheticTokenBeta_456\x1b[0m'];
  child.event({ type: 'extension_ui_request', id: 'private-select', method: 'select', title: 'Choose', options: originals });
  const dialog = session.view.pendingDialogs[0]; assert.ok(dialog?.optionKeys);
  assert.deepEqual(dialog.options, ['Bearer [redacted]', 'Bearer [redacted]']); assert.notEqual(dialog.optionKeys[0], dialog.optionKeys[1]);
  const browser = JSON.stringify({ view: session.view, published });
  assert.equal(browser.includes('syntheticToken'), false); assert.equal(browser.includes('\\u001b'), false);
  await assert.rejects(session.respond(dialog.id, { epoch: 1, value: originals[1] as string }), { code: 'invalid_request' });
  await assert.rejects(session.respond(dialog.id, { epoch: 1, value: dialog.options?.[1] as string }), { code: 'invalid_request' });
  const key = dialog.optionKeys[1]; assert.ok(key); assert.match(key, /^1:1:/);
  await assert.rejects(session.respond(dialog.id, { epoch: 1, value: `${key}x` }), { code: 'invalid_request' });
  await session.respond(dialog.id, { epoch: 1, value: key });
  assert.equal(child.writes.find((record) => record.type === 'extension_ui_response' && record.id === dialog.id)?.value, originals[1]);
  child.event({ type: 'extension_ui_request', id: dialog.id, method: 'select', title: 'Again', options: originals });
  await assert.rejects(session.respond(dialog.id, { epoch: 1, value: key }), { code: 'invalid_request' });
  await session.close();
});
test('sanitized status and widget keys remain distinct and clear the same public entries', async () => {
  const { child, session, published } = create(); await session.start();
  const raw = ['\x1b[31mBearer syntheticKeyAlpha_123\x1b[0m', '\x1b[32mBearer syntheticKeyBeta_456\x1b[0m'];
  for (const [index, key] of raw.entries()) {
    child.event({ type: 'extension_ui_request', id: `status-${index}`, method: 'setStatus', statusKey: key, statusText: 'Ready' });
    child.event({ type: 'extension_ui_request', id: `widget-${index}`, method: 'setWidget', widgetKey: key, widgetLines: ['Line'] });
  }
  const keys = Object.keys(session.view.extension?.statuses ?? {}); assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
  const browser = JSON.stringify({ view: session.view, published }); assert.equal(browser.includes('syntheticKey'), false); assert.equal(browser.includes('\\u001b'), false);
  child.event({ type: 'extension_ui_request', id: 'replace', method: 'setStatus', statusKey: raw[0], statusText: 'Changed' });
  assert.equal(Object.keys(session.view.extension?.statuses ?? {}).length, 2); assert.equal(session.view.extension?.statuses[keys[0] as string], 'Changed');
  child.event({ type: 'extension_ui_request', id: 'clear-status', method: 'setStatus', statusKey: raw[0] });
  child.event({ type: 'extension_ui_request', id: 'clear-widget', method: 'setWidget', widgetKey: raw[0] });
  assert.deepEqual(Object.keys(session.view.extension?.statuses ?? {}), [keys[1]]); assert.deepEqual(Object.keys(session.view.extension?.widgets ?? {}), [keys[1]]);
  await session.close();
});
test('private select retention is bounded and stop releases originals before another request', async () => {
  const { child, session } = create(); await session.start();
  const option = `Bearer ${'a'.repeat(15000)}`;
  for (let i = 0; i < 5; i++) child.event({ type: 'extension_ui_request', id: `large-${i}`, method: 'select', title: 'Choose', options: [option] });
  assert.equal(session.view.pendingDialogs.length, 4); assert.equal(session.view.capabilities.input, false);
  await session.stop(); await session.resynchronize();
  child.event({ type: 'extension_ui_request', id: 'again', method: 'select', title: 'Choose', options: [option] });
  assert.equal(session.view.pendingDialogs.length, 1); assert.equal(session.view.capabilities.input, true); await session.close();
});
test('timeout, epoch replacement and exit release select originals and refuse old keys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, session } = create(); await session.start(); const option = `Bearer ${'b'.repeat(15000)}`;
  for (let i = 0; i < 4; i++) child.event({ type: 'extension_ui_request', id: `timed-${i}`, method: 'select', title: 'Choose', options: [option], timeout: 0 });
  t.mock.timers.tick(1); assert.equal(session.view.pendingDialogs.length, 0);
  for (let i = 0; i < 4; i++) child.event({ type: 'extension_ui_request', id: `epoch-${i}`, method: 'select', title: 'Choose', options: [option] });
  assert.equal(session.view.pendingDialogs.length, 4); const oldKey = session.view.pendingDialogs[0]?.optionKeys?.[0]; assert.ok(oldKey);
  await session.transition({ epoch: 1, action: 'new' });
  child.event({ type: 'extension_ui_request', id: 'epoch-0', method: 'select', title: 'Choose', options: [option] });
  assert.equal(session.view.pendingDialogs.length, 1); assert.equal(session.view.capabilities.input, true);
  await assert.rejects(session.respond('epoch-0', { epoch: 2, value: oldKey }), { code: 'invalid_request' });
  await session.refreshState(); child.exit(0); assert.equal(session.view.pendingDialogs.length, 0);
  await assert.rejects(session.respond('epoch-0', { epoch: 2, value: oldKey }), { code: 'invalid_request' }); await session.close();
});
test('stop cancels dialogs, clears queue before abort and preserves exact recovered text', async () => {
  const { child, session } = create(); await session.start();
  child.event({ type: 'extension_ui_request', id: 'q', method: 'input', title: 'Input' });
  child.onCommand = (record) => record.type === 'clear_queue' ? child.response(record, { steering: ['exact  text'], followUp: ['next\nline'] }) : child.defaults(record);
  await session.stop(); assert.deepEqual(child.writes.slice(-3).map((record) => record.type), ['extension_ui_response', 'clear_queue', 'abort']);
  assert.deepEqual(session.recoveredQueue, { steering: ['exact  text'], followUp: ['next\nline'] }); child.onCommand = (record) => child.defaults(record); await session.close();
});
test('agent_end and retry do not produce idle until agent_settled', async () => {
  const { child, session } = create(); await session.start();
  child.event({ type: 'agent_start' }); child.event({ type: 'agent_end', willRetry: true }); assert.equal(session.view.activity, 'running');
  child.event({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: 'temporary' });
  child.event({ type: 'auto_retry_end', success: true }); assert.equal(session.view.activity, 'retrying');
  child.event({ type: 'agent_settled' }); assert.equal(session.view.activity, 'idle'); await session.close();
});
test('metadata state does not erase a newer event-derived activity', async () => {
  const { child, session } = create(); await session.start();
  child.onCommand = (record) => { if (record.type === 'get_state') child.event({ type: 'agent_start' }); child.defaults(record); };
  await session.refreshState(); assert.equal(session.view.activity, 'running'); await session.close();
});
test('late metadata from the previous epoch never replaces the new session identity', async () => {
  const { child, session } = create(); await session.start(); let held: RpcRecord | undefined;
  child.onCommand = (record) => { if (record.type === 'get_state' && !held) held = record; else child.defaults(record); };
  const late = session.refreshState(); const rejected = assert.rejects(late, { code: 'stale_epoch' });
  await session.transition({ epoch: 1, action: 'new' }); assert.ok(held);
  child.response(held, { sessionId: 'old', isStreaming: false, isCompacting: false }); await rejected;
  assert.equal(session.view.sessionId, 'fixture'); await session.close();
});
test('stream/snapshot race publishes each delta once and replaces final message by stable ID', async () => {
  const { child, session, published } = create(); await session.start();
  child.onCommand = (record) => {
    if (record.type === 'get_entries') {
      child.event({ type: 'message_start', message: message() });
      child.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
      child.response(record, { entries: [], leafId: null });
    } else child.defaults(record);
  };
  await session.resynchronize(); assert.equal(session.messages.length, 1);
  const id = session.messages[0]?.id;
  assert.equal(published.filter((event) => event.name === 'primary.delta').length, 1);
  const part = session.messages[0]?.parts[0]; assert.ok(part && part.type === 'text'); assert.equal(part.text, 'hello');
  child.event({ type: 'message_end', message: message([{ type: 'text', text: 'hello final' }]) });
  assert.equal(session.messages.length, 1); assert.equal(session.messages[0]?.id, id); assert.equal(session.messages[0]?.state, 'final'); await session.close();
});
test('snapshot reconciliation preserves in-flight tool output and publishes it once', async () => {
  const { child, session, published } = create(); await session.start();
  child.onCommand = (record) => {
    if (record.type === 'get_entries') {
      child.event({ type: 'tool_execution_update', toolCallId: 'call', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial result' }] } });
      child.response(record, { entries: [], leafId: null });
    } else child.defaults(record);
  };
  await session.resynchronize(); assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0]?.id, 'tool:call'); assert.equal(session.messages[0]?.state, 'partial');
  assert.equal(published.filter((event) => event.name === 'primary.tool').length, 1); await session.close();
});
test('snapshot selects active branch and does not duplicate buffered finalized content', async () => {
  const { child, session } = create(); await session.start();
  child.onCommand = (record) => {
    if (record.type !== 'get_entries') { child.defaults(record); return; }
    child.event({ type: 'message_start', message: message() });
    child.event({ type: 'message_end', message: message([{ type: 'text', text: 'final' }]) });
    child.response(record, { entries: [{ type: 'message', id: 'a', parentId: null, message: message([{ type: 'text', text: 'final' }]) },
      { type: 'message', id: 'other', parentId: null, message: message([{ type: 'text', text: 'abandoned' }], 2) }], leafId: 'a' });
  };
  await session.resynchronize(); assert.equal(session.messages.length, 1); assert.equal(session.entries[0]?.id, 'a'); await session.close();
});
test('new/fork replace epoch only after noncancelled result and stale controls refuse', async () => {
  const { child, session } = create(); await session.start();
  child.onCommand = (record) => record.type === 'new_session' ? child.response(record, { cancelled: true }) : child.defaults(record);
  await session.transition({ epoch: 1, action: 'new' }); assert.equal(session.view.epoch, 1);
  await session.transition({ epoch: 1, action: 'fork', entryId: 'entry' }); assert.equal(session.view.epoch, 2);
  await assert.rejects(session.control({ epoch: 1, action: 'thinking', level: 'high' }), { code: 'stale_epoch' }); await session.close();
});
test('handoff needs persisted file, freezes admissions, waits for settled and process exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-handoff-'));
  try {
    const file = join(directory, "saved 'session.jsonl"); await writeFile(file, '{}\n');
    const { child, session } = create(); await session.start();
    await assert.rejects(session.handoff({ epoch: 1, mode: 'settle', clearQueue: false }), { code: 'not_ready' });
    child.onCommand = (record) => record.type === 'get_state' ? child.response(record, { sessionId: 'fixture', sessionFile: file, isStreaming: false, isCompacting: false }) : child.defaults(record);
    child.event({ type: 'agent_start' }); const handoff = session.handoff({ epoch: 1, mode: 'settle', clearQueue: false });
    await assert.rejects(session.input('not admitted', 'prompt'), { code: 'not_ready' }); child.event({ type: 'agent_end' });
    assert.equal(session.view.lifecycle, 'ready'); child.event({ type: 'agent_settled' });
    const result = await handoff; assert.equal(session.view.lifecycle, 'stopped'); assert.deepEqual(result.argv, ['--session', await realpath(file)]);
    assert.ok(result.command.includes("'\\''"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('handoff refuses to report success while child remains alive', async () => {
  const { child, session } = create({ sessionFile: import.meta.filename, shutdownTimeoutMs: 1 }); await session.start();
  child.onCommand = (record) => record.type === 'get_state' ? child.response(record, { sessionId: 'fixture', sessionFile: import.meta.filename, isStreaming: false, isCompacting: false }) : child.defaults(record);
  child.autoExit = false; await assert.rejects(session.handoff({ epoch: 1, mode: 'settle', clearQueue: false }), { code: 'handoff_blocked' });
  assert.equal(session.view.lifecycle, 'stopping'); child.exit(0);
});
