import { randomUUID } from 'node:crypto';
import type { DisplayCoverage, EntryView, EventData, EventName, MessageView, PrimaryView, Target } from '../shared/api.ts';
import { projectEntry, jsonDisplay as projectJson, projectMessage, safeText } from '../server/projection.mts';
import { RpcError, type RpcRecord } from './client.mts';

export type Publish = (name: EventName, target: Target | undefined, data: EventData[EventName]) => void;
const MAX_BYTES = 8 * 1024 * 1024;
const TEXT_BYTES = 64 * 1024;
export interface ProjectedSnapshot { projected: true; entries: EntryView[]; signatures: [string, string][]; sizes: [string, number][]; coverage: DisplayCoverage }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('protocol_error', 'Invalid RPC data object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new RpcError('protocol_error', 'Invalid RPC text field.');
  return value;
}
export function identifier(value: unknown): string { const id = text(value); if (!id || id.length > 256) throw new RpcError('protocol_error', 'Invalid RPC identifier.'); return id; }
export function model(value: unknown) {
  const m = object(value);
  return { provider: identifier(m.provider), id: identifier(m.id), name: typeof m.name === 'string' ? safeText(m.name, 256) : identifier(m.id),
    reasoning: m.reasoning === true, input: Array.isArray(m.input) ? m.input.filter((v): v is string => typeof v === 'string').slice(0, 16) : [] };
}
function recoveryPhase(type: string): EventData['primary.recovery']['phase'] {
  if (type.endsWith('scheduled')) return 'scheduled';
  if (type.endsWith('attempt_start')) return 'attempt';
  return type.endsWith('start') ? 'start' : 'end';
}
function deltaKind(kind: string): EventData['primary.delta']['kind'] {
  switch (kind) { case 'text_delta': return 'text'; case 'thinking_delta': return 'thinking'; case 'toolcall_delta': return 'toolArguments'; default: throw new RpcError('protocol_error', 'Unsupported content delta.'); }
}
function key(raw: Record<string, unknown>): string {
  return `${raw.role}:${raw.timestamp}:${raw.toolCallId ?? ''}`;
}

function activeBranch(snapshot: Record<string, unknown>): Record<string, unknown>[] {
    if (!Array.isArray(snapshot.entries) || !(snapshot.leafId === null || typeof snapshot.leafId === 'string'))
      throw new RpcError('protocol_error', 'Invalid retained-entry snapshot.');
    const raw = new Map<string, Record<string, unknown>>();
    for (const entry of snapshot.entries) { const e = object(entry); raw.set(text(e.id), e); }
    const branch: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let leaf: unknown = snapshot.leafId;
    while (typeof leaf === 'string') {
      if (seen.has(leaf) || !raw.has(leaf)) throw new RpcError('history_limit', 'Active history branch is incomplete.');
      seen.add(leaf); const entry = object(raw.get(leaf)); branch.push(entry); leaf = entry.parentId;
    }
    if (leaf !== null) throw new RpcError('protocol_error', 'Invalid retained-entry parent.');
    return branch.reverse();
}

export class EventProjection {
  entries: EntryView[] = [];
  messages: MessageView[] = [];
  coverage: DisplayCoverage = { complete: true, truncated: false, omitted: 0 };
  activityRevision = 0;
  silent = false;
  private ids = new Map<string, string>();
  private active?: string;
  private activeSignature?: string;
  private counts = new Map<string, number>();
  lastSignature?: string;
  private bytes = 0;
  private sizes = new Map<string, number>();
  private toolArgs = new Map<number, string>();
  readonly view: PrimaryView;
  private publish: Publish; private changed: () => void;
  constructor(view: PrimaryView, publish: Publish, changed: () => void) { this.view = view; this.publish = publish; this.changed = changed; }
  get target(): Extract<Target, {kind: 'primary'}> { return { kind: 'primary', key: this.view.key, epoch: this.view.epoch }; }
  emit<N extends EventName>(name: N, data: EventData[N]): void { if (!this.silent) this.publish(name, this.target, data); }
  state(): void { this.changed(); this.emit('primary.state', structuredClone(this.view)); }
  reset(): void {
    this.entries = []; this.messages = []; this.ids.clear(); this.counts.clear(); this.active = undefined; this.activeSignature = undefined; this.bytes = 0;
    this.sizes.clear(); this.toolArgs.clear(); this.coverage = { complete: true, truncated: false, omitted: 0 };
  }
  exportSnapshot(): ProjectedSnapshot { return { projected: true, entries: this.entries, signatures: [...this.ids], sizes: [...this.sizes], coverage: this.coverage }; }
  private install(snapshot: ProjectedSnapshot): void {
    const incoming = new Map(snapshot.signatures.map(([signature, id]) => [id, signature]));
    this.counts.clear();
    for (const [signature] of snapshot.signatures) { const split = signature.lastIndexOf('#'); const base = signature.slice(0, split); this.counts.set(base, Math.max(this.counts.get(base) ?? 0, Number(signature.slice(split + 1)) + 1)); }
    this.entries = snapshot.entries; this.messages = []; this.sizes = new Map(snapshot.sizes); this.bytes = 0; this.coverage = snapshot.coverage;
    for (const entry of this.entries) {
      this.bytes += this.sizes.get(entry.id) ?? 0;
      for (const message of entry.messages ?? []) {
        const signature = incoming.get(message.id);
        if (signature) { const id = this.ids.get(signature) ?? message.id; this.ids.set(signature, id); message.id = id; }
        this.messages.push(message);
      }
    }
  }
  snapshot(value: unknown, beforeEntryId?: string): void {
    const snapshot = object(value);
    if (snapshot.projected === true) { this.install(snapshot as unknown as ProjectedSnapshot); return; }
    const ordered = activeBranch(snapshot);
    this.entries = []; this.messages = []; this.bytes = 0; this.sizes.clear(); this.counts.clear();
    const cutoff = beforeEntryId === undefined ? ordered.length : ordered.findIndex((entry) => entry.id === beforeEntryId);
    if (cutoff < 0) throw new RpcError('history_limit', 'History anchor is absent from the active branch.');
    for (const entry of ordered.slice(0, cutoff)) {
      if (entry.type === 'message') {
        const m = object(entry.message); const base = key(m); const ordinal = this.counts.get(base) ?? 0; this.counts.set(base, ordinal + 1); const signature = `${base}#${ordinal}`;
        const id = this.ids.get(signature) ?? `message:${text(entry.id)}`;
        this.ids.set(signature, id);
        const message = projectMessage(m, id, 'final'); this.messages.push(message);
        this.put({ id: text(entry.id), kind: 'message', messages: [message] });
      } else this.put(projectEntry(entry, text(entry.id)));
    }
  }
  private put(entry: EntryView): void {
    const previous = this.entries.findIndex((e) => e.id === entry.id);
    if (previous !== -1) this.entries[previous] = entry; else this.entries.push(entry);
    this.bytes -= this.sizes.get(entry.id) ?? 0;
    const size = Buffer.byteLength(JSON.stringify(entry)); this.sizes.set(entry.id, size); this.bytes += size;
    while ((this.bytes > MAX_BYTES || this.entries.length > 8192) && this.entries.length > 1) {
      this.evict();
    }
  }
  private evict(): void {
      const removed = this.entries.shift(); if (!removed) return; this.bytes -= this.sizes.get(removed.id) ?? 0; this.sizes.delete(removed.id);
      for (const m of removed.messages ?? []) {
        this.messages = this.messages.filter((v) => v.id !== m.id);
        for (const [signature, id] of this.ids) if (id === m.id) this.ids.delete(signature);
      }
      this.coverage = { complete: false, truncated: true, omitted: this.coverage.omitted + 1, reason: 'projection-limit' };
  }
  prune(): void { this.trimIds(); }
  private trimIds(): void {
    const visible = new Set(this.messages.map((m) => m.id));
    for (const [signature, id] of this.ids) if (!visible.has(id) && id !== this.active) this.ids.delete(signature);
    const bases = new Set([...this.ids.keys()].map((signature) => signature.slice(0, signature.lastIndexOf('#'))));
    for (const base of this.counts.keys()) if (!bases.has(base)) this.counts.delete(base);
  }
  private save(message: MessageView): void {
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index !== -1) this.messages[index] = message; else this.messages.push(message);
    const retained = this.entries.find((e) => e.messages?.some((m) => m.id === message.id));
    this.put({ id: retained?.id ?? `live:${message.id}`, kind: 'message', messages: [message] });
  }
  reduce(event: RpcRecord, replaySignature?: string): void {
    this.lastSignature = undefined;
    switch (event.type) {
      case 'agent_start': this.activity('running'); return;
      case 'agent_settled': this.activity('idle'); return;
      case 'agent_end': case 'turn_start': case 'turn_end': return;
      case 'message_start': case 'message_end': this.message(event, replaySignature); return;
      case 'message_update': this.update(object(event.assistantMessageEvent)); return;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': this.tool(event); return;
      case 'queue_update': this.queue(event); return;
      case 'entry_appended': this.entry(event); return;
      case 'session_info_changed': this.view.sessionName = event.name === undefined ? undefined : safeText(text(event.name)); this.state(); return;
      case 'thinking_level_changed': this.view.thinkingLevel = text(event.level); this.state(); return;
      case 'compaction_start': case 'compaction_end': case 'auto_retry_start': case 'auto_retry_end':
      case 'summarization_retry_scheduled': case 'summarization_retry_attempt_start': case 'summarization_retry_finished': this.recovery(event); return;
      case 'extension_error': this.emit('notice', { level: this.view.lifecycle === 'starting' ? 'warning' : 'error', message: safeText(text(event.error)), code: 'extension_error' }); return;
      default: this.emit('notice', { level: 'warning', message: 'Unsupported RPC event.', code: 'unsupported_event' });
    }
  }
  private message(event: RpcRecord, replaySignature?: string): void {
        const raw = object(event.message); const base = key(raw);
        const ordinal = event.type === 'message_start' ? this.counts.get(base) ?? 0 : Math.max(0, (this.counts.get(base) ?? 1) - 1);
        const signature = replaySignature ?? (event.type === 'message_end' && this.activeSignature?.startsWith(`${base}#`) ? this.activeSignature : `${base}#${ordinal}`);
        const count = Number(signature.slice(signature.lastIndexOf('#') + 1)) + 1;
        this.counts.set(base, Math.max(this.counts.get(base) ?? 0, count)); this.lastSignature = signature;
        const id = this.ids.get(signature) ?? (raw.role === 'toolResult' ? `tool:${text(raw.toolCallId)}` : randomUUID()); this.ids.set(signature, id);
        const old = this.messages.find((m) => m.id === id);
        if (event.type === 'message_start') {
          this.active = id; this.activeSignature = signature; this.toolArgs.clear();
          if (old?.state === 'final') return;
        }
        const message = projectMessage(raw, id, event.type === 'message_start' ? 'partial' : 'final');
        this.save(message); this.emit('primary.message', { message });
        if (event.type === 'message_end' && this.active === id) { this.active = undefined; this.activeSignature = undefined; this.toolArgs.clear(); }
        return;
  }
  private tool(event: RpcRecord): void {
        const phase = event.type === 'tool_execution_start' ? 'start' : event.type === 'tool_execution_update' ? 'update' : 'end';
        const result = event.result ?? event.partialResult;
        if (result !== undefined) {
          const message = projectMessage({ role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, ...object(result) }, `tool:${text(event.toolCallId)}`, phase === 'end' ? 'final' : 'partial');
          this.save(message);
        }
        this.emit('primary.tool', { callId: text(event.toolCallId), name: text(event.toolName), phase,
          ...(event.args === undefined ? {} : { arguments: projectJson(event.args) }),
          ...(result === undefined ? {} : { parts: projectMessage({ ...object(result), role: 'user' }, 'tool', 'final').parts }),
          ...(typeof event.isError === 'boolean' ? { isError: event.isError } : {}),
          ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}) }); return;
  }
  private queue(event: RpcRecord): void {
        if (!Array.isArray(event.steering) || !Array.isArray(event.followUp)) throw new RpcError('protocol_error', 'Invalid queue update.');
        const steering = event.steering.map((v) => safeText(text(v))); const followUp = event.followUp.map((v) => safeText(text(v)));
        this.emit('primary.queue', { pending: steering.length + followUp.length, steering, followUp }); return;
  }
  private entry(event: RpcRecord): void {
        const entry = projectEntry(event.entry); this.put(entry); this.emit('primary.entry', { entry }); return;
  }
  private recovery(event: RpcRecord): void {
        const kind = event.type.startsWith('compaction') ? 'compaction' : event.type.startsWith('auto_retry') ? 'retry' : 'summarizationRetry';
        const phase = recoveryPhase(event.type);
        if (phase !== 'end') this.activity(kind === 'retry' ? 'retrying' : 'compacting');
        this.emit('primary.recovery', { kind, phase, ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
          ...(typeof event.maxAttempts === 'number' ? { maxAttempts: event.maxAttempts } : {}),
          ...(typeof event.delayMs === 'number' ? { delayMs: event.delayMs } : {}),
          ...(typeof (event.errorMessage ?? event.finalError) === 'string' ? { error: safeText(String(event.errorMessage ?? event.finalError)) } : {}),
          ...(typeof event.success === 'boolean' ? { success: event.success } : {}) }); return;
  }
  private activity(activity: PrimaryView['activity']): void { this.activityRevision++; this.view.activity = activity; this.state(); }
  private update(update: Record<string, unknown>): void {
    const message = this.messages.find((m) => m.id === this.active);
    if (!message) throw new RpcError('protocol_error', 'Streaming update has no active message.');
    if (message.state === 'final') return;
    const kind = text(update.type);
    if (['start', 'done', 'error'].includes(kind)) return;
    const index = update.contentIndex;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= 100) throw new RpcError('protocol_error', 'Invalid message content index.');
    const i = index as number;
    while (message.parts.length <= i) message.parts.push({ type: 'omitted', label: 'Pending content' });
    this.content(message, i, kind, update);
    if (Buffer.byteLength(JSON.stringify(message)) > 60 * 1024) {
      const bounded = projectMessage({ role: message.role, timestamp: message.timestamp, content: message.parts.map((part) => part.type === 'toolCall' ? { type: 'toolCall', id: part.callId, name: part.name, arguments: part.arguments.value } : part) }, message.id, 'partial');
      message.parts = bounded.parts; message.coverage = { complete: false, truncated: true, omitted: message.coverage.omitted + bounded.coverage.omitted, reason: 'message-limit' };
    }
    this.save(message);
    if (!kind.endsWith('_delta') || message.coverage.truncated) this.emit('primary.message', { message: structuredClone(message) });
  }
  private content(message: MessageView, i: number, kind: string, update: Record<string, unknown>): void {
    switch (kind) {
      case 'toolcall_start': message.parts[i] = { type: 'toolCall', callId: text(update.id), name: text(update.toolName), arguments: projectJson({}) }; return;
      case 'toolcall_end': message.parts[i] = projectMessage({role: 'assistant', content: [update.toolCall]}, 'block').parts[0] ?? {type: 'omitted', label: 'Tool call omitted'}; return;
      case 'text_start': case 'thinking_start': message.parts[i] = {type: kind === 'text_start' ? 'text' : 'thinking', text: ''}; return;
      case 'text_end': case 'thinking_end': { const part = message.parts[i]; if (part?.type === 'text' || part?.type === 'thinking') part.text = safeText(text(update.content)); return; }
      case 'text_delta': case 'thinking_delta': case 'toolcall_delta': this.delta(message, i, update); return;
      default: throw new RpcError('protocol_error', 'Unsupported content update.');
    }
  }
  private delta(message: MessageView, i: number, update: Record<string, unknown>): void {
      const kind = text(update.type);
      const delta = text(update.delta); const part = message.parts[i];
      const type = deltaKind(kind);
      const old = type === 'toolArguments' ? this.toolArgs.get(i) ?? '' : part && (part.type === 'text' || part.type === 'thinking') ? part.text : '';
      const otherArgumentBytes = type === 'toolArguments' ? [...this.toolArgs].reduce((sum, [index, value]) => sum + (index === i ? 0 : Buffer.byteLength(value)), 0) : 0;
      const full = safeText(old + delta, Math.max(256, TEXT_BYTES - otherArgumentBytes));
      const truncated = Buffer.byteLength(old + delta) > TEXT_BYTES;
      const visibleDelta = full.startsWith(old) ? full.slice(old.length) : '';
      if (type === 'toolArguments') this.toolArgs.set(i, full);
      else message.parts[i] = { type, text: full };
      if (truncated) message.coverage = { complete: false, truncated: true, omitted: message.coverage.omitted + Buffer.byteLength(delta), reason: 'text-limit' };
      this.emitDelta(message, i, type, visibleDelta);

  }
  private emitDelta(message: MessageView, index: number, kind: EventData['primary.delta']['kind'], delta: string): void {
    const part = message.parts[index];
    const metadata = part?.type === 'toolCall' ? {callId: part.callId, toolName: part.name} : {};
    let slice = '';
    for (const character of delta) { slice += character; if (slice.length >= 8192) { this.emit('primary.delta', {messageId: message.id, index, kind, delta: slice, ...metadata}); slice = ''; } }
    if (slice) this.emit('primary.delta', {messageId: message.id, index, kind, delta: slice, ...metadata});
  }

}
