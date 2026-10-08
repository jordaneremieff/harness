import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeChild } from './fake-child.mts';
import { PrimarySession } from './session.mts';
import type { RpcRecord } from './client.mts';

async function create() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ui-compact-handoff-'))); const path = join(directory, 'session.jsonl');
  await writeFile(path, `${JSON.stringify({ type: 'session', id: 'fixture', version: 3, cwd: process.cwd() })}\n`);
  const child = new FakeChild(); child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {} });
  await session.start(); let compact: RpcRecord | undefined; let started!: () => void;
  const compactionStarted = new Promise<void>((resolve) => { started = resolve; });
  child.onCommand = (record) => {
    if (record.type === 'compact') { compact = record; child.event({ type: 'compaction_start', reason: 'manual' }); started(); }
    else if (record.type === 'get_state') child.response(record, { sessionId: 'fixture', sessionFile: path, isStreaming: false, isCompacting: false });
    else child.defaults(record);
  };
  const privateSession = session as unknown as { settled: Set<unknown>; frozen: boolean };
  const finish = (success: boolean) => {
    assert.ok(compact); child.event({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false,
      ...(success ? {} : { errorMessage: 'Compaction failed: Nothing to compact (session too small)' }) });
    child.event({ type: 'response', id: compact.id, command: compact.type, success,
      ...(success ? { data: {} } : { error: 'Nothing to compact (session too small)' }) });
  };
  return { child, session, privateSession, finish, compactionStarted, path, cleanup: async () => { await session.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const success of [false, true]) {
  test(`manual compact ${success ? 'success' : 'refusal'} releases an admitted settle handoff through authoritative idle state`, async () => {
    const setup = await create(); const { session, privateSession } = setup;
    try {
      const compact = session.control({ epoch: 1, action: 'compact' });
      const completed = success ? compact : assert.rejects(compact, { message: 'Nothing to compact (session too small)' });
      await setup.compactionStarted;
      const handoff = session.handoff({ epoch: 1, mode: 'settle', clearQueue: false }); void handoff.catch(() => {});
      assert.equal(privateSession.settled.size, 1); assert.equal(privateSession.frozen, true); assert.equal(session.view.lifecycle, 'ready');
      setup.finish(success); await completed;
      assert.equal(privateSession.settled.size, 0, 'An authoritative manual idle refresh must release the handoff waiter');
      const receipt = await handoff; assert.equal(receipt.sessionFile, setup.path); assert.equal(session.view.lifecycle, 'stopped');
      assert.equal(session.client.exited, true);
    } finally { await setup.cleanup(); }
  });
}

for (const recovery of ['retry', 'compaction']) {
  test(`newer automatic ${recovery} cannot release a manual compact handoff with a stale idle state response`, async () => {
    const setup = await create(); const { child, session, privateSession } = setup;
    try {
      const compact = session.control({ epoch: 1, action: 'compact' });
      const rejected = assert.rejects(compact, { message: 'Nothing to compact (session too small)' }); await setup.compactionStarted;
      const handoff = session.handoff({ epoch: 1, mode: 'settle', clearQueue: false }); void handoff.catch(() => {});
      setup.finish(false);
      if (recovery === 'retry') child.event({ type: 'auto_retry_start', attempt: 1 });
      else {
        child.event({ type: 'compaction_start', reason: 'overflow' });
        child.event({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true });
      }
      await rejected;
      assert.equal(privateSession.settled.size, 1); assert.equal(session.client.exited, false);
      assert.equal(session.view.activity, recovery === 'retry' ? 'retrying' : 'compacting');
      child.event({ type: 'agent_settled' }); await handoff; assert.equal(session.view.lifecycle, 'stopped');
    } finally { await setup.cleanup(); }
  });
}
