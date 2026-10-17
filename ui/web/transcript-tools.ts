import type { EntryView, JsonDisplay, PartView, ToolOutputInfo } from '../shared/api.ts';
import type { ToolState } from './state.ts';
import { TranscriptGroups } from './transcript-groups.ts';

export type JoinedTool = {callId: string; name: string; owner: string; slot: string; args?: JsonDisplay; result?: PartView[]; output?: ToolOutputInfo; status: string; duration?: number; observedStart?: number; argumentText?: string; parentCallId?: string; taskId?: number; parentTaskId?: number};
/** Elapsed time starts at receipt of a tool start, not at a history timestamp. */
export function toolTime(tool: JoinedTool, now = Date.now()): string {
  if (tool.status !== 'working') return tool.duration === undefined ? '' : `${tool.duration} ms`;
  if (tool.observedStart === undefined) return '';
  const seconds = Math.floor(Math.max(0, now - tool.observedStart) / 1000);
  return seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
}
/** One clock per transcript; the paint callback returns false when no timed tool is visible. */
export class ToolElapsedClock {
  private timer?: ReturnType<typeof setInterval>;
  private paint: () => boolean;
  constructor(paint: () => boolean) { this.paint = paint; }
  sync(): void {
    if (!this.paint()) { this.stop(); return; }
    if (this.timer === undefined) this.timer = setInterval(() => { if (!this.paint()) this.stop(); }, 1000);
  }
  stop(): void { if (this.timer !== undefined) clearInterval(this.timer); this.timer = undefined; }
}
type ToolPart = {part: Extract<PartView, {type: 'toolCall' | 'toolResult'}> | (NonNullable<EntryView['tool']> & {type: 'execution'}); owner: string; slot: string; sequence: number};
type EntryParts = {tools: ToolPart[]; thinking: string[]; communication: string[]};
export function slot(entry: string, message: string, index: number): string { return JSON.stringify([entry, message, index]); }
export function toolDisclosureKeys(id: string): string[] { return [`tool:${id}`, `arguments:${id}`, `raw-output:${id}`]; }
/** Opaque preference keys stay inside the existing state bound for long source IDs. */
export function communicationDisclosureKeys(entry: string, message: string): [string] {
  let key = 0x6c62272e07bb014262b821756295c58dn;
  for (const point of JSON.stringify([entry, message])) key = BigInt.asUintN(128, (key ^ BigInt(point.codePointAt(0) ?? 0)) * 0x1000000000000000000013bn);
  const id = key.toString(16); return [`communication-details:${id}`];
}
function sameTool(a: JoinedTool | undefined, b: JoinedTool): boolean {
  return !!a && a.name === b.name && a.owner === b.owner && a.slot === b.slot && a.args === b.args &&
    a.result === b.result && a.output === b.output && a.status === b.status && a.duration === b.duration && a.observedStart === b.observedStart && a.argumentText === b.argumentText &&
    a.parentCallId === b.parentCallId && a.taskId === b.taskId && a.parentTaskId === b.parentTaskId;
}
function executionStatus(part: NonNullable<EntryView['tool']>): string {
  if (part.status === 'pending') return 'pending';
  if (part.status === 'running') return 'working';
  return part.isError === true ? 'error' : part.isError === false ? 'success' : 'ended';
}
function applyExecution(tool: JoinedTool, part: NonNullable<EntryView['tool']>): void {
  tool.args = part.arguments; tool.result = part.parts; tool.output = part.output; tool.duration = part.durationMs;
  tool.parentCallId = part.parentCallId; tool.taskId = part.taskId; tool.parentTaskId = part.parentTaskId;
  tool.status = executionStatus(part);
}
function combineParts(id: string, parts: ToolPart[]): JoinedTool | undefined {
    let tool: JoinedTool | undefined; let called = false;
    for (const item of parts) {
      const part = item.part;
      tool ??= {callId: id, name: part.name, owner: item.owner, slot: item.slot, status: 'missing'};
      if (part.type === 'toolCall') { tool.args = part.arguments; if (!called) { tool.name = part.name; tool.owner = item.owner; tool.slot = item.slot; called = true; } }
      else if (part.type === 'execution') applyExecution(tool, part);
      else { tool.result = part.parts; tool.output = part.output; tool.status = part.isError ? 'error' : 'success'; }
    }
  return tool;
}
function applyState(tool: JoinedTool, state: ToolState | undefined): void {
  if (!state) return;
  tool.args = state.arguments ?? tool.args; tool.argumentText = state.argumentText; tool.result = state.parts ?? tool.result; tool.duration = state.durationMs;
  tool.output = state.output ?? tool.output; tool.observedStart = state.observedStart;
  if (state.phase === 'end') tool.status = state.isError ? 'error' : 'success';
  else if (state.observedStart !== undefined) tool.status = 'working';
  else if (tool.status === 'missing' && tool.result !== undefined) tool.status = 'available';
}
export type SessionGroup = {id: string; entries: readonly EntryView[]; notices: readonly EntryView[]};
export function actionableEntry(entry: EntryView): boolean {
  if (entry.data?.truncated) return true;
  const value = entry.data?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
  if (['actionRequired', 'requiresAction', 'isError'].some(key => own(key) === true)) return true;
  if (['severity', 'level', 'status'].some(key => { const field = own(key); return typeof field === 'string' && ['error', 'warning', 'warn', 'critical', 'failed', 'blocked'].includes(field); })) return true;
  const actions = own('actions'); const error = own('error');
  return Array.isArray(actions) && actions.length > 0 || error !== undefined && error !== null && error !== false && error !== '';
}
/** Public session state records are not messages; uncertain kinds and flagged data remain visible. */
export function routineSessionEntry(entry:EntryView):boolean{
  return ['custom','model_change','thinking_level_change','session_info'].includes(entry.kind)&&!!entry.data&&!actionableEntry(entry);
}
function sessionEvent(entry: EntryView): boolean { return entry.kind !== 'message' && !entry.messages?.length && !entry.tool; }
function sessionGroup(old: SessionGroup | undefined, id: string, members: EntryView[]): SessionGroup {
  if (old && old.entries.length === members.length && old.entries.every((entry, index) => entry === members[index])) return old;
  return {id, entries: members, notices: members.filter(actionableEntry)};
}
const allEntriesVisible = () => true;
/** Entry identity checks do not inspect unchanged message parts. */
export class TranscriptIndex {
  readonly groups = new TranscriptGroups();
  readonly entries = new Map<string, EntryView>();
  readonly joined = new Map<string, JoinedTool>();
  readonly disclosures = new Map<string, string>();
  readonly changed = new Set<string>();
  readonly sessions = new Map<string, SessionGroup>();
  readonly sessionOwners = new Map<string, string>();
  private parts = new Map<string, EntryParts>();
  private calls = new Map<string, Map<string, ToolPart[]>>();
  private states: ReadonlyMap<string, ToolState> = new Map();
  private order = new Map<string, number>();
  private visibility = new Map<string, boolean>();
  private predicate?: (entry: EntryView) => boolean;
  update(entries: readonly EntryView[], states: ReadonlyMap<string, ToolState>, isVisible: (entry: EntryView) => boolean = allEntriesVisible, options: {incrementalVisibility?: boolean} = {}): void {
    this.changed.clear();
    const touched = new Set<string>(); const ids = new Set<string>(); let reordered = false; let sessionSources = false;
    entries.forEach((entry, index) => {
      ids.add(entry.id); if (this.order.get(entry.id) !== index) reordered = true;
      this.order.set(entry.id, index);
      if (this.indexEntry(entry, touched)) sessionSources = true;
    });
    for (const id of this.entries.keys()) if (!ids.has(id)) { reordered = true; this.remove(id, touched); this.entries.delete(id); this.order.delete(id); this.visibility.delete(id); this.changed.add(id); }
    if (reordered) for (const id of this.calls.keys()) touched.add(id);
    for (const [id, state] of states) if (this.states.get(id) !== state) touched.add(id);
    for (const id of this.states.keys()) if (!states.has(id)) touched.add(id);
    this.states = states;
    for (const id of touched) this.rebuild(id);
    const visibilityChanged = this.updateVisibility(entries, isVisible, options.incrementalVisibility);
    if (reordered || sessionSources || visibilityChanged) this.groupSessions(entries);
    this.groups.update(this.changed, this.entries);
  }
  private indexEntry(entry: EntryView, touched: Set<string>): boolean {
    const previous = this.entries.get(entry.id); if (previous === entry) return false;
    const sessionChanged = sessionEvent(entry) || !!previous && sessionEvent(previous);
    this.remove(entry.id, touched); this.entries.set(entry.id, entry); this.changed.add(entry.id);
    const parts = this.entryParts(entry); this.parts.set(entry.id, parts);
    for (const id of [...parts.thinking, ...parts.communication]) this.disclosures.set(id, entry.id);
    for (const item of parts.tools) {
      const id = item.part.callId; touched.add(id);
      let owners = this.calls.get(id); if (!owners) { owners = new Map(); this.calls.set(id, owners); }
      const group = owners.get(entry.id) ?? []; group.push(item); owners.set(entry.id, group);
    }
    return sessionChanged;
  }
  private updateVisibility(entries: readonly EntryView[], isVisible: (entry: EntryView) => boolean, incremental?: boolean): boolean {
    let changed = false;
    const ids = incremental && this.predicate === isVisible ? this.changed : entries.map(entry => entry.id); this.predicate = isVisible;
    for (const id of ids) {
      const entry = this.entries.get(id); if (!entry) continue; const shown = isVisible(entry);
      if (this.visibility.get(id) !== shown) { changed = true; this.changed.add(id); } this.visibility.set(id, shown);
    }
    return changed;
  }
  private groupSessions(entries: readonly EntryView[]): void {
    const visible = entries.filter(entry => this.visibility.get(entry.id));
    const previous = new Map(this.sessions); this.sessions.clear(); this.sessionOwners.clear();
    for (const id of previous.keys()) this.disclosures.delete(`events:${id}`);
    for (let at = 0; at < visible.length;) {
      const first = visible[at];
      if (!first || !sessionEvent(first)) { at++; continue; }
      const members: EntryView[] = [];
      while (at < visible.length) {
        const entry = visible[at]; if (!entry || !sessionEvent(entry)) break;
        members.push(entry); this.sessionOwners.set(entry.id, first.id); at++;
      }
      const old = previous.get(first.id); previous.delete(first.id);
      const group = sessionGroup(old, first.id, members);
      this.sessions.set(first.id, group); this.disclosures.set(`events:${first.id}`, first.id);
      if (group !== old) this.changed.add(first.id);
    }
    for (const id of previous.keys()) this.changed.add(id);
  }
  private entryParts(entry: EntryView): EntryParts {
    const parts: EntryParts = {tools: [], thinking: [], communication: []};
    if (entry.tool) parts.tools.push({part: {...entry.tool, type: 'execution'}, owner: entry.id, slot: slot(entry.id, 'tool', 0), sequence: 0});
    for (const message of entry.messages ?? []) {
      if (message.communication) parts.communication.push(...communicationDisclosureKeys(entry.id, message.id));
      message.parts.forEach((part, at) => {
        if (part.type === 'thinking') parts.thinking.push(`thinking:${entry.id}:${message.id}:${at}`);
        if (part.type === 'toolCall' || part.type === 'toolResult') parts.tools.push({part, owner: entry.id, slot: slot(entry.id, message.id, at), sequence: parts.tools.length});
      });
    }
    return parts;
  }
  private remove(id: string, touched: Set<string>): void {
    const previous = this.parts.get(id); if (!previous) return;
    for (const disclosure of [...previous.thinking, ...previous.communication]) this.disclosures.delete(disclosure);
    for (const item of previous.tools) {
      const key = item.part.callId; touched.add(key); const owners = this.calls.get(key); owners?.delete(id);
      if (!owners?.size) this.calls.delete(key);
    }
    this.parts.delete(id);
  }
  private rebuild(id: string): void {
    const previous = this.joined.get(id);
    const owners = this.calls.get(id);
    const parts = [...owners?.values() ?? []].flat().sort((a, b) => (this.order.get(a.owner) ?? 0) - (this.order.get(b.owner) ?? 0) || a.sequence - b.sequence);
    const tool = combineParts(id, parts);
    if (tool) applyState(tool, this.states.get(id));
    if (tool && sameTool(previous, tool)) return;
    if (previous) this.changed.add(previous.owner);
    for (const owner of owners?.keys() ?? []) this.changed.add(owner);
    if (!tool) { this.joined.delete(id); for (const key of toolDisclosureKeys(id)) this.disclosures.delete(key); return; }
    this.joined.set(id, tool); for (const key of toolDisclosureKeys(id)) this.disclosures.set(key, tool.owner); this.changed.add(tool.owner);
  }
}
