import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PrimarySession } from './session.mts';

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
