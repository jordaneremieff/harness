export type DiagnosticMetric = 'editor-echo' | 'reducer' | 'render' | 'control-roundtrip' | 'switch' | 'stream-to-render';
export type DiagnosticCode = 'none' | 'failed' | 'deferred' | 'applied' | 'offline' | 'auth' | 'overflow';
export type BrowserDiagnosticEvent = {
  event: 'measure' | 'reload' | 'connection' | 'loss'; code?: DiagnosticCode; metric?: DiagnosticMetric;
  durationMs?: number; count?: number; bytes?: number; status?: number;
};
export type DiagnosticClock = {now: () => number; set: (callback: () => void, delay: number) => unknown; clear: (handle: unknown) => void};
export type DiagnosticTiming = {measure: (name: string, options: {start: number; end: number}) => unknown; clearMeasures: (name: string) => void};
export type BrowserDiagnosticsOptions = {
  clock?: DiagnosticClock;
  timing?: DiagnosticTiming;
  /** Test seam. Returns the existing API envelope; the body is already closed-schema JSON. */
  send?: (body: string, signal: AbortSignal) => Promise<unknown>;
};
const metricNames: Record<DiagnosticMetric, string> = {
  'editor-echo': 'ui:editor-echo', reducer: 'ui:reducer', render: 'ui:schedule-to-dom-update',
  'control-roundtrip': 'ui:control-roundtrip', switch: 'ui:switch', 'stream-to-render': 'ui:stream-receive-to-dom-update',
};
const events = new Set(['measure', 'reload', 'connection', 'loss']);
const codes = new Set(['none', 'failed', 'deferred', 'applied', 'offline', 'auth', 'overflow']);
const fields = new Set(['event', 'code', 'metric', 'durationMs', 'count', 'bytes', 'status']);
const add = (a: number, b = 1): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const bounded = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => bounded(value, max) && Number.isSafeInteger(value);
const metric = (value: unknown): value is DiagnosticMetric => typeof value === 'string' && Object.hasOwn(metricNames, value);
function validField(key: string, value: unknown): boolean {
  if (value === undefined) return key !== 'event';
  switch (key) {
    case 'event': return typeof value === 'string' && events.has(value);
    case 'code': return typeof value === 'string' && codes.has(value);
    case 'metric': return metric(value);
    case 'durationMs': return bounded(value, 60_000);
    case 'count': return integer(value);
    case 'bytes': return integer(value, 16 * 1024 * 1024);
    case 'status': return integer(value, 599) && value >= 100;
    default: return false;
  }
}
function fieldDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') && validField(key, descriptor.value) ? descriptor : undefined;
}
function plainRecord(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** Reject unknown fields and accessors before serialization; never serialize the caller's object. */
function snapshot(value: unknown): BrowserDiagnosticEvent | undefined {
  if (!plainRecord(value)) return;
  const keys = Reflect.ownKeys(value);
  if (keys.length > fields.size) return;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !fields.has(key)) return;
    const descriptor = fieldDescriptor(value, key);
    if (!descriptor) return;
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  if (!Object.hasOwn(result, 'event')) return;
  if (result.event === 'measure' && (result.metric === undefined || result.durationMs === undefined)) return;
  return result as BrowserDiagnosticEvent;
}
async function post(body: string, signal: AbortSignal): Promise<unknown> {
  // Bypass instrumented transport: diagnostics must not generate more request diagnostics.
  const response = await fetch('/api/dev/diagnostics', {method: 'POST', credentials: 'same-origin', redirect: 'error', headers: {'Content-Type': 'application/json'}, body, signal});
  if (!response.ok) throw new Error('diagnostics-unavailable');
  return response.json();
}
function receipt(value: unknown, count: number): {accepted: number; dropped: number; failed: boolean} | undefined {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('data' in value)) return;
  const data = value.data;
  if (!data || typeof data !== 'object' || !('accepted' in data) || !('dropped' in data) || !('failed' in data)) return;
  if (!integer(data.accepted, count) || !integer(data.dropped, count) || data.accepted + data.dropped !== count || typeof data.failed !== 'boolean') return;
  return {accepted: data.accepted, dropped: data.dropped, failed: data.failed};
}
type Aggregate = {count: number; mean: number; due: number};
type Batch = {body: string; count: number; bytes: number; dropped: number};

/** One producer per authenticated page. Import and construction install no listeners or timers. */
export class BrowserDiagnostics {
  private readonly clock: DiagnosticClock;
  private readonly timing: DiagnosticTiming;
  private readonly send: (body: string, signal: AbortSignal) => Promise<unknown>;
  private queue: string[] = [];
  private aggregates = new Map<DiagnosticMetric, Aggregate>();
  private buffered = 0;
  private bytes = 0;
  private dropped = 0;
  private lostSamples = 0;
  private pendingLoss = 0;
  private accepted = 0;
  private serverDropped = 0;
  private unconfirmed = 0;
  private unconfirmedLoss = 0;
  private active = false;
  private hidden = false;
  private closed = false;
  private failed = false;
  private nextBatch = 0;
  private epoch = 0;
  private timer?: unknown;
  private controller?: AbortController;
  private sending?: Promise<boolean>;
  constructor(options: BrowserDiagnosticsOptions = {}) {
    this.clock = options.clock ?? {now: () => performance.now(), set: (callback, delay) => setTimeout(callback, delay), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)};
    this.timing = options.timing ?? performance;
    this.send = options.send ?? post;
  }
  /** Enable only after authentication; explicit enable also resumes after a delivery failure. */
  setActive(active: boolean): void {
    if (this.closed) return;
    this.active = active; this.epoch++;
    if (active) this.failed = false;
    else { this.cancelTimer(); this.controller?.abort(); }
    this.schedule();
  }
  /** Call from the app's existing visibility listener. No hidden-tab flushing, even via flush(). */
  setHidden(hidden: boolean): void { this.hidden = hidden; this.cancelTimer(); this.schedule(); }
  state() {
    return {queued: this.queue.length, buffered: this.buffered, bytes: this.bytes, aggregates: this.aggregates.size,
      dropped: this.dropped, pendingDropped: this.pendingLoss, lostSamples: this.lostSamples, accepted: this.accepted,
      serverDropped: this.serverDropped, unconfirmed: this.unconfirmed, unconfirmedLoss: this.unconfirmedLoss, failed: this.failed, closed: this.closed};
  }
  emit(value: BrowserDiagnosticEvent): boolean {
    if (!this.active || this.closed) return false;
    let event: BrowserDiagnosticEvent | undefined;
    try { event = snapshot(value); } catch { /* Exotic objects are not metadata. */ }
    if (!event) { this.loss(); return false; }
    // A measure is always aggregated, including calls through emit rather than measure.
    if (event.event === 'measure' && event.metric !== undefined && event.durationMs !== undefined) return this.sample(event.metric, event.durationMs, event.count ?? 1);
    return this.enqueue(event);
  }
  /** render starts at scheduling; stream-to-render starts at actual receipt. Both end after DOM update, not compositor paint. */
  measure(name: DiagnosticMetric, start: number, end: number): boolean {
    if (!this.active || this.closed) return false;
    if (!metric(name) || !bounded(start, Number.MAX_SAFE_INTEGER) || !bounded(end, Number.MAX_SAFE_INTEGER) || !bounded(end - start, 60_000)) {
      this.lostSamples = add(this.lostSamples); return false;
    }
    try { this.timing.clearMeasures(metricNames[name]); this.timing.measure(metricNames[name], {start, end}); }
    catch { /* Timing support cannot interrupt input or diagnostic aggregation. */ }
    return this.sample(name, end - start, 1);
  }
  private sample(name: DiagnosticMetric, duration: number, count: number): boolean {
    const prior = this.aggregates.get(name);
    if (!count || !integer(count) || (prior && prior.count > Number.MAX_SAFE_INTEGER - count)) {
      this.lostSamples = add(this.lostSamples, Math.max(1, count)); return false;
    }
    if (prior) { prior.count += count; prior.mean += (duration - prior.mean) * (count / prior.count); }
    else this.aggregates.set(name, {count, mean: duration, due: this.clock.now() + 5000});
    this.schedule(); return true;
  }
  private loss(count = 1): void { this.dropped = add(this.dropped, count); this.pendingLoss = add(this.pendingLoss, count); this.schedule(); }
  private enqueue(event: BrowserDiagnosticEvent): boolean {
    const encoded = JSON.stringify(event);
    // All allowed keys/values serialize to ASCII; length is therefore UTF-8 byte length.
    if (encoded.length > 1024 || this.buffered >= 64 || this.bytes + encoded.length > 65536) { this.loss(); return false; }
    this.queue.push(encoded); this.buffered++; this.bytes += encoded.length; this.schedule(); return true;
  }
  private collect(): void {
    for (const [name, value] of this.aggregates) {
      if (value.due > this.clock.now()) continue;
      this.aggregates.delete(name);
      if (!this.enqueue({event: 'measure', metric: name, durationMs: value.mean, count: value.count})) this.lostSamples = add(this.lostSamples, value.count);
    }
  }
  private cancelTimer(): void { if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined; } }
  private ready(): boolean { return this.active && !this.hidden && !this.closed && !this.failed; }
  private schedule(): void {
    if (!this.ready() || this.sending !== undefined || this.timer !== undefined) return;
    const now = this.clock.now();
    let due = this.queue.length || this.pendingLoss ? Math.max(now + 1000, this.nextBatch) : Infinity;
    for (const value of this.aggregates.values()) due = Math.min(due, Math.max(this.nextBatch, value.due));
    if (!Number.isFinite(due)) return;
    this.timer = this.clock.set(() => { this.timer = undefined; void this.flush(); }, Math.max(0, due - now));
  }
  private batch(): Batch {
    const records: string[] = []; let bytes = 0;
    while (this.queue.length && records.length < 16) {
      const next = this.queue[0]; if (next === undefined) break;
      if (`{"records":[${[...records, next].join(',')}],"dropped":${this.pendingLoss}}`.length > 16384) break;
      records.push(next); bytes += next.length; this.queue.shift();
    }
    const dropped = this.pendingLoss; this.pendingLoss = 0;
    return {body: `{"records":[${records.join(',')}],"dropped":${dropped}}`, count: records.length, bytes, dropped};
  }
  /** A rate-limited, best-effort diagnostic flush. Never await this in the input path. */
  flush(): Promise<boolean> {
    if (this.sending !== undefined) return this.sending;
    if (!this.ready()) return Promise.resolve(false);
    this.collect();
    if (this.clock.now() < this.nextBatch) { this.schedule(); return Promise.resolve(false); }
    this.cancelTimer();
    if (!this.queue.length && !this.pendingLoss) { this.schedule(); return Promise.resolve(true); }
    const batch = this.batch(); this.nextBatch = this.clock.now() + 1000;
    const controller = new AbortController(); this.controller = controller;
    this.sending = this.deliver(batch, controller, this.epoch).finally(() => {
      this.buffered -= batch.count; this.bytes -= batch.bytes;
      this.controller = undefined; this.sending = undefined; this.schedule();
    });
    return this.sending;
  }
  private async deliver(batch: Batch, controller: AbortController, epoch: number): Promise<boolean> {
    const abort = () => rejectAbort(new Error('diagnostics-unavailable'));
    let rejectAbort: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    controller.signal.addEventListener('abort', abort, {once: true});
    const timeout = this.clock.set(() => controller.abort(), 5000);
    try {
      const response = await Promise.race([stopped, Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); return this.send(batch.body, controller.signal);
      })]);
      const result = receipt(response, batch.count);
      if (!result) throw new Error('diagnostics-unavailable');
      this.accepted = add(this.accepted, result.accepted); this.serverDropped = add(this.serverDropped, result.dropped);
      if (epoch === this.epoch) this.failed = result.failed;
      return !result.failed;
    } catch {
      // Delivery may have reached the server. Never replay records or reported losses after an unknown acknowledgment.
      this.unconfirmed = add(this.unconfirmed, batch.count); this.unconfirmedLoss = add(this.unconfirmedLoss, batch.dropped);
      if (epoch === this.epoch) this.failed = true;
      return false;
    } finally { this.clock.clear(timeout); controller.signal.removeEventListener('abort', abort); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.cancelTimer(); this.controller?.abort();
    for (const value of this.aggregates.values()) this.lostSamples = add(this.lostSamples, value.count);
    this.aggregates.clear(); this.loss(this.queue.length);
    for (const encoded of this.queue) { this.buffered--; this.bytes -= encoded.length; }
    this.queue = [];
    for (const name of Object.values(metricNames)) { try { this.timing.clearMeasures(name); } catch { /* Optional instrumentation. */ } }
  }
}
