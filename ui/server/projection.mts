import { randomUUID } from 'node:crypto';
import type { CatalogRow } from '../agents/index.mts';
import type { AgentRow, CachedRoster, DisplayCoverage, EntryView, JsonDisplay, MessageView, PartView, ProjectedFrame } from '../shared/api.ts';

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
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function coverage(truncated = false, omitted = 0): DisplayCoverage {
  return {complete: !truncated, truncated, omitted, ...(truncated ? {reason: 'Display limits or protected content'} : {})};
}
class JsonProjector {
  private nodes = 0;
  private readonly seen = new Set<object>();
  truncated = false;
  private remaining: number;
  constructor(bytes: number) { this.remaining = bytes; }
  private omit(): string { this.truncated = true; return OMITTED; }
  visit(value: unknown, depth = 0): unknown {
    if (++this.nodes > 2048 || depth > 8 || this.remaining < 32) return this.omit();
    if (value === null || typeof value === 'boolean') { this.remaining -= 8; return value; }
    if (typeof value === 'number') { this.remaining -= 32; return Number.isFinite(value) ? value : null; }
    if (typeof value === 'string') return this.text(value);
    if (typeof value !== 'object' || this.seen.has(value)) return this.omit();
    this.seen.add(value);
    return Array.isArray(value) ? this.array(value, depth) : this.record(value as Record<string, unknown>, depth);
  }
  private text(value: string): string {
    let text = safeText(value, Math.min(TEXT_BYTES, this.remaining - 32));
    if (sizeOf(text) > this.remaining) text = safeText(text, Math.floor((this.remaining - 32) / 6));
    this.truncated ||= text !== value; this.remaining -= sizeOf(text); return text;
  }
  private array(value: unknown[], depth: number): unknown[] {
    const result: unknown[] = [];
    for (const item of value) {
      if (this.nodes >= 2048 || this.remaining < 32) { result.push(this.omit()); break; }
      this.remaining -= 2; result.push(this.visit(item, depth + 1));
    }
    return result;
  }
  private record(value: Record<string, unknown>, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (this.nodes >= 2048 || this.remaining < 512) { result['[omitted fields]'] = this.omit(); break; }
      const displayKey = safeText(key, 256); this.remaining -= sizeOf(displayKey) + 4;
      result[displayKey] = hiddenKey.test(key) ? this.omit() : this.visit(value[key], depth + 1);
    }
    return result;
  }
}
export function jsonDisplay(raw: unknown, maxBytes = DISPLAY_BYTES): JsonDisplay {
  try {
    const projector = new JsonProjector(maxBytes); const value = projector.visit(raw); const bytes = sizeOf(value);
    if (bytes > maxBytes) return {value: '[display byte limit; content omitted]', truncated: true, omittedBytes: bytes};
    return {value, truncated: projector.truncated};
  } catch { return {value: '[malformed display content omitted]', truncated: true}; }
}
export const projectJson = jsonDisplay;
function displayData(raw: unknown, bound = DISPLAY_BYTES): JsonDisplay {
  const data = object(raw), projected = jsonDisplay('value' in data && typeof data.truncated === 'boolean' ? data.value : raw, bound);
  projected.truncated ||= data.truncated === true; return projected;
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
  constructor(privateDepth = 0) { this.depth = privateDepth; }
  private readonly depth: number;
  private part(raw: unknown): PartView {
    const part = object(raw);
    if (part.type === 'text' || part.type === 'thinking') return this.textPart(part);
    if (part.type === 'toolCall') {
      const args = displayData(part.arguments, Math.max(128, Math.floor(this.remaining / 2))); this.changed ||= args.truncated;
      return {type: 'toolCall', callId: safeText(part.id ?? part.callId, 256), name: safeText(part.name, 256), arguments: args};
    }
    if (part.type === 'toolResult' && this.depth < 8) {
      const nested = new MessageProjector(this.depth + 1).message({role: 'toolResult', content: part.parts, toolCallId: part.callId, toolName: part.name, isError: part.isError}, 'nested', 'final');
      this.changed ||= nested.coverage.truncated; return nested.parts[0] ?? {type: 'omitted', label: 'Tool result omitted'};
    }
    if (part.type === 'omitted') { this.changed = true; return {type: 'omitted', label: safeText(part.label, 256)}; }
    this.omitted++;
    const label = part.type === 'image' ? 'Image omitted' : 'Unsupported content omitted';
    return {type: 'omitted', label};
  }
  private textPart(part: Record<string, unknown>): PartView {
    const text = part.type === 'text' ? part.text : part.thinking ?? part.text;
    const display = part.redacted === true ? '[redacted thinking]' : safeText(text, Math.min(TEXT_BYTES, this.remaining - 128));
    this.changed ||= display !== text;
    return {type: part.type === 'text' ? 'text' : 'thinking', text: display, ...(part.redacted === true ? {redacted: true} : {})};
  }
  private parts(source: Record<string, unknown>): PartView[] {
    const content = messageContent(source); const parts: PartView[] = [];
    const limit = Array.isArray(source.parts) ? 101 : 100;
    this.omitted += Math.max(0, content.length - limit);
    for (const item of content.slice(0, limit)) {
      if (this.remaining < 256 && object(item).type !== 'omitted') { this.omitted++; continue; }
      const projected = this.part(item); let bytes = sizeOf(projected);
      if (bytes > this.remaining && (projected.type === 'text' || projected.type === 'thinking')) {
        projected.text = safeText(projected.text, Math.max(64, Math.floor((this.remaining - 128) / 6))); bytes = sizeOf(projected); this.changed = true;
      }
      if (bytes > this.remaining) { this.omitted++; continue; }
      this.remaining -= bytes; parts.push(projected);
    }
    return parts;
  }
  message(raw: unknown, id: string, state: 'partial' | 'final'): MessageView {
    const source = object(raw);
    const hidden = source.role === 'custom' && source.display === false;
    const parts = hidden ? [] : this.parts(source);
    if (typeof source.role !== 'string') this.omitted++;
    if (source.role === 'toolResult' && !parts.some(part => part.type === 'toolResult')) {
      const result: PartView = {type: 'toolResult', callId: safeText(source.toolCallId, 256), name: safeText(source.toolName, 256), parts: [...parts], isError: source.isError === true};
      parts.splice(0, parts.length, result);
    }
    if (this.omitted) parts.push({type: 'omitted', label: `${this.omitted} content parts omitted`});
    const prior = object(source.coverage);
    const omitted = this.omitted + (Number.isSafeInteger(prior.omitted) && Number(prior.omitted) >= 0 ? Number(prior.omitted) : 0);
    const result: MessageView = {id: safeText(id, 256), role: safeText(source.role, 256) || 'unknown', parts, state, coverage: coverage(this.changed || omitted > 0 || prior.truncated === true, omitted)};
    if (prior.complete === false) result.coverage.complete = false;
    if (this.omitted === 0 && typeof prior.reason === 'string') result.coverage.reason = safeText(prior.reason, 256);
    messageDetails(source, result);
    return result;
  }
}
function messageDetails(source: Record<string, unknown>, result: MessageView): void {
  if (typeof source.timestamp === 'number' && Number.isFinite(source.timestamp)) result.timestamp = source.timestamp;
  if (typeof source.stopReason === 'string') result.stopReason = safeText(source.stopReason, 256);
  if (typeof (source.errorMessage ?? source.error) === 'string') result.error = safeText(source.errorMessage ?? source.error, 1024);
}
export function projectMessage(raw: unknown, id: string, state: 'partial' | 'final' = 'final'): MessageView {
  try { return new MessageProjector().message(raw, id, state); }
  catch { return {id: safeText(id, 256), role: 'unknown', state, parts: [{type: 'omitted', label: 'Malformed message omitted'}], coverage: coverage(true, 1)}; }
}
function entryMessages(source: Record<string, unknown>): unknown[] | undefined {
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
function displayEntry(raw: unknown, fallbackId: string): EntryView {
  const source = object(raw);
  const id = safeText(typeof source.id === 'string' || typeof source.id === 'number' ? String(source.id) : fallbackId, 256);
  const kind = safeText(source.type ?? source.kind, 256) || 'unknown'; const result: EntryView = {id, kind};
  const hiddenCustom = kind === 'custom_message' && source.display === false;
  const messages = hiddenCustom ? [{...source, role: 'custom', content: []}] : entryMessages(source);
  if (messages) {
    result.messages = messages.slice(0, 8).map((item, index) => {
      const message = object(item); const messageId = Array.isArray(message.parts) && typeof message.id === 'string' ? message.id : `${id}:message:${index}`;
      return projectMessage(item, messageId);
    });
    if (messages.length > 8) result.data = {value: 'Additional messages omitted', truncated: true};
  } else result.data = displayData(source.data ?? source);
  const head = entryHeading(source, kind); if (head !== undefined) result.head = head;
  return sizeOf(result) <= DISPLAY_BYTES ? result : {id, kind, ...(head !== undefined ? {head} : {}), data: {value: '[entry display byte limit; content omitted]', truncated: true}};
}
export function projectEntry(raw: unknown, id: string = randomUUID()): EntryView {
  try { return displayEntry(raw, id); }
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
  const previews = content.map((rawPart, index) => {
    const part = object(rawPart);
    const value = part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking ?? part.text : undefined;
    if (typeof value !== 'string' || part.redacted === true) return {part, index};
    const preview = protectedTextPage(value, 0);
    return {part: {...part, ...(part.type === 'text' ? {text: preview.text} : {thinking: preview.text, text: preview.text})}, index, preview};
  });
  const entry = projectEntry({...source, message: {...message, content: previews.map(item => item.part)}});
  const displayed = entry.messages?.[0];
  if (!displayed) return entry;
  const parts = message.role === 'toolResult' && displayed.parts[0]?.type === 'toolResult' ? displayed.parts[0].parts : displayed.parts;
  let more = false;
  parts.forEach((part, index) => { more = savedOutput(part, previews[index]?.preview, String(source.id), index) || more; });
  if (more) displayed.coverage = {...displayed.coverage, complete: false, truncated: true, reason: 'Additional output is available on request.'};
  return entry;
}

function scalarRows(value: unknown): JsonDisplay | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.slice(0, 32).map(raw => {
    const row = object(raw), result: Record<string, unknown> = {};
    for (const field of ['id', 'kind', 'type', 'status', 'background', 'abortRequested', 'requestId', 'entryId', 'answerEntryId', 'reason']) {
      const item = row[field];
      if (typeof item === 'string') result[field] = safeText(item, 256);
      else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[field] = item;
    }
    return result;
  });
  const result = jsonDisplay(rows, 8192); result.truncated ||= value.length > 32; return result;
}
function modelFields(raw: unknown): {provider: string; modelId: string} | undefined {
  const model = object(raw);
  return typeof model.provider === 'string' && typeof model.modelId === 'string' ? {provider: safeText(model.provider, 256), modelId: safeText(model.modelId, 256)} : undefined;
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
  return status;
}
class FrameProjector {
  private bytes = 4096;
  omitted = 0;
  truncated = false;
  collect(value: unknown, partial: boolean): EntryView[] {
    if (!Array.isArray(value)) { this.truncated = true; return []; }
    const rows: EntryView[] = [];
    for (let index = value.length - 1; index >= 0; index--) {
      if (rows.length >= 100 || this.bytes >= 230 * 1024) { this.omitted += index + 1; break; }
      const entry = projectEntry(value[index]);
      if (partial) entry.messages?.forEach(message => { message.state = 'partial'; });
      const size = sizeOf(entry);
      if (this.bytes + size > 230 * 1024) { this.omitted += index + 1; break; }
      this.bytes += size; rows.push(entry);
      this.truncated ||= entry.data?.truncated === true || entry.messages?.some(message => message.coverage.truncated) === true;
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
    const source = object(raw), projector = new FrameProjector();
    const live = projector.collect(source.live ?? [], true), entries = projector.collect(source.entries ?? [], false);
    return {revision: Number.isSafeInteger(source.revision) ? Number(source.revision) : 0, observedAt: safeText(source.observedAt, 256), entries, live,
      nextBefore: Number.isSafeInteger(source.nextBefore) && Number(source.nextBefore) > 0 ? Number(source.nextBefore) : null,
      status: frameStatus(source.status), coverage: frameCoverage(source.coverage, projector)};
  } catch { return {revision: 0, observedAt: '', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage: coverage(true, 1)}; }
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
  const caps = object(source.capabilities);
  if (typeof source.identity === 'string' && source.capabilities) row.capabilities = {history: caps.history === true, observe: caps.observe === true, input: caps.input === true, abort: caps.abort === true, configure: caps.configure === true, inspect: caps.inspect === true};
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
  rosterOptionals(row, source); catalogPresentation(row, source); return row;
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
    rosterCursor(source, result); return result;
  } catch { return {rows: [], stale: true, scan: {state: 'failed', complete: false, visited: 0, skipped: 0, omitted: 1}}; }
}
