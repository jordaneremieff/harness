import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PrimarySession } from './session.mts';

async function evidence(cwd: string) {
  const path = join(cwd, 'owner-recovery-commands.json'); assert.ok((await stat(path)).size <= 65536);
  return JSON.parse(await readFile(path, 'utf8')) as {pid: number; sessionId: string; commands: string[]; overflow: boolean};
}
test('executable owner recovery phases retain partial text and expose the unmatched response without provider work', {timeout: 15000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rpc-owner-')), events = new EventEmitter();
  const session = new PrimarySession({key: 'fixture', executable: resolve('ui/rpc/fake-pi.mts'), cwd, publish: (name, _target, data) => events.emit(name, data)});
  try {
    await session.start(); const firstDialog = once(events, 'extension.request');
    assert.deepEqual(await session.input('/fixture owner-recovery', 'prompt'), {disposition: 'started'});
    const [first] = await firstDialog, entry = session.entries.find(value => value.messages?.some(message => message.role === 'assistant')); assert.ok(entry);
    assert.match(JSON.stringify(entry), /before/);
    assert.deepEqual(await session.input('healthy while busy', 'steer'), {disposition: 'queued'});
    await session.refreshState(); assert.equal(session.client.synchronized, true);
    const nextDialog = once(events, 'extension.request'); await session.respond(first.id, {epoch: session.view.epoch, confirmed: true}); const [next] = await nextDialog;
    const updated = session.entries.find(value => value.id === entry.id); assert.ok(updated); assert.match(JSON.stringify(updated), /before after/);
    const fault = new Promise<void>(resolve => {events.on('primary.state', view => {if (view.lastError?.code === 'protocol_error') resolve();});});
    await session.respond(next.id, {epoch: session.view.epoch, confirmed: true}); await fault;
    assert.equal(session.client.synchronized, false); assert.equal(session.view.capabilities.input, false);
    const commands = await evidence(cwd); assert.equal(commands.pid, session.view.pid); assert.equal(commands.sessionId, session.view.sessionId); assert.equal(commands.overflow, false);
    assert.equal(commands.commands.some(type => ['abort','clear_queue','new_session'].includes(type)), false);
  } finally {await session.close(); await rm(cwd, {recursive: true, force: true});}
});
test('executable command evidence is bounded and explicitly reports exhaustion', {timeout: 30000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rpc-evidence-')), events = new EventEmitter();
  const session = new PrimarySession({key: 'fixture', executable: resolve('ui/rpc/fake-pi.mts'), cwd, publish: (name, _target, data) => events.emit(name, data)});
  try {
    await session.start(); const dialog = once(events, 'extension.request'); await session.input('/fixture owner-recovery', 'prompt'); await dialog;
    for (let index = 0; index < 260; index++) await session.refreshState();
    const commands = await evidence(cwd); assert.equal(commands.commands.length, 256); assert.equal(commands.overflow, true);
  } finally {await session.close(); await rm(cwd, {recursive: true, force: true});}
});

test('executable fixture streams tools/dialogs, persists history and releases writer for resume', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rpc-fixture-')); const events = new EventEmitter();
  const session = new PrimarySession({ key: 'fixture', executable: resolve('ui/rpc/fake-pi.mts'), cwd,
    publish: (name, _target, data) => events.emit(name, data) });
  try {
    await session.start(); assert.equal(session.view.model?.provider, 'acceptance-fixture');
    const dialog = once(events, 'extension.request'); const tool = once(events, 'primary.tool');
    assert.deepEqual(await session.input('Run the fixture', 'prompt'), { disposition: 'started' });
    const [request] = await dialog; await tool;
    assert.equal(request.method, 'confirm'); const settled = once(events, 'primary.state');
    await session.respond(request.id, { epoch: session.view.epoch, confirmed: true });
    await settled;
    // A correlated read follows all fixture completion records on the input lane.
    await session.refreshState(); assert.equal(session.view.activity, 'idle');
    const handoff = await session.handoff({ epoch: session.view.epoch, mode: 'settle', clearQueue: false });
    assert.equal(session.view.lifecycle, 'stopped');
    const resumed = new PrimarySession({ key: 'resumed', executable: resolve('ui/rpc/fake-pi.mts'), cwd, sessionFile: handoff.sessionFile, publish: () => {} });
    try { await resumed.start(); assert.ok(resumed.entries.length >= 4); assert.equal(resumed.view.sessionId, session.view.sessionId); }
    finally { await resumed.close(); }
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }); }
});
