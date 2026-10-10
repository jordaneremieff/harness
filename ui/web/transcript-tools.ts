import type { EntryView, JsonDisplay, PartView, ToolOutputInfo } from '../shared/api.ts';
import type { ToolState } from './state.ts';

export type JoinedTool = {callId: string; name: string; owner: string; slot: string; args?: JsonDisplay; result?: PartView[]; output?: ToolOutputInfo; status: string; duration?: number; argumentText?: string};
type ToolPart = {part: Extract<PartView, {type: 'toolCall' | 'toolResult'}>; owner: string; slot: string; sequence: number};
type EntryParts = {tools: ToolPart[]; thinking: string[]};
export function slot(entry: string, message: string, index: number): string { return JSON.stringify([entry, message, index]); }
function sameTool(a: JoinedTool | undefined, b: JoinedTool): boolean {
  return !!a && a.name === b.name && a.owner === b.owner && a.slot === b.slot && a.args === b.args &&
    a.result === b.result && a.output === b.output && a.status === b.status && a.duration === b.duration && a.argumentText === b.argumentText;
}
function combineParts(id: string, parts: ToolPart[]): JoinedTool | undefined {
    let tool: JoinedTool | undefined; let called = false;
    for (const item of parts) {
      const part = item.part;
      tool ??= {callId: id, name: part.name, owner: item.owner, slot: item.slot, status: 'working'};
      tool.name = part.name;
      if (part.type === 'toolCall') { tool.args = part.arguments; if (!called) { tool.owner = item.owner; tool.slot = item.slot; called = true; } }
      else { tool.result = part.parts; tool.output = part.output; tool.status = part.isError ? 'error' : 'success'; }
    }
  return tool;
}
function applyState(tool: JoinedTool, state: ToolState | undefined): void {
  if (!state) return;
  tool.args = state.arguments ?? tool.args; tool.argumentText = state.argumentText; tool.result = state.parts ?? tool.result; tool.duration = state.durationMs;
  tool.output = state.output ?? tool.output;
  tool.status = state.phase !== 'end' ? 'working' : state.isError ? 'error' : 'success';
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
function sessionEvent(entry: EntryView): boolean { return entry.kind !== 'message' && !entry.messages?.length; }
function sessionGroup(old: SessionGroup | undefined, id: string, members: EntryView[]): SessionGroup {
  if (old && old.entries.length === members.length && old.entries.every((entry, index) => entry === members[index])) return old;
  return {id, entries: members, notices: members.filter(actionableEntry)};
}
/** Entry identity checks do not inspect unchanged message parts. */
export class TranscriptIndex {
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
  update(entries: readonly EntryView[], states: ReadonlyMap<string, ToolState>, isVisible: (entry: EntryView) => boolean = () => true): void {
    this.changed.clear();
    const touched = new Set<string>(); const ids = new Set<string>(); let reordered = false;
    entries.forEach((entry, index) => {
      ids.add(entry.id); if (this.order.get(entry.id) !== index) reordered = true;
      this.order.set(entry.id, index);
      if (this.entries.get(entry.id) === entry) return;
      this.remove(entry.id, touched); this.entries.set(entry.id, entry); this.changed.add(entry.id);
      const parts: EntryParts = {tools: [], thinking: []};
      for (const message of entry.messages ?? []) message.parts.forEach((part, at) => {
        if (part.type === 'thinking') parts.thinking.push(`thinking:${entry.id}:${message.id}:${at}`);
        if (part.type === 'toolCall' || part.type === 'toolResult') parts.tools.push({part, owner: entry.id, slot: slot(entry.id, message.id, at), sequence: parts.tools.length});
      });
      this.parts.set(entry.id, parts);
      for (const id of parts.thinking) this.disclosures.set(id, entry.id);
      for (const item of parts.tools) {
        const id = item.part.callId; touched.add(id);
        let owners = this.calls.get(id); if (!owners) { owners = new Map(); this.calls.set(id, owners); }
        const group = owners.get(entry.id) ?? []; group.push(item); owners.set(entry.id, group);
      }
    });
    for (const id of this.entries.keys()) if (!ids.has(id)) { this.remove(id, touched); this.entries.delete(id); this.order.delete(id); this.visibility.delete(id); this.changed.add(id); }
    if (reordered) for (const id of this.calls.keys()) touched.add(id);
    for (const [id, state] of states) if (this.states.get(id) !== state) touched.add(id);
    for (const id of this.states.keys()) if (!states.has(id)) touched.add(id);
    this.states = states;
    for (const id of touched) this.rebuild(id);
    this.groupSessions(entries, isVisible);
  }
  private groupSessions(entries: readonly EntryView[], isVisible: (entry: EntryView) => boolean): void {
    const visible = entries.filter(entry => {
      const shown = isVisible(entry);
      if (this.visibility.get(entry.id) !== shown) this.changed.add(entry.id);
      this.visibility.set(entry.id, shown); return shown;
    });
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
  private remove(id: string, touched: Set<string>): void {
    const previous = this.parts.get(id); if (!previous) return;
    for (const disclosure of previous.thinking) this.disclosures.delete(disclosure);
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
    if (!tool) { this.joined.delete(id); this.disclosures.delete(`tool:${id}`); return; }
    this.joined.set(id, tool); this.disclosures.set(`tool:${id}`, tool.owner); this.changed.add(tool.owner);
  }
}
