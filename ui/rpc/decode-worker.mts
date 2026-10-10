import { parentPort } from 'node:worker_threads';
import { EventProjection } from './events.mts';
import type { PrimaryView } from '../shared/api.ts';
import { imagePart } from '../server/images.mts';

function suffix(value: unknown): {entries: never[]; leafId: string | null; historyChanged: boolean} {
  if (!value || typeof value !== 'object') throw new Error('Invalid retained-entry suffix.');
  const source = value as {entries: unknown; leafId: unknown};
  if (!Array.isArray(source.entries) || !(source.leafId === null || (typeof source.leafId === 'string' && source.leafId.length <= 256))) throw new Error('Invalid retained-entry suffix.');
  return {entries: [], leafId: source.leafId as string | null, historyChanged: source.entries.length > 0};
}
/** Large live RPC images become metadata before their records reach the HTTP loop. */
function projectImages(raw: unknown, depth = 0): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 8) return;
  const message = raw as {content?: unknown; parts?: unknown};
  const parts = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part?.type === 'image') parts[index] = imagePart(part);
    else if (part?.type === 'toolResult') projectImages(part, depth + 1);
  }
}
const port = parentPort;
if (!port) throw new Error('RPC decoder requires a worker port.');
port.on('message', ({ bytes, windows, incremental }: {bytes: Uint8Array; windows: [string, string][]; incremental: string[]}) => {
  try {
    const record = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/\r$/, ''));
    if (record?.type === 'response' && record.command === 'get_entries' && record.success === true) {
      if (incremental.includes(record.id)) {
        record.data = suffix(record.data);
        port.postMessage({record}); return;
      }
      const view: PrimaryView = { key: 'decode', cwd: '', epoch: 0, lifecycle: 'starting', activity: 'unknown', pendingDialogs: [], pendingOperationIds: [], capabilities: {} };
      const projection = new EventProjection(view, () => {}, () => {});
      const before = new Map(windows).get(record.id);
      try { projection.snapshot(record.data, before); record.data = projection.exportSnapshot(); }
      catch (error) {
        if (before === undefined) throw error;
        record.success = false; record.error = 'History source unavailable.'; record.localHistoryFailure = true; delete record.data;
      }
    }
    projectImages(record.message); projectImages(record.result); projectImages(record.partialResult);
    port.postMessage({ record });
  } catch { port.postMessage({ error: true }); }
});
