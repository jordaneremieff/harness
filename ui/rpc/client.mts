import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';

export type RpcRecord = Record<string, unknown> & { type: string };
export type SpawnChild = (executable: string, args: string[], options: { cwd: string; stdio: ['pipe', 'pipe', 'pipe']; shell: false }) => ChildProcessWithoutNullStreams;
export class RpcError extends Error {
  code: string; uncertain: boolean;
  constructor(code: string, message: string, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; }
}
export interface RpcClientOptions {
  executable: string; cwd: string; sessionFile?: string; spawnChild?: SpawnChild;
  maxRecordBytes?: number; shutdownTimeoutMs?: number;
  measure?: (stage: string, id: string, at: number, bytes?: number) => void;
  onEvent?: (event: RpcRecord) => void;
  onExit?: (error?: RpcError) => void;
  onProtocolError?: (error: RpcError) => void;
}
interface Pending { beforeEntryId?: string; type: string; resolve: (data: unknown) => void; reject: (error: RpcError) => void; dispatched: boolean; at: number }

export function displayText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export class RpcClient {
  child?: ChildProcessWithoutNullStreams;
  synchronized = true;
  readonly timings: { id: string; command: string; dispatch: number; acknowledgment: number }[] = [];
  private pending = new Map<string, Pending>();
  private counter = 0;
  private receiptCounter = 0;
  private accumulator = Buffer.alloc(0);
  private bytes = 0;
  private discarding = false;
  private stderr = Buffer.alloc(0);
  private stderrDecoder = new StringDecoder('utf8');
  private writeTail: Promise<void> = Promise.resolve();
  private ended = false;
  private processExited = false;
  private decoderClosed?: Promise<number>;
  private closing = false;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private closePromise?: Promise<void>;
  private records: Buffer[] = [];
  private recordBytes = 0;
  private decoding = false;
  private worker?: Worker;
  private options: RpcClientOptions;
  constructor(options: RpcClientOptions) { this.options = options; }
  get stderrTail(): string { return displayText(this.stderr.toString('utf8')); }
  get pendingCount(): number { return this.pending.size; }
  get exited(): boolean { return this.processExited; }
  get available(): boolean { return !!this.child && !this.ended && !this.closing; }
  start(sessionFile = this.options.sessionFile): void {
    if (this.child || this.ended || this.closing) throw new RpcError('not_ready', 'RPC process already started or closed.');
    const args = ['--mode', 'rpc'];
    if (sessionFile) args.push('--session', sessionFile);
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    try {
      const child = (this.options.spawnChild ?? spawn)(this.options.executable, args, { cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.child = child;
      child.on('error', () => {
        const error = new RpcError('host_unavailable', 'RPC process failed.');
        if (child.pid === undefined) this.processExit(error); else this.transportFailure(error);
      });
      const exit = (code: number | null, signal: NodeJS.Signals | null) => this.processExit(this.closing && code === 0 && !signal ? undefined : new RpcError('delivery_uncertain', 'RPC process exited.', true));
      child.on('exit', exit); child.on('close', exit);
      child.stdout.on('data', (chunk: Buffer) => this.consume(Buffer.from(chunk)));
      child.stderr.on('data', (chunk: Buffer) => {
        const text = Buffer.from(this.stderrDecoder.write(chunk));
        this.stderr = Buffer.concat([this.stderr, text]).subarray(-64 * 1024);
      });
      child.stdin.on('error', () => this.transportFailure(new RpcError('delivery_uncertain', 'RPC input pipe failed.', true)));
    } catch {
      const error = new RpcError('host_unavailable', 'RPC process setup failed.');
      if (this.child?.pid === undefined) this.processExit(error); else this.transportFailure(error);
    }
  }
  request(type: string, fields: Record<string, unknown> = {}, beforeEntryId?: string): Promise<unknown> {
    if (!this.child || this.ended || this.closing) return Promise.reject(new RpcError('not_ready', 'RPC process is not available.'));
    if (this.pending.size >= 64) return Promise.reject(new RpcError('capacity', 'Too many outstanding RPC commands.'));
    if (!this.synchronized && !type.startsWith('get_') && type !== 'abort' && type !== 'abort_retry' && type !== 'clear_queue')
      return Promise.reject(new RpcError('protocol_error', 'RPC synchronization requires an explicit refresh.'));
    const id = `rpc-${++this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { type, resolve, reject, dispatched: false, at: 0, beforeEntryId }));
    void this.write({ ...fields, type, id }, (bytes) => {
      const pending = this.pending.get(id);
      if (!pending) throw new RpcError('not_ready', 'RPC command no longer pending.');
      pending.dispatched = true; pending.at = performance.now(); this.options.measure?.('rpc.dispatch', id, pending.at, bytes);
    }).catch((error: unknown) => {
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); pending.reject(new RpcError('delivery_uncertain', error instanceof RpcError ? error.message : 'RPC write failed.', pending.dispatched)); }
    });
    return result;
  }
  sendUI(record: Record<string, unknown>): Promise<void> { return this.write({ ...record, type: 'extension_ui_response' }); }
  markSynchronized(): void { this.synchronized = true; }
  private write(record: Record<string, unknown>, before?: (bytes: number) => void): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const job = this.writeTail.then(async () => {
      if (!this.child || this.ended || this.closing) throw new RpcError('not_ready', 'RPC process is not available.');
      before?.(Buffer.byteLength(line));
      const input = this.child.stdin;
      await new Promise<void>((resolve, reject) => {
        let flushed = false; let drained = true;
        const done = () => { if (flushed && drained) { input.off('error', fail); input.off('close', fail); resolve(); } };
        const fail = () => { input.off('drain', drain); input.off('error', fail); input.off('close', fail); reject(new RpcError('delivery_uncertain', 'RPC write failed.', true)); };
        const drain = () => { drained = true; done(); };
        input.once('error', fail); input.once('close', fail);
        drained = input.write(line, (error) => { if (error) fail(); else { flushed = true; done(); } });
        if (!drained) input.once('drain', drain);
      });
    });
    this.writeTail = job.catch(() => {});
    return job;
  }
  private consume(chunk: Buffer): void {
    if (this.ended) return;
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf;
      const segment = chunk.subarray(start, end);
      if (!this.discarding) this.accumulate(segment);
      if (lf === -1) break;
      if (!this.discarding) this.enqueue(Buffer.from(this.accumulator.subarray(0, this.bytes)));
      if (this.accumulator.length > 256 * 1024) this.accumulator = Buffer.alloc(0);
      this.bytes = 0; this.discarding = false; start = lf + 1;
    }
  }
  private accumulate(segment: Buffer): void {
        const limit = this.options.maxRecordBytes ?? 32 * 1024 * 1024;
        const required = this.bytes + segment.length;
        if (required > limit) {
          this.accumulator = Buffer.alloc(0); this.bytes = 0; this.discarding = true;
          this.protocolError('RPC record exceeds the display synchronization limit.');
        } else if (segment.length) {
          if (required > this.accumulator.length) {
            const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(required, this.accumulator.length * 2, 64 * 1024)));
            this.accumulator.copy(grown, 0, 0, this.bytes); this.accumulator = grown;
          }
          segment.copy(this.accumulator, this.bytes); this.bytes = required;
        }
  }
  private enqueue(bytes: Buffer): void {
    if (this.ended) return;
    this.options.measure?.('upstream.receipt', `wire-${++this.receiptCounter}`, performance.now(), bytes.length);
    if (this.decoding && bytes.length <= 256 * 1024) {
      try {
        const immediate = JSON.parse(bytes.toString('utf8').replace(/\r$/, ''));
        if (immediate?.type === 'response' && immediate.command !== 'get_entries') { this.record(immediate); return; }
      } catch { /* Invalid records remain in the ordered decode lane. */ }
    }
    this.records.push(bytes); this.recordBytes += bytes.length;
    if (this.recordBytes > 64 * 1024 * 1024) {
      this.records = []; this.recordBytes = 0; this.protocolError('RPC decode queue exceeded its resource limit.'); return;
    }
    void this.decode();
  }
  private async decode(): Promise<void> {
    if (this.decoding || this.ended) return;
    this.decoding = true;
    try {
      while (!this.ended && this.records.length) {
        const bytes = this.records.shift(); if (!bytes) break; this.recordBytes -= bytes.length;
        try {
          const decoded = this.decodeValue(bytes);
          const value = decoded instanceof Promise ? await decoded : decoded;
          if (this.ended) return;
          this.record(value);
        } catch { this.protocolError('Malformed RPC JSON record.'); }
      }
    } finally { this.decoding = false; }
  }
  private decodeValue(bytes: Buffer): unknown {
    if (bytes.length > 256 * 1024) return this.decodeLarge(bytes);
    const value = JSON.parse(bytes.toString('utf8').replace(/\r$/, ''));
    if (value?.type === 'response' && this.pending.get(value.id)?.beforeEntryId !== undefined) return this.decodeLarge(bytes);
    return value;
  }
  private decodeLarge(bytes: Buffer): Promise<unknown> {
    if (this.ended) return Promise.reject(new RpcError('not_ready', 'RPC decoder is closed.'));
    this.worker ??= new Worker(new URL('./decode-worker.mts', import.meta.url));
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const cleanup = () => { worker.off('message', message); worker.off('error', fail); worker.off('exit', fail); };
      const fail = () => { cleanup(); reject(new RpcError('protocol_error', 'RPC decoder failed.')); };
      const message = (result: { record?: unknown; error?: boolean }) => { cleanup(); if (result.error) reject(new RpcError('protocol_error', 'RPC decode failed.')); else resolve(result.record); };
      worker.once('message', message); worker.once('error', fail); worker.once('exit', fail); worker.postMessage({ bytes, windows: [...this.pending].filter(([, p]) => p.beforeEntryId !== undefined).map(([id, p]) => [id, p.beforeEntryId]) });
    });
  }
  private record(value: unknown): void {
    if (this.ended) return;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as RpcRecord).type !== 'string') {
      this.protocolError('Invalid RPC record shape.'); return;
    }
    const event = value as RpcRecord;
    if (event.type !== 'response') { this.options.onEvent?.(event); return; }
    const pending = typeof event.id === 'string' ? this.pending.get(event.id) : undefined;
    if (!pending) { this.protocolError('Unknown RPC response correlation ID.'); return; }
    if (event.command !== pending.type || typeof event.success !== 'boolean' || (!event.success && typeof event.error !== 'string')) {
      this.protocolError('Invalid RPC response shape.'); return;
    }
    this.pending.delete(event.id as string);
    this.timings.push({ id: event.id as string, command: pending.type, dispatch: pending.at, acknowledgment: performance.now() });
    if (this.timings.length > 128) this.timings.shift();
    this.options.measure?.('rpc.ack', event.id as string, performance.now());
    if (event.localHistoryFailure === true) pending.reject(new RpcError('history_limit', 'History anchor or source is unavailable.'));
    else if (event.success) pending.resolve(event.data);
    else pending.reject(new RpcError('rpc_rejected', 'Pi rejected the RPC command.')); 
  }
  private protocolError(message: string): void {
    if (this.ended) return;
    this.synchronized = false;
    const error = new RpcError('protocol_error', message, true);
    for (const pending of this.pending.values()) pending.reject(new RpcError(error.code, message, pending.dispatched));
    this.pending.clear(); this.options.onProtocolError?.(error);
  }
  private transportFailure(error: RpcError): void {
    if (this.ended) return;
    this.finish(error); this.synchronized = false; this.options.onProtocolError?.(error);
  }
  private processExit(error?: RpcError): void {
    if (this.processExited) return;
    this.processExited = true; this.finish(error); this.resolveExit?.(); this.options.onExit?.(error);
  }
  private finish(error?: RpcError): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(new RpcError(error?.code ?? 'delivery_uncertain', error?.message ?? 'RPC process closed.', pending.dispatched));
    this.pending.clear(); this.records = []; this.recordBytes = 0; this.accumulator = Buffer.alloc(0); this.bytes = 0;
    this.decoderClosed = this.worker?.terminate(); this.worker = undefined;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeOnce(); return this.closePromise;
  }
  private async closeOnce(): Promise<void> {
    if (!this.child || !this.exitPromise) { this.finish(); return; }
    if (this.processExited) { await this.decoderClosed; return; }
    void this.writeTail.then(() => { if (!this.processExited) this.child?.stdin.end(); })
      .catch(() => this.transportFailure(new RpcError('delivery_uncertain', 'RPC input pipe failed.', true)));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exitPromise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RpcError('handoff_blocked', 'RPC process did not exit; writer remains owned.')), this.options.shutdownTimeoutMs ?? 30_000);
      })]);
      await this.decoderClosed;
    } finally { if (timer) clearTimeout(timer); }
  }
}
