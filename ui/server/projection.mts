import { randomUUID } from 'node:crypto';
import type { CatalogRow } from '../agents/index.mts';
import {taskSenderHints} from '../agents/contract.mts';
import type { AgentRow, CachedRoster, DisplayCoverage, EntryView, ImageSource, JsonDisplay, MessageView, PartView, ProjectedFrame, ToolOutputInfo, GenerationRetry, ProviderBlock } from '../shared/api.ts';
import { imagePart, imageSource } from './images.mts';
import { projectCommunication, type CommunicationSource } from './communication.mts';

const TEXT_BYTES = 64 * 1024;
const DISPLAY_BYTES = 60 * 1024;
const OMITTED = '[omitted]';
const hiddenKey = /^(?:.*signature|api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|credentials?|cookie|set-cookie|image|image[_-]?data|base64|environment|env)$/i;
const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

export function safeText(value: unknown, maxBytes = TEXT_BYTES): string {
  maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : TEXT_BYTES;
  const source = typeof value === 'string' ? value : '';
  const clean = source.replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted credential]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@');
  if (Buffer.byteLength(clean) <= maxBytes) return clean;
  if (maxBytes < 12) return '[truncated]'.slice(0, maxBytes);
  const bytes = Buffer.from(clean); let end = Math.max(0, maxBytes - 12);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}\n[truncated]`;
}
/** Structured preview coverage reports cuts without adding text to the retained prefix. */
function projectedText(value: string, maxBytes: number): string {
  const clean = safeText(value, Number.MAX_SAFE_INTEGER);
  const cap = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(clean) <= cap) return clean;
  if (cap < 3) return '';
  const bytes = Buffer.from(clean); let end = cap - 3;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function coverage(truncated = false, omitted = 0): DisplayCoverage {
  return {complete: !truncated, truncated, omitted, ...(truncated ? {reason: 'Display limits or protected content'} : {})};
}
const STRUCTURED_INPUT_BYTES = 128 * 1024;
const STRUCTURED_OUTPUT_BYTES = 16 * 1024;
type StructuredBudget = {input: number; output: number; nodes: number; scan?: number};
/** Trust is selected by an internal caller, never by a field in a native result. */
type ProjectionOptions = {displayBytes?: number; trustedStructured?: boolean; structuredText?: boolean; retainedText?: ReadonlyMap<number, string>; budget?: StructuredBudget; deferred?: (() => void)[]; communicationSource?: CommunicationSource};
function structuredBudget(): StructuredBudget { return {input: STRUCTURED_INPUT_BYTES, output: STRUCTURED_OUTPUT_BYTES, nodes: 0}; }
function structuredPriority(key: string, value: unknown): number {
  const name = safeText(key, 256).replace(/[_\s-]/g, '').toLowerCase();
  if (/^(?:metadata|meta|coverage|limits|pagination|cursor|nextcursor|usage|tokens?|cost|duration|elapsed|provenance|transport|headers?|source|requestid|entryid|identity|model|timestamp|id|query|queries|scans?|counters?|stats|statistics|consistency|representation|offsets?|start|end|excerptstart|excerptend|field)$/.test(name)) return 2;
  if (/^(?:body|content|text|documents?|data|records?|results?|items|entries|rows|value|errors?)$/.test(name)) return 0;
  return value !== null && typeof value === 'object' || typeof value === 'string' && (value.includes('\n') || value.length > 160) ? 0 : 1;
}
function structuredValuePriority(value: unknown): number {
  if (Array.isArray(value)) return 0;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record).reduce((priority, key) => Math.min(priority, structuredPriority(key, record[key])), 2);
  }
  return structuredPriority('', value);
}
function jsonCandidate(text: string, nested = false): boolean {
  const trimmed = text.trimStart(), first = trimmed[0];
  if (nested) return first !== undefined && '{["'.includes(first);
  return first !== undefined && '{["-0123456789'.includes(first) || /^(?:true|false|null)\s*$/.test(trimmed);
}
function decodeStructured(text: string, budget: StructuredBudget, nested = false): {value: unknown} | {blocked: true} | undefined {
  if (!jsonCandidate(text, nested)) return undefined;
  const bytes = Buffer.byteLength(text);
  if (bytes > budget.input) return {blocked: true};
  budget.input -= bytes;
  try { return {value: JSON.parse(text)}; } catch { return undefined; }
}
function decodeRetained(text: string, budget: StructuredBudget): {value: unknown} | undefined {
  const bytes = Buffer.byteLength(text); budget.scan ??= STRUCTURED_INPUT_BYTES;
  if (bytes > budget.scan || bytes > budget.input) return undefined;
  budget.scan -= bytes;
  const whole = decodeStructured(text, budget);
  if (whole) return 'value' in whole ? whole : undefined;
  const lines = text.split('\n'); if (lines.length > 512) return undefined;
  const values: unknown[] = [], prose: string[] = []; let roots = 0;
  const flush = () => { if (prose.length) { values.push(prose.join('\n')); prose.length = 0; } };
  for (const line of lines) {
    const decoded = decodeStructured(line, budget, true);
    if (decoded && 'blocked' in decoded) return undefined;
    if (!decoded) { prose.push(line); continue; }
    if (++roots > 128) return undefined;
    flush(); values.push(decoded.value);
  }
  flush(); return roots ? {value: values} : undefined;
}
class JsonProjector {
  private nodes = 0;
  private readonly seen = new Set<object>();
  truncated = false;
  private remaining: number;
  private readonly structured?: StructuredBudget;
  constructor(bytes: number, structured?: StructuredBudget) { this.remaining = bytes; this.structured = structured; }
  private omit(): string { this.truncated = true; this.remaining -= sizeOf(OMITTED); return OMITTED; }
  private unavailable(depth: number): boolean {
    if (this.nodes >= 2048 || depth > 8 || this.remaining < 32 || this.structured && this.structured.nodes >= 2048) return true;
    this.nodes++; if (this.structured) this.structured.nodes++; return false;
  }
  private string(value: string, depth: number): unknown {
    const decoded = this.structured ? decodeStructured(value, this.structured, true) : undefined;
    if (decoded && 'blocked' in decoded) return this.omit();
    return decoded ? this.visit(decoded.value, depth + 1) : this.text(value);
  }
  visit(value: unknown, depth = 0): unknown {
    if (this.unavailable(depth)) return this.omit();
    if (value === null || typeof value === 'boolean') { this.remaining -= 8; return value; }
    if (typeof value === 'number') { this.remaining -= 32; return Number.isFinite(value) ? value : null; }
    if (typeof value === 'string') return this.string(value, depth);
    if (typeof value !== 'object' || this.seen.has(value)) return this.omit();
    this.seen.add(value);
    return Array.isArray(value) ? this.array(value, depth) : this.record(value as Record<string, unknown>, depth);
  }
  private text(value: string): string {
    let text = projectedText(value, Math.min(TEXT_BYTES, this.remaining - 32));
    if (sizeOf(text) > this.remaining) text = projectedText(text, Math.floor((this.remaining - 32) / 6));
    this.truncated ||= text !== value; this.remaining -= sizeOf(text); return text;
  }
  private array(value: unknown[], depth: number): unknown[] {
    const result: unknown[] = [];
    for (const item of value) {
      if (this.nodes >= 2048 || this.structured && this.structured.nodes >= 2048 || this.remaining < 32) { result.push(this.omit()); break; }
      this.remaining -= 2; result.push(this.visit(item, depth + 1));
    }
    return result;
  }
  private record(value: Record<string, unknown>, depth: number): Record<string, unknown> {
    const label = value.type === 'image' ? 'Image data omitted from structured display'
      : (value.type === 'text' || value.type === 'thinking') && value.redacted === true ? 'Redacted content omitted from structured display' : undefined;
    if (label) { const omitted = {type: 'omitted', label}; this.truncated = true; this.remaining -= sizeOf(omitted); return omitted; }
    const result: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(value);
    if (this.structured) keys.sort((a, b) => structuredPriority(a, value[a]) - structuredPriority(b, value[b]));
    for (const key of keys) {
      if (this.nodes >= 2048 || this.structured && this.structured.nodes >= 2048 || this.remaining < 512) { result['[omitted fields]'] = this.omit(); break; }
      const displayKey = projectedText(key, 256); this.truncated ||= displayKey !== key; this.remaining -= sizeOf(displayKey) + 4;
      result[displayKey] = hiddenKey.test(key) || hiddenKey.test(displayKey) ? this.omit() : this.visit(value[key], depth + 1);
    }
    return result;
  }
}
export function jsonDisplay(raw: unknown, maxBytes = DISPLAY_BYTES, structured?: StructuredBudget): JsonDisplay {
  try {
    const projector = new JsonProjector(maxBytes, structured); const value = projector.visit(raw); const bytes = sizeOf(value);
    if (bytes > maxBytes) return {value: '[display byte limit; content omitted]', truncated: true, omittedBytes: bytes};
    return {value, truncated: projector.truncated};
  } catch { return {value: '[malformed display content omitted]', truncated: true}; }
}
export const projectJson = jsonDisplay;
function displayData(raw: unknown, bound = DISPLAY_BYTES): JsonDisplay {
  const data = object(raw), projected = jsonDisplay('value' in data && typeof data.truncated === 'boolean' ? data.value : raw, bound);
  projected.truncated ||= data.truncated === true; return projected;
}
function outputTruncation(raw: unknown): ToolOutputInfo['truncation'] {
  const supplied = object(raw); if (supplied.truncated !== true) return undefined;
  const result: NonNullable<ToolOutputInfo['truncation']> = {truncated: true};
  if (supplied.truncatedBy === 'lines' || supplied.truncatedBy === 'bytes') result.truncatedBy = supplied.truncatedBy;
  for (const field of ['totalLines', 'outputLines', 'totalBytes', 'outputBytes', 'maxLines', 'maxBytes'] as const) {
    if (tokenCount(supplied[field])) result[field] = supplied[field];
  }
  if (supplied.lastLinePartial === true) result.lastLinePartial = true;
  if (supplied.firstLineExceedsLimit === true) result.firstLineExceedsLimit = true;
  return result;
}
/** Only public read/bash output facts cross this boundary, never details content or file access. */
export function toolOutputInfo(name: string, raw: unknown): ToolOutputInfo | undefined {
  if (name !== 'bash' && name !== 'read') return undefined;
  const source = object(raw); const result: ToolOutputInfo = {};
  const truncation = outputTruncation(source.truncation); if (truncation) result.truncation = truncation;
  if (name === 'bash' && typeof source.fullOutputPath === 'string') {
    const path = safeText(source.fullOutputPath.slice(0, 2048), 1024).trim();
    if (path) result.fullOutputPath = path;
  }
  return result.truncation || result.fullOutputPath ? result : undefined;
}
function messageContent(source: Record<string, unknown>): unknown[] {
  if (typeof source.content === 'string') return [{type: 'text', text: source.content}];
  if (Array.isArray(source.content)) return source.content;
  return Array.isArray(source.parts) ? source.parts : [];
}
class MessageProjector {
  private remaining = DISPLAY_BYTES - 2048;
  private omitted = 0;
  private changed = false;
  constructor(privateDepth = 0, source?: Pick<ImageSource, 'entryId' | 'message'>, options: ProjectionOptions = {}) {
    this.depth = privateDepth; this.source = source; this.options = options; this.budget = options.budget ?? structuredBudget();
    if (options.displayBytes !== undefined) this.remaining = Math.max(256, Math.min(this.remaining, options.displayBytes));
  }
  private readonly depth: number;
  private readonly source?: Pick<ImageSource, 'entryId' | 'message'>;
  private readonly options: ProjectionOptions;
  private readonly budget: StructuredBudget;
  private structuredText = false;
  private readonly sidecars: {part: Extract<PartView, {type: 'text'}>; value: unknown; truncated: boolean}[] = [];
  private part(raw: unknown, index: number): PartView {
    const part = object(raw);
    if (part.type === 'text' || part.type === 'thinking') return this.textPart(part, index);
    if (part.type === 'image') {
      const projected = imagePart(part);
      if (projected.type === 'omitted') this.omitted++;
      if (projected.type === 'image' && !projected.source && this.source && index < 100) projected.source = imageSource({...this.source, part: index});
      return projected;
    }
    if (part.type === 'toolCall') return this.toolCall(part);
    if (part.type === 'toolResult' && this.depth < 8) {
      const nested = new MessageProjector(this.depth + 1, undefined, {trustedStructured: this.options.trustedStructured, budget: this.budget, deferred: this.options.deferred}).message({role: 'toolResult', content: part.parts, toolCallId: part.callId, toolName: part.name, isError: part.isError, details: part.output}, 'nested', 'final');
      this.changed ||= nested.coverage.truncated; return nested.parts[0] ?? {type: 'omitted', label: 'Tool result omitted'};
    }
    if (part.type === 'omitted') { this.changed = true; return {type: 'omitted', label: safeText(part.label, 256)}; }
    this.omitted++;
    return {type: 'omitted', label: 'Unsupported content omitted'};
  }
  private toolCall(part:Record<string,unknown>):PartView {
    const args=displayData(part.arguments,Math.max(128,Math.floor(this.remaining/2)));this.changed ||= args.truncated;
    return{type:'toolCall',callId:safeText(part.id??part.callId,256),name:safeText(part.name,256),arguments:args,...(typeof part.argumentsError==='string'?{argumentsError:safeText(part.argumentsError,4096)}:{})};
  }
  private textPart(part: Record<string, unknown>, index: number): PartView {
    const text = part.type === 'text' ? part.text : part.thinking ?? part.text;
    const display = part.redacted === true ? '[redacted thinking]' : safeText(text, Math.min(TEXT_BYTES, this.remaining - 128));
    this.changed ||= display !== text;
    const result: PartView = {type: part.type === 'text' ? 'text' : 'thinking', text: display, ...(part.redacted === true ? {redacted: true} : {})};
    if (result.type === 'text' && part.redacted !== true && this.structuredText) this.structuredPart(part, result, index);
    if (this.options.trustedStructured && part.redacted !== true && display === text) this.continuation(part, result);
    return result;
  }
  private continuation(part: Record<string, unknown>, result: PartView): void {
    const more = object(part.more);
    if ((result.type !== 'text' && result.type !== 'thinking') || typeof more.entryId !== 'string' || more.entryId.length > 256 || !Number.isSafeInteger(more.part) || Number(more.part) < 0 || Number(more.part) >= 100 || !Number.isSafeInteger(more.offset) || Number(more.offset) < 0) return;
    result.more = {entryId: safeText(more.entryId, 256), part: Number(more.part), offset: Number(more.offset)};
  }
  private structuredPart(raw: Record<string, unknown>, part: Extract<PartView, {type: 'text'}>, index: number): void {
    const prior = object(raw.structured);
    if (this.options.trustedStructured) {
      if (typeof prior.truncated === 'boolean' && Object.hasOwn(prior, 'value')) this.sidecars.push({part, value: prior.value, truncated: prior.truncated});
      return;
    }
    const text = this.options.retainedText?.get(index) ?? raw.text;
    if (typeof text !== 'string') return;
    const decoded = decodeRetained(text, this.budget);
    if (decoded) this.sidecars.push({part, value: decoded.value, truncated: false});
  }
  private attachStructured(parts: PartView[]): void {
    const candidates = this.sidecars.filter(item => parts.includes(item.part));
    candidates.sort((a, b) => structuredValuePriority(a.value) - structuredValuePriority(b.value));
    for (const candidate of candidates) {
      const allowance = Math.min(this.remaining, this.budget.output) - 64;
      if (allowance < 256) break;
      const structured = jsonDisplay(candidate.value, allowance, this.budget);
      structured.truncated ||= candidate.truncated;
      const cost = sizeOf({...candidate.part, structured}) - sizeOf(candidate.part);
      if (cost > this.remaining || cost > this.budget.output) continue;
      candidate.part.structured = structured; this.remaining -= cost; this.budget.output -= cost;
      this.changed ||= structured.truncated;
    }
  }
  private parts(source: Record<string, unknown>): PartView[] {
    const content = messageContent(source); const parts: PartView[] = [];
    const limit = Array.isArray(source.parts) ? 101 : 100;
    this.omitted += Math.max(0, content.length - limit);
    for (const [index, item] of content.slice(0, limit).entries()) {
      if (this.remaining < 256 && object(item).type !== 'omitted') { this.omitted++; continue; }
      const projected = this.part(item, index); let bytes = sizeOf(projected);
      if (bytes > this.remaining && (projected.type === 'text' || projected.type === 'thinking')) {
        projected.text = safeText(projected.text, Math.max(64, Math.floor((this.remaining - 128) / 6))); bytes = sizeOf(projected); this.changed = true;
      }
      if (bytes > this.remaining) { this.omitted++; continue; }
      this.remaining -= bytes; parts.push(projected);
    }
    return parts;
  }
  private communication(source: Record<string, unknown>, id: string): MessageView['communication'] {
    const value = projectCommunication(source, id, this.options.communicationSource ?? {}, {safeText, jsonDisplay});
    if (value) this.remaining -= sizeOf(value);
    return value;
  }
  message(raw: unknown, id: string, state: 'partial' | 'final'): MessageView {
    const source = object(raw);
    this.structuredText = this.acceptsStructured(source);
    const hidden = source.role === 'custom' && source.display === false;
    const communication = this.communication(source, id);
    const parts = hidden ? [] : this.parts(source);
    const contentParts = [...parts];
    if (typeof source.role !== 'string') this.omitted++;
    if (source.role === 'toolResult' && !parts.some(part => part.type === 'toolResult')) {
      const result: Extract<PartView, {type: 'toolResult'}> = {type: 'toolResult', callId: safeText(source.toolCallId, 256), name: safeText(source.toolName, 256), parts: [...parts], isError: source.isError === true};
      const output = toolOutputInfo(result.name, source.details); if (output) result.output = output;
      parts.splice(0, parts.length, result);
    }
    if (this.omitted) parts.push({type: 'omitted', label: `${this.omitted} content parts omitted`});
    const prior = object(source.coverage);
    const omitted = this.omitted + (Number.isSafeInteger(prior.omitted) && Number(prior.omitted) >= 0 ? Number(prior.omitted) : 0);
    const result: MessageView = {id: safeText(id, 256), role: safeText(source.role, 256) || 'unknown', parts, state, coverage: coverage(this.changed || omitted > 0 || prior.truncated === true, omitted)};
    if (prior.complete === false) result.coverage.complete = false;
    if (this.omitted === 0 && typeof prior.reason === 'string') result.coverage.reason = safeText(prior.reason, 256);
    messageDetails(source, result, communication);
    this.structuredResult(contentParts, result);
    return result;
  }
  private acceptsStructured(source: Record<string, unknown>): boolean {
    return this.options.trustedStructured === true || (source.role === 'toolResult' || this.options.structuredText === true) && object(source.coverage).truncated !== true;
  }
  private structuredResult(parts: PartView[], result: MessageView): void {
    const attach = () => {
      this.attachStructured(parts);
      if (structuredCut(parts)) { result.coverage.complete = false; result.coverage.truncated = true; result.coverage.reason ??= 'Display limits or protected content'; }
    };
    if (this.options.deferred) this.options.deferred.push(attach); else attach();
  }
}
function structuredCut(parts: PartView[]): boolean {
  return parts.some(part => part.type === 'text' && part.structured?.truncated || part.type === 'toolResult' && structuredCut(part.parts));
}
function tokenCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function assistantUsage(raw: unknown): MessageView['usage'] {
  const usage = object(raw); const {input, cacheRead, cacheWrite} = usage;
  return tokenCount(input) && tokenCount(cacheRead) && tokenCount(cacheWrite) ? {input, cacheRead, cacheWrite} : undefined;
}
function messageDetails(source: Record<string, unknown>, result: MessageView, communication?: MessageView['communication']): void {
  if (communication) result.communication = communication;
  if (result.role === 'assistant') { const usage = assistantUsage(source.usage); if (usage) result.usage = usage; }
  if (typeof source.timestamp === 'number' && Number.isFinite(source.timestamp)) result.timestamp = source.timestamp;
  if (typeof source.stopReason === 'string') result.stopReason = safeText(source.stopReason, 256);
  if (typeof (source.errorMessage ?? source.error) === 'string') result.error = safeText(source.errorMessage ?? source.error, 1024);
}
export function projectMessage(raw: unknown, id: string, state: 'partial' | 'final' = 'final', source?: Pick<ImageSource, 'entryId' | 'message'>, options: ProjectionOptions = {}): MessageView {
  try { return new MessageProjector(0, source, options).message(raw, id, state); }
  catch { return {id: safeText(id, 256), role: 'unknown', state, parts: [{type: 'omitted', label: 'Malformed message omitted'}], coverage: coverage(true, 1)}; }
}
function entryMessages(source: Record<string, unknown>): unknown[] | undefined {
  if (source.type === 'custom_message') return [{role: 'custom', customType: source.customType, details: source.details, content: source.content, display: source.display, timestamp: source.timestamp}];
  if (source.message !== undefined) return [source.message];
  if (Array.isArray(source.messages)) return source.messages;
  if (Array.isArray(source.model)) return source.model;
  if (typeof source.role === 'string') return [source];
  return undefined;
}
function entryHeading(source: Record<string, unknown>, kind: string): string | undefined {
  if ((kind === 'custom' || kind === 'custom_message') && typeof source.customType === 'string') return safeText(source.customType, 256);
  return typeof source.head === 'string' ? safeText(source.head, 256) : undefined;
}
function entryImageSource(id: string, message: number, raw: unknown): Pick<ImageSource, 'entryId' | 'message'> | undefined {
  const entry = object(raw);
  if ((typeof entry.id !== 'string' && typeof entry.id !== 'number') || String(entry.id) !== id || id.startsWith('live:')) return undefined;
  try { const source = imageSource({entryId: id, message, part: 0}); return {entryId: source.entryId, message: source.message}; }
  catch { return undefined; }
}
function nestedToolIdentity(source: Record<string, unknown>): boolean {
  return typeof source.callId === 'string' && typeof source.name === 'string' && typeof source.parentCallId === 'string' &&
    Number.isSafeInteger(source.taskId) && Number(source.taskId) > 0 && Number.isSafeInteger(source.parentTaskId) && Number(source.parentTaskId) > 0 &&
    ['pending', 'running', 'done'].includes(String(source.status));
}
function nestedToolContent(source: Record<string, unknown>, summary: Record<string, unknown>, projected: boolean): {content: unknown[]; truncated: boolean} {
  const content: unknown[] = projected && Array.isArray(source.parts) ? [...source.parts] : [];
  let textTruncated = false;
  const boundedText = (value: string, bytes: number): string => {
    const text = safeText(value, bytes); textTruncated ||= text !== value; return text;
  };
  if (!projected && typeof source.output === 'string') content.push({type: 'text', text: source.output});
  if (Array.isArray(source.diagnostics)) for (const raw of source.diagnostics.slice(0, 16)) {
    const d = object(raw); if (typeof d.message === 'string') content.push({type: 'text', text: `[${safeText(d.severity, 16)}] ${boundedText(d.message, 1024)}`});
  }
  if (typeof summary.error === 'string') content.push({type: 'text', text: boundedText(summary.error, 1024)});
  return {content, truncated: textTruncated || Array.isArray(source.diagnostics) && source.diagnostics.length > 16};
}
function nestedToolSummary(tool: NonNullable<EntryView['tool']>, summary: Record<string, unknown>): void {
  if (typeof summary.isError === 'boolean') tool.isError = summary.isError;
  if (typeof summary.durationMs === 'number' && Number.isFinite(summary.durationMs) && summary.durationMs >= 0) tool.durationMs = summary.durationMs;
}
/** A nested slot supplies execution facts, not a model message or a start timestamp. */
function nestedToolView(raw: unknown, projected = false): EntryView['tool'] {
  const source = object(raw); if (!nestedToolIdentity(source)) return undefined;
  const args = projected ? displayData(source.arguments, 8192) : jsonDisplay(source.arguments, 8192), summary = projected ? source : object(source.summary);
  const {content, truncated} = nestedToolContent(source, summary, projected);
  const display = projectMessage({role: 'toolResult', toolCallId: source.callId, toolName: source.name, content,
    details: projected ? source.output : source.details, ...(projected ? {coverage: source.coverage} : {})}, 'nested-output', 'final', undefined,
    {displayBytes: 40 * 1024, trustedStructured: projected});
  const result = display.parts[0], dropped = [source.droppedBytes, source.droppedLines].some(value => Number(value) > 0);
  const tool: NonNullable<EntryView['tool']> = {callId: safeText(source.callId, 512), name: safeText(source.name, 256), taskId: Number(source.taskId),
    parentTaskId: Number(source.parentTaskId), parentCallId: safeText(source.parentCallId, 512), status: source.status as 'pending' | 'running' | 'done', arguments: args,
    coverage: coverage(args.truncated || display.coverage.truncated || truncated || dropped)};
  if (result?.type === 'toolResult') { if (content.length) tool.parts = result.parts; if (result.output) tool.output = result.output; }
  const truncation = projected ? outputTruncation(object(source.output).truncation) : dropped ? {truncated: true as const} : undefined;
  if (truncation) tool.output = {...tool.output, truncation};
  nestedToolSummary(tool, summary); return tool;
}
function entryTool(source: Record<string, unknown>, id: string, kind: string): EntryView['tool'] {
  if (kind !== 'pi.tool-result' || !id.startsWith('live:tool:')) return undefined;
  const data = object(source.data);
  const tool = data.live === true ? nestedToolView(data.nestedTool) : nestedToolView(source.tool, true);
  return tool && id === `live:tool:${tool.callId}` ? tool : undefined;
}
function displayEntry(raw: unknown, fallbackId: string, options: ProjectionOptions = {}): EntryView {
  const source = object(raw);
  const id = safeText(typeof source.id === 'string' || typeof source.id === 'number' ? String(source.id) : fallbackId, 256);
  const kind = safeText(source.type ?? source.kind, 256) || 'unknown'; const result: EntryView = {id, kind};
  const tool = entryTool(source, id, kind);
  if (tool) { result.tool = tool; return finishEntry(result, structuredBudget(), []); }
  const hiddenCustom = kind === 'custom_message' && source.display === false;
  const messages = hiddenCustom ? [{...source, role: 'custom', content: []}] : entryMessages(source);
  const budget = options.budget ?? structuredBudget(), deferred: (() => void)[] = [];
  if (messages) {
    result.messages = messages.slice(0, 8).map((item, index) => {
      const message = object(item); const messageId = Array.isArray(message.parts) && typeof message.id === 'string' ? message.id : `${id}:message:${index}`;
      const source = entryImageSource(id, index, raw);
      const native = kind === 'pi.user' || kind === 'agent.thread-notice' || object(object(raw).communication).state === 'ready' ? object(raw).communication : undefined;
      const sourceId = typeof object(raw).id === 'string' ? object(raw).id as string : undefined;
      const communicationSource: CommunicationSource = {...options.communicationSource, entryId: sourceId, timestamp: object(raw).timestamp, native, nativeEntryId: sourceId, singleMessage: messages.length === 1 && message.role === 'user'};
      return projectMessage(item, messageId, 'final', source, {...options, budget, deferred, communicationSource});
    });
    if (messages.length > 8) result.data = {value: 'Additional messages omitted', truncated: true};
  } else result.data = displayData(source.data ?? source);
  const head = entryHeading(source, kind); if (head !== undefined) result.head = head;
  return finishEntry(result, budget, deferred);
}
function finishEntry(result: EntryView, budget: StructuredBudget, deferred: (() => void)[]): EntryView {
  budget.output = Math.min(budget.output, Math.max(0, DISPLAY_BYTES - sizeOf(result) - 1024));
  for (const attach of deferred) attach();
  return sizeOf(result) <= DISPLAY_BYTES ? result : {id: result.id, kind: result.kind, ...(result.head !== undefined ? {head: result.head} : {}), data: {value: '[entry display byte limit; content omitted]', truncated: true}};
}
export function projectEntry(raw: unknown, id: string = randomUUID(), options: ProjectionOptions = {}): EntryView {
  try { return displayEntry(raw, id, options); }
  catch { return {id: safeText(id, 256), kind: 'unknown', data: {value: '[malformed entry omitted]', truncated: true}}; }
}
const OUTPUT_BYTES = 8192;
/** Off-thread callers protect the whole text before byte paging so credentials cannot straddle chunks. */
export function protectedTextPage(source: string, offset: number, limit = OUTPUT_BYTES): {text: string; nextOffset: number | null; totalBytes: number} {
  const bytes = Buffer.from(safeText(source, Number.MAX_SAFE_INTEGER));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) throw new Error('Invalid output byte offset.');
  let end = Math.min(bytes.length, offset + limit);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {text: bytes.subarray(offset, end).toString('utf8'), nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length};
}
function savedOutput(part: PartView, preview: ReturnType<typeof protectedTextPage> | undefined, entryId: string, index: number): boolean {
  if (!preview || (part.type !== 'text' && part.type !== 'thinking')) return false;
  const text = part.text === preview.text ? part.text : part.text.replace(/\n\[truncated\]$/, '');
  if (!preview.text.startsWith(text)) return false;
  const offset = Buffer.byteLength(text); if (offset >= preview.totalBytes) return false;
  part.text = text; part.more = {entryId, part: index, offset}; return true;
}
/** SessionMessageEntry text previews remain recoverable through protected output pages. */
export function projectSavedEntry(raw: unknown): EntryView {
  const source = object(raw);
  if (source.type !== 'message' || typeof source.id !== 'string') return projectEntry(raw);
  const message = object(source.message);
  if (message.role === 'custom' && message.display === false) return projectEntry(raw);
  const content = messageContent(message);
  const retainedText = new Map<number, string>();
  const previews = content.map((rawPart, index) => {
    const part = object(rawPart);
    const value = part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking ?? part.text : undefined;
    if (typeof value !== 'string' || part.redacted === true) return {part, index};
    if (part.type === 'text') retainedText.set(index, value);
    const preview = protectedTextPage(value, 0);
    return {part: {...part, ...(part.type === 'text' ? {text: preview.text} : {thinking: preview.text, text: preview.text})}, index, preview};
  });
  const entry = projectEntry({...source, message: {...message, content: previews.map(item => item.part)}}, source.id, {retainedText});
  const displayed = entry.messages?.[0];
  if (!displayed) return entry;
  const parts = message.role === 'toolResult' && displayed.parts[0]?.type === 'toolResult' ? displayed.parts[0].parts : displayed.parts;
  let more = false;
  parts.forEach((part, index) => { more = savedOutput(part, previews[index]?.preview, String(source.id), index) || more; });
  if (more) displayed.coverage = {...displayed.coverage, complete: false, truncated: true, reason: 'Additional output is available on request.'};
  return entry;
}

function scalarRows(value: unknown): JsonDisplay | undefined {
  const supplied = object(value), source = Array.isArray(supplied.value) ? supplied.value : value;
  if (!Array.isArray(source)) return undefined;
  const rows = source.slice(0, 32).map(raw => {
    const row = object(raw), result: Record<string, unknown> = {};
    for (const field of ['id', 'kind', 'type', 'status', 'background', 'abortRequested', 'requestId', 'entryId', 'answerEntryId', 'reason']) {
      const item = row[field];
      if (typeof item === 'string') result[field] = safeText(item, 256);
      else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[field] = item;
    }
    return result;
  });
  const result = jsonDisplay(rows, 8192); result.truncated ||= source.length > 32 || supplied.truncated === true; return result;
}
function modelFields(raw: unknown): {provider: string; modelId: string} | undefined {
  const model = object(raw);
  return typeof model.provider === 'string' && typeof model.modelId === 'string' ? {provider: safeText(model.provider, 256), modelId: safeText(model.modelId, 256)} : undefined;
}
function generationRetry(raw: unknown): GenerationRetry | undefined {
  const retry = object(raw);
  if (!Number.isSafeInteger(retry.attempt) || Number(retry.attempt) < 1 || !Number.isSafeInteger(retry.at) || Number(retry.at) < 0 || Number(retry.at) > 8640000000000000 || typeof retry.error !== 'string') return;
  return {attempt: Number(retry.attempt), at: Number(retry.at), error: safeText(retry.error, 512)};
}
function providerBlockReference(raw: unknown): ProviderBlock['originalResults'][number] | undefined {
  const result = object(raw);
  if (typeof result.sessionId !== 'string' || !Number.isSafeInteger(result.submissionId) || Number(result.submissionId) < 1 || result.requestId !== undefined && typeof result.requestId !== 'string') return;
  if (safeText(result.sessionId, Number.MAX_SAFE_INTEGER) !== result.sessionId || typeof result.requestId === 'string' && safeText(result.requestId, Number.MAX_SAFE_INTEGER) !== result.requestId) return;
  return {sessionId: result.sessionId, submissionId: Number(result.submissionId), ...(typeof result.requestId === 'string' ? {requestId: result.requestId} : {})};
}
function providerBlock(raw: unknown): ProviderBlock | undefined {
  const block = object(raw), model = modelFields(block.model);
  if (!model || typeof block.blockId !== 'string' || typeof block.providerSessionId !== 'string' || typeof block.error !== 'string' || !Number.isSafeInteger(block.conversationId) || Number(block.conversationId) < 1 || !Number.isSafeInteger(block.epoch) || Number(block.epoch) < 0 || !Number.isSafeInteger(block.timestamp) || Number(block.timestamp) < 0 || !Array.isArray(block.originalResults) || !Number.isSafeInteger(block.omittedOriginalResults) || Number(block.omittedOriginalResults) < 0 || typeof block.errorRedacted !== 'boolean' || typeof block.errorTruncated !== 'boolean' || !['provider', 'host-block'].includes(String(block.source))) return;
  const originalResults: ProviderBlock['originalResults'] = [];
  for (const value of block.originalResults.slice(0, 16)) {
    const result = providerBlockReference(value); if (result) originalResults.push(result);
  }
  const protectedError = safeText(block.error, Number.MAX_SAFE_INTEGER), error = safeText(block.error, 4096);
  return {blockId: safeText(block.blockId, 128), conversationId: Number(block.conversationId), providerSessionId: safeText(block.providerSessionId, 256), epoch: Number(block.epoch), model,
    error, errorRedacted: block.errorRedacted || protectedError !== block.error, errorTruncated: block.errorTruncated || error !== protectedError,
    source: block.source as ProviderBlock['source'], timestamp: Number(block.timestamp), originalResults, omittedOriginalResults: Number(block.omittedOriginalResults) + block.originalResults.length - originalResults.length};
}
function currentToolSlots(source: Record<string,unknown>, live: Record<string,unknown>): Pick<ProjectedFrame['status'],'tools'|'toolsOmitted'> {
  const raw = live.tools ?? source.tools;
  if (!Array.isArray(raw)) return {};
  const tools: NonNullable<ProjectedFrame['status']['tools']> = [], seen = new Set<string>();
  for (const value of raw.slice(0,64)) {
    const item = object(value);
    if (typeof item.callId !== 'string' || !item.callId || item.callId.length > 512 || safeText(item.callId,512) !== item.callId || seen.has(item.callId) || typeof item.name !== 'string' || !['pending','running','done'].includes(String(item.status))) continue;
    seen.add(item.callId);tools.push({callId:item.callId,name:safeText(item.name,256),status:item.status as 'pending'|'running'|'done'});
  }
  const prior = Number.isSafeInteger(source.toolsOmitted) && Number(source.toolsOmitted) > 0 ? Number(source.toolsOmitted) : 0;
  const omitted = raw.length-tools.length+prior;
  return {tools,...(omitted ? {toolsOmitted:omitted} : {})};
}
function frameStatus(raw: unknown): ProjectedFrame['status'] {
  const source = object(raw), agent = object(source.agent); const status: ProjectedFrame['status'] = {busy: source.busy === true};
  if (typeof source.name === 'string') status.name = safeText(source.name, 256);
  const model = modelFields(source.model ?? agent.model); if (model) status.model = model;
  const thinking = source.thinkingLevel ?? agent.thinkingLevel;
  if (typeof thinking === 'string') status.thinkingLevel = safeText(thinking, 256);
  if (typeof source.lastText === 'string') status.lastText = safeText(source.lastText, 1024);
  const tasks = scalarRows(source.tasks), submissions = scalarRows(source.submissions);
  if (tasks) status.tasks = tasks; if (submissions) status.submissions = submissions;
  const live = object(source.live), generation = object(live.generation);
  Object.assign(status,currentToolSlots(source,live));
  const retry = generationRetry(source.retry ?? {...object(generation.retry), attempt: generation.attempt}); if (retry) status.retry = retry;
  const block = providerBlock(source.providerBlock); if (block) status.providerBlock = block;
  if (source.compactions !== undefined) status.compactions = displayData(source.compactions, 8192);
  else if (Array.isArray(live.compactions)) {
    status.compactions = jsonDisplay(live.compactions.slice(0, 32), 8192);
    status.compactions.truncated ||= live.compactions.length > 32;
  }
  if (source.compactionFailure !== undefined) status.compactionFailure = displayData(source.compactionFailure, 4096);
  else if (live.compactionFailure !== undefined) status.compactionFailure = jsonDisplay(live.compactionFailure, 4096);
  return status;
}
function unavailableLiveImages(parts: PartView[]): void {
  for (const part of parts) {
    if (part.type === 'image') delete part.source;
    else if (part.type === 'toolResult') unavailableLiveImages(part.parts);
  }
}
class FrameProjector {
  private bytes: number;
  private readonly senders: ReturnType<typeof taskSenderHints>;
  constructor(statusBytes = 0, senders = taskSenderHints(undefined)) { this.bytes = 4096 + statusBytes; this.senders = senders; }
  omitted = 0;
  truncated = false;
  private sender(entry: EntryView): void {
    const sender = this.senders?.[entry.id];
    if (sender && entry.messages?.some(message => message.role === 'user')) entry.sender = {identity: sender.identity, ...(sender.name !== undefined ? {name: safeText(sender.name, 2000)} : {})};
  }
  collect(value: unknown, partial: boolean, communicationSource: CommunicationSource): EntryView[] {
    if (!Array.isArray(value)) { this.truncated = true; return []; }
    const rows: EntryView[] = [];
    for (let index = value.length - 1; index >= 0; index--) {
      if (rows.length >= 100 || this.bytes >= 230 * 1024) { this.omitted += index + 1; break; }
      const entry = projectEntry(value[index], undefined, {communicationSource});
      this.sender(entry);
      if (partial) entry.messages?.forEach(message => { message.state = 'partial'; unavailableLiveImages(message.parts); });
      const size = sizeOf(entry);
      if (this.bytes + size > 230 * 1024) { this.omitted += index + 1; break; }
      this.bytes += size; rows.push(entry);
      this.truncated ||= entry.data?.truncated === true || entry.tool?.coverage.truncated === true || entry.messages?.some(message => message.coverage.truncated) === true;
    }
    return rows.reverse();
  }
}
function frameCoverage(raw: unknown, projected: FrameProjector): DisplayCoverage {
  const source = object(raw);
  const truncated = projected.truncated || projected.omitted > 0 || source.byteLimitReached === true || source.entryLimitReached === true || source.truncated === true;
  const complete = source.complete === true && !truncated;
  return {complete, truncated, omitted: projected.omitted, ...(!complete ? {reason: 'Bounded native display window'} : {})};
}
export function projectFrame(raw: unknown): ProjectedFrame {
  try {
    const source = object(raw), status = frameStatus(source.status), projector = new FrameProjector(sizeOf(status), taskSenderHints(source.taskSenders));
    const communicationSource: CommunicationSource = {storageId: typeof source.storageId === 'string' ? source.storageId : undefined, conversationId: typeof source.conversationId === 'number' ? source.conversationId : undefined};
    const live = projector.collect(source.live ?? [], true, communicationSource), entries = projector.collect(source.entries ?? [], false, communicationSource);
    projector.truncated ||= status.compactions?.truncated === true || status.compactionFailure?.truncated === true || !!status.toolsOmitted;
    return {revision: Number.isSafeInteger(source.revision) ? Number(source.revision) : 0, observedAt: safeText(source.observedAt, 256), entries, live,
      nextBefore: Number.isSafeInteger(source.nextBefore) && Number(source.nextBefore) > 0 ? Number(source.nextBefore) : null,
      status, coverage: frameCoverage(source.coverage, projector)};
  } catch { return {revision: 0, observedAt: '', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage: coverage(true, 1)}; }
}
function publishedRetry(source: Record<string, unknown>): AgentRow['publishedRetry'] {
  const retry = object(object(source.health).autoRetry ?? source.publishedRetry);
  if (!Number.isSafeInteger(retry.attempt) || Number(retry.attempt) < 1 || !Number.isSafeInteger(retry.maxAttempts) || Number(retry.maxAttempts) < 1 || !Number.isSafeInteger(retry.delayMs) || Number(retry.delayMs) < 0 || typeof (retry.errorMessage ?? retry.error) !== 'string') return;
  return {attempt: Number(retry.attempt), maxAttempts: Number(retry.maxAttempts), delayMs: Number(retry.delayMs), error: safeText(retry.errorMessage ?? retry.error, 512)};
}
function rosterAttention(raw: unknown): AgentRow['attention'] {
  const need = object(raw);
  if (need.kind === 'provider-blocked' || need.kind === 'failed-turn') return {kind: need.kind};
  if (need.kind === 'task-blocked' && ['missing_task', 'task_too_old', 'migration_failed', 'restart_limit'].includes(String(need.reason))) return {kind: 'task-blocked', reason: need.reason as 'missing_task' | 'task_too_old' | 'migration_failed' | 'restart_limit'};
}
function rosterOptionals(row: AgentRow, source: Record<string, unknown>): void {
  for (const key of ['name', 'handle', 'thinkingLevel', 'latestReply', 'firstMessage', 'error', 'observedAt', 'ownerLabel'] as const) {
    if (typeof source[key] === 'string') row[key] = safeText(source[key], key === 'latestReply' || key === 'firstMessage' ? 2048 : 256);
  }
  const model = modelFields(source.model); if (model) row.model = model;
  const thinking = object(source.model).thinkingLevel;
  if (row.model && typeof thinking === 'string') row.model.thinkingLevel = safeText(thinking, 256);
  const tool = object(source.currentTool);
  if (typeof tool.name === 'string') row.currentTool = {name: safeText(tool.name, 256), argument: safeText(tool.argument, 1024)};
  const retry = publishedRetry(source); if (retry) row.publishedRetry = retry;
  const attention = rosterAttention(source.attention); if (attention) row.attention = attention;
  const caps = object(source.capabilities);
  if (typeof source.identity === 'string' && source.capabilities) row.capabilities = {history: caps.history === true, observe: caps.observe === true, input: caps.input === true, abort: caps.abort === true, configure: caps.configure === true, inspect: caps.inspect === true, commands: caps.commands === true};
}
function rosterIdentity(source: Record<string, unknown>): CatalogRow['id'] | undefined {
  const id = source.identity ?? source.id;
  return typeof id === 'string' ? id : undefined;
}
function catalogClaim(value: unknown): CatalogRow['claim'] | undefined {
  return value === 'live' || value === 'unknown' || value === 'dead' || value === 'absent' ? value : undefined;
}
function rosterAvailability(source: Record<string, unknown>): AgentRow['availability'] {
  if (typeof source.identity === 'string' && ['live', 'stored', 'unavailable', 'incompatible'].includes(String(source.availability))) return source.availability as AgentRow['availability'];
  const claim = catalogClaim(source.claim);
  // Catalog live means writer presence, not a negotiated socket or input capability.
  if (claim === 'live') return 'live';
  return claim === 'unknown' ? 'unavailable' : 'stored';
}
function catalogPresentation(row: AgentRow, source: Record<string, unknown>): void {
  if (typeof source.identity === 'string') return;
  if (typeof source.publishedAt === 'string') row.observedAt = safeText(source.publishedAt, 256);
  if (row.model?.thinkingLevel !== undefined) row.thinkingLevel = row.model.thinkingLevel;
  const claim = catalogClaim(source.claim);
  if (claim !== 'live') {
    if (row.state === 'working') row.state = 'interrupted';
    delete row.currentTool;
  }
}
function rosterRow(raw: unknown): AgentRow | undefined {
  const source = object(raw), identity = rosterIdentity(source);
  if (identity === undefined || typeof source.storageId !== 'string') return undefined;
  const row: AgentRow = {identity: safeText(identity, 256), storageId: safeText(source.storageId, 256), cwd: safeText(source.cwd, 4096),
    modifiedAt: typeof source.modifiedAt === 'number' && Number.isFinite(source.modifiedAt) ? source.modifiedAt : 0,
    state: safeText(source.state, 256), owner: source.owner === 'here' || source.owner === 'unavailable' ? source.owner : 'unknown',
    availability: rosterAvailability(source), partial: source.partial === true};
  rosterOptionals(row, source); if (typeof source.role === 'string') row.role = safeText(source.role, 24 * 1024); catalogPresentation(row, source); return row;
}
function rosterScan(raw: unknown, omitted: number): CachedRoster['scan'] {
  const source = object(raw); const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  return {state: ['not-started', 'running', 'ready', 'failed'].includes(String(source.state)) ? source.state as CachedRoster['scan']['state'] : 'not-started',
    complete: source.complete === true && omitted === 0, visited: count(source.visited), skipped: count(source.skipped), omitted: count(source.omitted) + omitted,
    ...(typeof source.scanId === 'string' ? {scanId: safeText(source.scanId, 256)} : {})};
}
function rosterCursor(source: Record<string, unknown>, result: CachedRoster): void {
  if (source.nextCursor === undefined) return;
  if (source.nextCursor === null) { result.nextCursor = null; return; }
  if (typeof source.nextCursor === 'string' && sizeOf(source.nextCursor) <= 4096) { result.nextCursor = source.nextCursor; return; }
  result.nextCursor = null; result.scan.complete = false; result.scan.omitted++;
  result.error = {code: 'protocol_error', message: 'Roster cursor exceeds its display limit', retry: 'read'};
}
/** Projects published metadata only. It performs no host connection or discovery. */
export function projectRoster(raw: unknown): CachedRoster {
  try {
    const source = object(raw); const input = Array.isArray(raw) ? raw : Array.isArray(source.rows) ? source.rows : [];
    const rows: AgentRow[] = []; let bytes = 8192; let omitted = 0;
    for (let index = 0; index < input.length; index++) {
      if (rows.length >= 2048) { omitted += input.length - index; break; }
      const row = rosterRow(input[index]); if (!row) { omitted++; continue; }
      const size = sizeOf(row);
      if (bytes + size > 8 * 1024 * 1024) { omitted += input.length - index; break; }
      bytes += size; rows.push(row);
    }
    const result: CachedRoster = {rows, stale: source.stale !== false, ...(typeof source.observedAt === 'string' ? {observedAt: safeText(source.observedAt, 256)} : {}), scan: rosterScan(source.scan, omitted)};
    const failure = object(source.scan).error;
    if (result.scan.state === 'failed' && typeof failure === 'string' && failure) result.error = {code: 'host_unavailable', message: safeText(failure, 1024), retry: 'read'};
    rosterCursor(source, result); return result;
  } catch { return {rows: [], stale: true, scan: {state: 'failed', complete: false, visited: 0, skipped: 0, omitted: 1}}; }
}
