import { parentPort } from 'node:worker_threads';
import { EventProjection } from './events.mts';
import type { PrimaryView } from '../shared/api.ts';

const port = parentPort;
if (!port) throw new Error('RPC decoder requires a worker port.');
port.on('message', ({ bytes, windows }: {bytes: Uint8Array; windows: [string, string][]}) => {
  try {
    const record = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/\r$/, ''));
    if (record?.type === 'response' && record.command === 'get_entries' && record.success === true) {
      const view: PrimaryView = { key: 'decode', cwd: '', epoch: 0, lifecycle: 'starting', activity: 'unknown', pendingDialogs: [], pendingOperationIds: [], capabilities: {} };
      const projection = new EventProjection(view, () => {}, () => {});
      const before = new Map(windows).get(record.id);
      try { projection.snapshot(record.data, before); record.data = projection.exportSnapshot(); }
      catch (error) {
        if (before === undefined) throw error;
        record.success = false; record.error = 'History source unavailable.'; record.localHistoryFailure = true; delete record.data;
      }
    }
    port.postMessage({ record });
  } catch { port.postMessage({ error: true }); }
});
