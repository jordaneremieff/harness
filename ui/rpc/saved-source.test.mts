import assert from 'node:assert/strict';
import fs, { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FileHistory } from '../server/history.mts';
import { PrimarySession } from './session.mts';
import { FakeChild } from './fake-child.mts';

for (const ending of ['close', 'exit'] as const) {
  test(`saved source stat after ${ending} does not create an unowned history worker`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'ui-saved-source-')); const path = join(directory, 'session.jsonl');
    await writeFile(path, `${JSON.stringify({ type: 'session', id: 'fixture', version: 3, cwd: process.cwd() })}\n`);
    const child = new FakeChild(); child.onCommand = (record) => child.defaults(record);
    const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {} });
    const privateSession = session as unknown as { fileHistory?: FileHistory; closing?: Promise<void> };
    let release!: () => void; let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const statStarted = new Promise<void>((resolve) => { reached = resolve; });
    const stat = fs.stat;
    await session.start(); session.view.sessionFile = path;
    const mocked = t.mock.method(fs, 'stat', async (...args: Parameters<typeof stat>) => {
      if (args[0] === path) { reached(); await paused; }
      return Reflect.apply(stat, fs, args);
    });
    syncBuiltinESMExports();
    try {
      const window = session.historyWindow('before'); const rejected = assert.rejects(window, { code: 'not_ready' });
      await statStarted;
      if (ending === 'exit') {
        child.exit(0); assert.equal(session.client.exited, true); assert.equal(privateSession.closing, undefined);
      } else await session.close();
      assert.equal(privateSession.fileHistory, undefined);
      release(); await rejected;
      assert.equal(privateSession.fileHistory, undefined, 'Shutdown must precede any saved-file worker allocation');
    } finally {
      release(); mocked.mock.restore(); syncBuiltinESMExports();
      await privateSession.fileHistory?.close(); await session.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}

test('starting-session hydration creates and closes the saved-file worker normally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-saved-start-')); const path = join(directory, 'session.jsonl');
  const entries = [
    { type: 'session', id: 'fixture', version: 3, cwd: process.cwd() },
    { type: 'message', id: 'message', parentId: null, message: { role: 'user', timestamp: 1, content: 'saved content' } },
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const child = new FakeChild(); child.onCommand = (record) => {
    if (record.type === 'get_state') child.response(record, { sessionId: 'fixture', sessionFile: path, isStreaming: false, isCompacting: false });
    else if (record.type === 'get_entries') child.response(record, { entries: [], leafId: 'message' });
    else child.defaults(record);
  };
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {} });
  try {
    await session.start(); assert.equal(session.view.lifecycle, 'ready');
    assert.equal(session.entries[0]?.id, 'message'); assert.equal(session.messages.length, 1);
    assert.ok((session as unknown as { fileHistory?: FileHistory }).fileHistory);
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});
