import { createHash, randomUUID } from 'node:crypto';
import {getSupportedThinkingLevels, type Api, type Model} from '@earendil-works/pi-ai';
import type { DisplayCoverage, EntryView, EventData, EventName, MessageView, PrimaryView, Target } from '../shared/api.ts';
import { projectEntry, jsonDisplay as projectJson, projectMessage, safeText, toolOutputInfo } from '../server/projection.mts';
import { RpcError, type RpcRecord } from './client.mts';

export type Publish = (name: EventName, target: Target | undefined, data: EventData[EventName]) => void;
const MAX_BYTES = 8 * 1024 * 1024;
const TEXT_BYTES = 64 * 1024;
export interface ProjectedSnapshot { projected: true; entries: EntryView[]; signatures: [string, string][]; sizes: [string, number][]; coverage: DisplayCoverage; rawMessages: [string, number][] }
export function rawMessageIdentity(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
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
  if (typeof m.reasoning !== 'boolean') throw new RpcError('protocol_error', 'Invalid model reasoning capability.');
  if (m.thinkingLevelMap !== undefined) {
    const map=object(m.thinkingLevelMap);
    if(Object.entries(map).some(([key,value])=>!['off','minimal','low','medium','high','xhigh','max'].includes(key)||value!==null&&typeof value!=='string'&&typeof value!=='number'))throw new RpcError('protocol_error','Invalid model thinking map.');
  }
  const thinkingLevels=getSupportedThinkingLevels(m as unknown as Model<Api>);
  return { provider: identifier(m.provider), id: identifier(m.id), name: typeof m.name === 'string' ? safeText(m.name, 256) : identifier(m.id),
    reasoning: m.reasoning === true, thinkingLevels, input: Array.isArray(m.input) ? m.input.filter((v): v is string => typeof v === 'string').slice(0, 16) : [] };
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
  manualCompactionEndRevision?: number;
  private retryRevision = 0;
  private retryAbortRevision?: number;
  private retryEnd?: {revision: number; success: boolean};
  silent = false;
  private ids = new Map<string, string>();
  private active?: string;
  private activeSignature?: string;
  private counts = new Map<string, number>();
  private rawMessages = new Map<string, number>();
  private endedMessages = new Map<string, string[]>();
  hasRawMessage(message: unknown, occurrence = 1): boolean {return (this.rawMessages.get(rawMessageIdentity(message)) ?? 0) >= occurrence;}
  private rememberRaw(fingerprint: string): void {this.rawMessages.set(fingerprint, (this.rawMessages.get(fingerprint) ?? 0) + 1); while (this.rawMessages.size > 8192) this.rawMessages.delete(this.rawMessages.keys().next().value as string);}
  incomplete(reason: string): void {this.coverage = {complete: false, truncated: true, omitted: this.coverage.omitted + 1, reason};}
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
  clearRetry(): void { this.retryRevision++; this.retryAbortRevision = undefined; this.retryEnd = undefined; delete this.view.retry; }
  captureRetry(): number | undefined { return this.view.retry ? this.retryRevision : undefined; }
  confirmRetryAbort(revision: number | undefined): void {
    if (revision === undefined || revision !== this.retryRevision || this.view.lifecycle !== 'ready') return;
    this.retryAbortRevision = revision;
    if (this.retryEnd?.revision === revision && !this.retryEnd.success && this.view.responseOutcome === 'failed') { this.view.responseOutcome = 'stopped'; this.state(); }
  }
  reset(): void {
    this.manualCompactionEndRevision = undefined; this.clearRetry(); delete this.view.responseOutcome;
    this.entries = []; this.messages = []; this.ids.clear(); this.counts.clear(); this.active = undefined; this.activeSignature = undefined; this.bytes = 0;
    this.sizes.clear(); this.toolArgs.clear(); this.rawMessages.clear(); this.endedMessages.clear(); this.coverage = { complete: true, truncated: false, omitted: 0 };
  }
  exportSnapshot(): ProjectedSnapshot { return { projected: true, entries: this.entries, signatures: [...this.ids], sizes: [...this.sizes], coverage: this.coverage, rawMessages: [...this.rawMessages] }; }
  private install(snapshot: ProjectedSnapshot): void {
    const incoming = new Map(snapshot.signatures.map(([signature, id]) => [id, signature]));
    this.rawMessages = new Map(snapshot.rawMessages);
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
    this.entries = []; this.messages = []; this.bytes = 0; this.sizes.clear(); this.counts.clear(); this.rawMessages.clear();
    const cutoff = beforeEntryId === undefined ? ordered.length : ordered.findIndex((entry) => entry.id === beforeEntryId);
    if (cutoff < 0) throw new RpcError('history_limit', 'History anchor is absent from the active branch.');
    for (const entry of ordered.slice(0, cutoff)) {
      if (entry.type === 'message') {
        const m = object(entry.message); const fingerprint = rawMessageIdentity(m); this.rememberRaw(fingerprint); const base = key(m); const ordinal = this.counts.get(base) ?? 0; this.counts.set(base, ordinal + 1); const signature = `${base}#${ordinal}`;
        const id = this.ids.get(signature) ?? `message:${text(entry.id)}`;
        this.ids.set(signature, id);
        const message = projectMessage(m, id, 'final', {entryId: text(entry.id), message: 0}, {communicationSource: {entryId: text(entry.id), timestamp: entry.timestamp}}); this.messages.push(message);
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
      case 'agent_start': this.clearRetry(); delete this.view.responseOutcome; this.activity('running'); return;
      case 'agent_settled': delete this.view.retry; if (event.aborted === true) this.view.responseOutcome = 'stopped'; this.activity('idle'); return;
      case 'agent_end': case 'turn_start': case 'turn_end': return;
      case 'message_start': case 'message_end': this.message(event, replaySignature); return;
      case 'message_update': this.update(object(event.assistantMessageEvent)); return;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': this.tool(event); return;
      case 'queue_update': this.queue(event); return;
      case 'entry_appended': this.entry(event); return;
      case 'session_info_changed': this.view.sessionName = event.name === undefined ? undefined : safeText(text(event.name)); this.state(); return;
      case 'thinking_level_changed': this.view.thinkingLevel = text(event.level); this.state(); return;
      case 'compaction_end':
        this.recovery(event); if (event.reason === 'manual') this.manualCompactionEndRevision = this.activityRevision; return;
      case 'compaction_start': case 'auto_retry_start': case 'auto_retry_end':
      case 'summarization_retry_scheduled': case 'summarization_retry_attempt_start': case 'summarization_retry_finished': this.recovery(event); return;
      case 'extension_error': this.emit('notice', { level: this.view.lifecycle === 'starting' ? 'warning' : 'error', message: safeText(text(event.error)), code: 'extension_error' }); return;
      default: this.emit('notice', { level: 'warning', message: 'Unsupported RPC event.', code: 'unsupported_event' });
    }
  }
  private messageId(raw: Record<string, unknown>, event: RpcRecord): string {
    if(raw.role==='toolResult')return `tool:${text(raw.toolCallId)}`;
    if(typeof event.__ownerIdentity==='string'&&Number.isSafeInteger(event.__ownerSequence))return `live:${event.__ownerIdentity}:${event.__ownerStartSequence??event.__ownerSequence}`;
    return randomUUID();
  }
  private rememberEnded(raw: Record<string, unknown>, id: string): void {
    const fingerprint=rawMessageIdentity(raw),ids=this.endedMessages.get(fingerprint)??[];
    if(!ids.includes(id))ids.push(id);this.endedMessages.set(fingerprint,ids);
    while(this.endedMessages.size>128)this.endedMessages.delete(this.endedMessages.keys().next().value as string);
  }
  private message(event: RpcRecord, replaySignature?: string): void {
        const raw = object(event.message); const base = key(raw);
        const ordinal = event.type === 'message_start' ? this.counts.get(base) ?? 0 : Math.max(0, (this.counts.get(base) ?? 1) - 1);
        const signature = replaySignature ?? (event.type === 'message_end' && this.activeSignature?.startsWith(`${base}#`) ? this.activeSignature : `${base}#${ordinal}`);
        const count = Number(signature.slice(signature.lastIndexOf('#') + 1)) + 1;
        this.counts.set(base, Math.max(this.counts.get(base) ?? 0, count)); this.lastSignature = signature;
        const id = this.ids.get(signature) ?? this.messageId(raw,event); this.ids.set(signature, id);
        const old = this.messages.find((m) => m.id === id);
        if (event.type === 'message_start') {
          this.active = id; this.activeSignature = signature; this.toolArgs.clear();
          if (old?.state === 'final') return;
        }
        if (event.type === 'message_end') this.rememberEnded(raw,id);
        const message = projectMessage(raw, id, event.type === 'message_start' ? 'partial' : 'final');
        this.save(message); this.emit('primary.message', { message });
        this.responseOutcome(event.type, message);
        if (event.type === 'message_end' && this.active === id) { this.active = undefined; this.activeSignature = undefined; this.toolArgs.clear(); }
        return;
  }
  private responseOutcome(type: string, message: MessageView): void {
    if (type !== 'message_end' || message.role !== 'assistant') return;
    this.view.responseOutcome = message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'stopped' : undefined; this.state();
  }
  private tool(event: RpcRecord): void {
        const phase = event.type === 'tool_execution_start' ? 'start' : event.type === 'tool_execution_update' ? 'update' : 'end';
        if (phase !== 'end') this.activity('running'); else this.activityRevision++;
        const result = event.result ?? event.partialResult;
        const output = result === undefined ? undefined : toolOutputInfo(text(event.toolName), object(result).details);
        if (result !== undefined) {
          const message = projectMessage({ role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, ...object(result) }, `tool:${text(event.toolCallId)}`, phase === 'end' ? 'final' : 'partial');
          this.save(message);
        }
        this.emit('primary.tool', { callId: text(event.toolCallId), name: text(event.toolName), phase,
          ...(event.args === undefined ? {} : { arguments: projectJson(event.args) }),
          ...(result === undefined ? {} : { parts: projectMessage({ ...object(result), role: 'user' }, 'tool', 'final', undefined, {structuredText: true}).parts }),
          ...(output ? {output} : {}),
          ...(typeof event.isError === 'boolean' ? { isError: event.isError } : {}),
          ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}) }); return;
  }
  private queue(event: RpcRecord): void {
        if (!Array.isArray(event.steering) || !Array.isArray(event.followUp)) throw new RpcError('protocol_error', 'Invalid queue update.');
        const steering = event.steering.map((v) => safeText(text(v))); const followUp = event.followUp.map((v) => safeText(text(v)));
        this.emit('primary.queue', { pending: steering.length + followUp.length, steering, followUp }); return;
  }
  private consumeEnded(fingerprint:string,prior:EntryView):void {
    const ids=this.endedMessages.get(fingerprint),index=ids?.indexOf(prior.messages?.[0]?.id??'')??-1;
    if(ids&&index>=0)ids.splice(index,1);if(ids&&!ids.length)this.endedMessages.delete(fingerprint);
  }
  private installCommittedMessage(entryId:string,message:MessageView):void {
    const live=this.entries.find(entry=>entry.id!==entryId&&entry.messages?.some(value=>value.id===message.id));
    if(live){this.entries=this.entries.filter(entry=>entry!==live);this.bytes-=this.sizes.get(live.id)??0;this.sizes.delete(live.id);}
    const index=this.messages.findIndex(value=>value.id===message.id);if(index<0)this.messages.push(message);else this.messages[index]=message;
    const entry:EntryView={id:entryId,kind:'message',messages:[message]};this.put(entry);this.emit('primary.entry',{entry});
  }
  private entry(event: RpcRecord): void {
    const raw = object(event.entry);
    if (raw.type === 'message') {
      const entryId = text(raw.id), messageRaw = object(raw.message), fingerprint = rawMessageIdentity(messageRaw);
      const prior = this.entries.find(entry => entry.id === entryId);
      const ids = this.endedMessages.get(fingerprint);
      if(prior){this.consumeEnded(fingerprint,prior);return;}
      const id = ids?.shift() ?? `message:${entryId}`;
      if (ids && !ids.length) this.endedMessages.delete(fingerprint);
      const message = projectMessage(messageRaw, id, 'final', {entryId, message: 0}, {communicationSource: {entryId, timestamp: raw.timestamp}});
      this.rememberRaw(fingerprint);this.installCommittedMessage(entryId,message);return;
    }
    const entry = projectEntry(raw); this.put(entry); this.emit('primary.entry', {entry});
  }
  private recovery(event: RpcRecord): void {
        const kind = event.type.startsWith('compaction') ? 'compaction' : event.type.startsWith('auto_retry') ? 'retry' : 'summarizationRetry';
        const phase = recoveryPhase(event.type);
        if (kind === 'retry') this.retry(event, phase);
        if (phase !== 'end') this.activity(kind === 'retry' ? 'retrying' : 'compacting');
        else { this.activityRevision++; this.state(); }
        this.emit('primary.recovery', { kind, phase, ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}),
          ...(typeof event.maxAttempts === 'number' ? { maxAttempts: event.maxAttempts } : {}),
          ...(typeof event.delayMs === 'number' ? { delayMs: event.delayMs } : {}),
          ...(typeof (event.errorMessage ?? event.finalError) === 'string' ? { error: safeText(String(event.errorMessage ?? event.finalError), 512) } : {}),
          ...(typeof event.success === 'boolean' ? { success: event.success } : {}) }); return;
  }
  private retry(event: RpcRecord, phase: EventData['primary.recovery']['phase']): void {
    if (phase === 'end') {
      delete this.view.retry; this.retryEnd = {revision: this.retryRevision, success: event.success === true};
      this.view.responseOutcome = event.success === true ? undefined : this.retryAbortRevision === this.retryRevision ? 'stopped' : 'failed'; return;
    }
    this.clearRetry();
    if (!Number.isSafeInteger(event.attempt) || Number(event.attempt) < 1 || !Number.isSafeInteger(event.maxAttempts) || Number(event.maxAttempts) < 1 || !Number.isSafeInteger(event.delayMs) || Number(event.delayMs) < 0) { delete this.view.retry; return; }
    this.view.retry = {attempt: Number(event.attempt), maxAttempts: Number(event.maxAttempts), delayMs: Number(event.delayMs),
      at: Math.min(8640000000000000, (typeof event.__ownerAt === 'number' ? event.__ownerAt : Date.now()) + Number(event.delayMs)), error: typeof event.errorMessage === 'string' ? safeText(event.errorMessage, 512) : ''};
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
      const bounded = projectMessage({ role: message.role, timestamp: message.timestamp, content: message.parts.map((part) => part.type === 'toolCall' ? { type: 'toolCall', id: part.callId, name: part.name, arguments: part.arguments.value } : part) }, message.id, 'partial', undefined, {trustedStructured: true});
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
