import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RpcRecord, SpawnChild } from './client.mts';

/** A deterministic process double for the ordinary RPC boundary. */
export class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  pid = 123;
  writes: RpcRecord[] = [];
  onCommand?: (record: RpcRecord) => void;
  autoExit = true;
  blocked = false;
  release?: () => void;
  spawnArgs?: string[];
  constructor() {
    super();
    this.stdin = new Writable({ highWaterMark: 1,
      write: (chunk, _encoding, callback) => {
        const record = JSON.parse(chunk.toString()) as RpcRecord;
        this.writes.push(record); this.emit('command', record);
        queueMicrotask(() => this.onCommand?.(record));
        if (this.blocked) this.release = () => callback(); else callback();
      },
      final: (callback) => { callback(); if (this.autoExit) queueMicrotask(() => this.exit(0)); },
    });
  }
  spawn: SpawnChild = (_executable, args) => { this.spawnArgs = args; return this as unknown as ChildProcessWithoutNullStreams; };
  event(record: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify(record)}\n`); }
  response(record: RpcRecord, data?: unknown): void { this.event({ type: 'response', id: record.id, command: record.type, success: true, ...(data === undefined ? {} : { data }) }); }
  reject(record: RpcRecord): void { this.event({ type: 'response', id: record.id, command: record.type, success: false, error: 'private input must not appear' }); }
  exit(code = 1): void { this.emit('exit', code, null); this.stdout.end(); this.stderr.end(); this.emit('close', code, null); }
  async command(type: string): Promise<RpcRecord> {
    const existing = this.writes.find((record) => record.type === type);
    if (existing) return existing;
    for (;;) { const [record] = await once(this, 'command'); if ((record as RpcRecord).type === type) return record as RpcRecord; }
  }
  defaults(record: RpcRecord): void {
    switch (record.type) {
      case 'extension_ui_response': break;
      case 'get_state': this.response(record, { sessionId: 'fixture', isStreaming: false, isCompacting: false, model: { provider: 'acceptance-fixture', id: 'test', name: 'Fixture', reasoning: true, input: ['text'] } }); break;
      case 'get_session_stats': this.response(record, { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0, contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 } }); break;
      case 'get_commands': this.response(record, { commands: [{ name: 'fixture', description: 'Fixture command', source: 'extension' }] }); break;
      case 'get_available_models': this.response(record, { models: [{ provider: 'acceptance-fixture', id: 'test', name: 'Fixture', reasoning: true, input: ['text'] }] }); break;
      case 'get_available_thinking_levels': this.response(record, { levels: ['off', 'high'] }); break;
      case 'get_entries': this.response(record, { entries: [], leafId: null }); break;
      case 'clear_queue': this.response(record, { steering: [], followUp: [] }); break;
      case 'new_session': case 'switch_session': case 'fork': this.response(record, { cancelled: false }); break;
      case 'prompt': this.response(record, { disposition: 'handled' }); break;
      default: this.response(record);
    }
  }
}
