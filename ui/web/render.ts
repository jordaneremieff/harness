import type { EntryView, JsonDisplay, MessageView, PartView, PresentationView, ReadingView } from '../shared/api.ts';
import { byId, button, copy, element, rawText, setText } from './dom.ts';
import { markdownDom } from './safe-markdown.ts';
import { setIcon } from './icons.ts';
import type { ToolState } from './state.ts';
import { absoluteTime, previewText, relativeTime, timestampDetails } from './format.ts';
import { entryVisible, presentEntry, presentMessage } from './entry-presentation.ts';
import { presentTool } from './cards.ts';
import { TranscriptIndex, slot } from './transcript-tools.ts';
import type { JoinedTool } from './transcript-tools.ts';
import { outputPages } from './transcript-output.ts';
import type { OutputContinuation, OutputPage } from '../shared/api.ts';
import { captureAnchor, layoutItems, restoreAnchor, visibleWindow, updateHeights } from './virtual.ts';
import type { LayoutItem, VirtualLayout } from './virtual.ts';

export type ViewHooks = {presentation: (expanded: string[], showThinking: boolean) => void; reading: (anchor: ReadingView) => void; fork?: (message: MessageView, entryId: string) => void; output?: (more: OutputContinuation) => Promise<OutputPage>};
const RAW_LIMIT = 65536;
function partText(parts: PartView[]): string {
  return parts.map(part => {
    if (part.type === 'text' || part.type === 'thinking') return part.redacted ? 'Thinking omitted by host' : part.text;
    if (part.type === 'omitted') return part.label;
    return part.type === 'toolResult' ? partText(part.parts) : '';
  }).join('\n');
}
function bounded(text: string, limit = RAW_LIMIT): string {
  const value = previewText(text, Number.MAX_SAFE_INTEGER, limit);
  return value.text + (value.truncated ? '\nDisplay limited to retained preview.' : '');
}
function record(display?: JsonDisplay): Record<string, unknown> {
  const value = display?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function subject(display?: JsonDisplay): string {
  const args = record(display);
  for (const key of ['path', 'file_path', 'command', 'sessionId', 'target', 'name', 'code']) {
    if (typeof args[key] === 'string') return previewText(args[key], 1, 4096).text;
  }
  return '';
}
function metadata(display?: JsonDisplay): string {
  const args = record(display); const facts: string[] = [];
  for (const key of ['cwd', 'offset', 'limit']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number') facts.push(`${key} ${bounded(String(value), 4096)}`);
  }
  return facts.join(' · ');
}
function timestamp(time: number): HTMLButtonElement {
  const node = button(relativeTime(time, Date.now()), () => {
    const absolute = node.dataset.absolute === 'true'; node.dataset.absolute = String(!absolute);
    setText(node, absolute ? relativeTime(time, Date.now()) : absoluteTime(time));
  }, 'timestamp');
  const details = timestampDetails(time); node.title = `${details.exact} · ${details.display}`;
  return node;
}
function inspection(title: string, source: () => string): HTMLDetailsElement {
  const node = element('details'); const pre = element('pre');
  node.append(element('summary', undefined, title));
  node.addEventListener('toggle', () => {
    if (!node.open) return;
    setText(pre, bounded(source()));
    if (!pre.parentNode) node.append(pre);
  });
  return node;
}
export function structured(display: JsonDisplay): HTMLElement {
  const node = element('div', 'structured'); const value = display.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) node.append(structuredObject(value as Record<string, unknown>));
  else node.append(element('pre', undefined, bounded(rawText(value), 8192)));
  node.append(inspection('Retained structured data (bounded)', () => rawText(value)));
  if (display.truncated) node.append(element('p', 'warning', `Output omitted by host${display.omittedBytes !== undefined ? ` · ${display.omittedBytes} bytes` : ''}`));
  return node;
}
function structuredObject(value: Record<string, unknown>): HTMLElement {
  const node = element('div'); const grid = element('dl', 'kv'); node.append(grid);
  let bytes = 0; let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (++count > 64 || bytes >= 8192) { node.append(element('p', 'secondary', 'Initial structured preview limited.')); break; }
    const label = bounded(key, 512);
    if (item !== null && typeof item === 'object') node.append(inspection(label, () => rawText(item)));
    else {
      const text = bounded(rawText(item), Math.max(0, 8192 - bytes)); bytes += text.length + label.length;
      grid.append(element('dt', undefined, label), element('dd', undefined, text));
    }
  }
  return node;
}
export function reconcileChildren(parent: HTMLElement, wanted: HTMLElement[]): void {
  const keep = new Set(wanted);
  for (const child of [...parent.children]) if (!keep.has(child as HTMLElement)) child.remove();
  let previous: HTMLElement | undefined;
  for (const child of wanted) {
    const next = previous ? previous.nextSibling : parent.firstChild;
    if (next !== child) { if (previous) previous.after(child); else parent.prepend(child); }
    previous = child;
  }
}
type PartNode = {node: HTMLElement; source: PartView; partial: boolean};
type MessageNode = {node: HTMLElement; header: HTMLElement; body: HTMLElement; error: HTMLElement; parts: Map<string, PartNode>; source: MessageView; time?: number; fork?: HTMLButtonElement};
type EntryNode = {node: HTMLElement; messages: Map<string, MessageNode>; source?: EntryView; custom?: HTMLElement};
type ToolNode = {card: HTMLElement; node: HTMLDetailsElement; copy: HTMLButtonElement; title: HTMLElement; target: HTMLElement; glyph: HTMLElement; meta: HTMLElement; preview: HTMLElement; expanded: HTMLElement; source?: JoinedTool; presentation?: HTMLElement; output?: HTMLElement; contentSource?: JoinedTool};
export class Transcript {
  private entries: EntryView[] = [];
  private displayed: EntryView[] = [];
  private cache = new Map<string, EntryNode>();
  private tools = new Map<string, ToolNode>();
  private index = new TranscriptIndex();
  private joined = this.index.joined;
  private visible = new Map<string, boolean>();
  private dirtyLayout = true;
  private generation = 0;
  private expanded = new Set<string>();
  private showThinking = false;
  private follow = true;
  private readingRevision = 0;
  private pending = false;
  private pins = new Set<string>();
  private heights = new Map<string, number>();
  private gaps = new Map<string, HTMLElement>();
  private layout: VirtualLayout = layoutItems([], new Map(), 140);
  private restoring?: ReadingView;
  readonly node: HTMLElement;
  readonly prefix: 'primary' | 'agent';
  private hooks: ViewHooks;
  constructor(prefix: 'primary' | 'agent', hooks: ViewHooks) {
    this.prefix = prefix; this.hooks = hooks;
    this.node = byId(`${prefix}-transcript`);
    this.node.addEventListener('scroll', () => {
      if (this.hidden()) return;
      this.follow = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 48 && !this.hasSelection();
      byId(`${prefix}-latest`).hidden = this.follow; this.schedule();
    }, {passive: true});
    this.node.addEventListener('scrollend', () => this.saveReading());
    byId(`${prefix}-latest`).addEventListener('click', () => { this.follow = true; this.pins.clear(); this.paint(); });
    document.addEventListener('selectionchange', () => { if (!this.hidden() && this.hasSelection()) { this.follow = false; this.schedule(); } });
  }
  private hidden(): boolean { return this.node.closest<HTMLElement>('.conversation')?.hidden === true; }
  private hasSelection(): boolean {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed && (this.node.contains(selection.anchorNode) || this.node.contains(selection.focusNode));
  }
  configure(presentation?: PresentationView, reading?: ReadingView): void {
    this.expanded = new Set(presentation?.expanded ?? []); this.showThinking = presentation?.showThinking ?? false;
    if (reading) { this.follow = reading.followTail; this.readingRevision = reading.revision; this.restoring = reading.followTail ? undefined : reading; }
    this.applyPreferences();
  }
  reset(): void {
    this.generation++; this.entries = []; this.displayed = []; this.cache.clear(); this.tools.clear(); this.index = new TranscriptIndex(); this.joined = this.index.joined; this.visible.clear(); this.dirtyLayout = true; this.pins.clear(); this.heights.clear(); this.gaps.clear();
    this.expanded.clear(); this.showThinking = false; this.follow = true; this.readingRevision = 0;
    this.layout = layoutItems([], this.heights, 140); this.restoring = undefined; this.node.replaceChildren(); this.node.scrollTop = 0;
  }
  set(entries: EntryView[], tools: ReadonlyMap<string, ToolState> = new Map()): void {
    this.entries = entries; this.index.update(entries, tools);
    for (const id of this.index.changed) {
      const entry = this.index.entries.get(id);
      if (entry) this.visible.set(id, this.visibleEntry(entry)); else this.visible.delete(id);
    }
    const displayed = entries.filter(entry => this.visible.get(entry.id));
    if (displayed.length !== this.displayed.length || displayed.some((entry, at) => entry.id !== this.displayed[at]?.id)) this.dirtyLayout = true;
    this.displayed = displayed; this.prune(); this.schedule();
  }
  restore(reading?: ReadingView): void {
    if (this.hidden() || !reading || reading.followTail) return;
    this.follow = false; this.restoring = reading; this.schedule();
  }
  schedule(): void {
    if (this.pending) return; this.pending = true; const start = performance.now();
    requestAnimationFrame(() => {
      this.pending = false; this.paint();
      performance.measure('ui:stream-receive-to-paint', {start, end: performance.now()});
    });
  }
  private anchor(): {id: string; offsetPx: number} | null {
    for (const child of this.node.children) {
      const node = child as HTMLElement;
      const top = node.offsetTop - this.node.offsetTop;
      if (node.dataset.entryId && top <= this.node.scrollTop && top + node.offsetHeight > this.node.scrollTop) {
        return {id: node.dataset.entryId, offsetPx: this.node.scrollTop - (node.offsetTop - this.node.offsetTop)};
      }
    }
    return captureAnchor(this.layout, this.node.scrollTop);
  }
  private saveReading(): void {
    if (this.hidden()) return;
    const anchor = this.anchor();
    this.hooks.reading({revision: this.readingRevision, anchorId: anchor?.id ?? null, offsetPx: anchor?.offsetPx ?? 0, followTail: this.follow});
  }
  private paint(): void {
    if (this.hidden()) return;
    const anchor = this.follow ? null : this.anchor();
    if (this.dirtyLayout) { this.layout = layoutItems(this.displayed.map(entry => entry.id), this.heights, 140); this.dirtyLayout = false; }
    const scrollTop = this.prepareScroll();
    const pins = this.currentPins(); if (anchor) pins.add(anchor.id);
    const selected = visibleWindow(this.layout, scrollTop, this.node.clientHeight, {pins}).items;
    reconcileChildren(this.node, this.children(selected));
    this.measure(selected);
    this.refreshGaps(selected);
    this.evict(new Set(selected.map(item => item.id)));
    if (this.follow && !this.hasSelection()) this.node.scrollTop = this.node.scrollHeight;
    else this.restorePosition(anchor);
    byId(`${this.prefix}-latest`).hidden = this.follow;
  }
  private prepareScroll(): number {
    if (this.restoring) return restoreAnchor(this.layout, this.readingAnchor(), this.node.clientHeight);
    return this.follow ? Math.max(0, this.layout.totalHeight - this.node.clientHeight) : this.node.scrollTop;
  }
  private readingAnchor(): {id: string; offsetPx: number} | null {
    const value = this.restoring;
    return value?.anchorId ? {id: this.displayId(value.anchorId), offsetPx: value.offsetPx} : null;
  }
  private restorePosition(anchor: {id: string; offsetPx: number} | null): void {
    const wanted = this.readingAnchor() ?? anchor;
    const node = wanted && this.cache.get(wanted.id)?.node;
    const item = wanted && this.layout.byId.get(wanted.id);
    if (node?.isConnected && wanted && item) {
      const position = restoreAnchor(this.layout, wanted, 0);
      this.node.scrollTop = node.offsetTop - this.node.offsetTop + position - item.top;
    }
    if (this.restoring && node?.isConnected) this.restoring = undefined;
  }
  private currentPins(): Set<string> {
    const pins = new Set(this.pins); const selection = document.getSelection();
    for (const [id, entry] of this.cache) {
      if (entry.node.contains(document.activeElement) || entry.node.contains(selection?.anchorNode ?? null) || entry.node.contains(selection?.focusNode ?? null)) pins.add(id);
      if ([...entry.node.querySelectorAll<HTMLDetailsElement>('details[open]')].some(node => !node.dataset.disclosure)) pins.add(id);
    }
    if (this.restoring?.anchorId) pins.add(this.restoring.anchorId);
    return pins;
  }
  private gap(key: string, height: number): HTMLElement {
    let node = this.gaps.get(key);
    if (!node) { node = element('div', 'spacer'); node.setAttribute('aria-hidden', 'true'); this.gaps.set(key, node); }
    node.style.height = `${height}px`; return node;
  }
  private children(items: LayoutItem[]): HTMLElement[] {
    const children: HTMLElement[] = []; let offset = 0;
    for (const item of items) {
      if (item.top > offset) children.push(this.gap(item.id, item.top - offset));
      const entry = this.displayed[item.index]; if (!entry) continue;
      children.push(this.updateEntry(entry)); offset = item.bottom;
    }
    if (offset < this.layout.totalHeight) children.push(this.gap('tail', this.layout.totalHeight - offset));
    const keep = new Set(children); for (const [key, node] of this.gaps) if (!keep.has(node)) this.gaps.delete(key);
    return children;
  }
  private refreshGaps(items: LayoutItem[]): void {
    let offset = 0;
    for (const old of items) {
      const item = this.layout.byId.get(old.id); if (!item) continue;
      const gap = this.gaps.get(item.id); if (gap) gap.style.height = `${Math.max(0, item.top - offset)}px`;
      offset = item.bottom;
    }
    const tail = this.gaps.get('tail'); if (tail) tail.style.height = `${Math.max(0, this.layout.totalHeight - offset)}px`;
  }
  private measure(items: LayoutItem[]): void {
    const measurements = new Map<string, number>();
    for (const item of items) {
      const height = this.cache.get(item.id)?.node.offsetHeight;
      if (height && height > 0 && this.heights.get(item.id) !== height) { this.heights.set(item.id, height); measurements.set(item.id, height); }
    }
    updateHeights(this.layout, measurements);
  }
  private prune(): void {
    for (const [id, entry] of this.cache) if (!this.index.entries.has(id)) { entry.node.remove(); this.cache.delete(id); this.pins.delete(id); }
    for (const id of this.index.changed) if (!this.index.entries.has(id)) this.heights.delete(id);
    for (const [id, tool] of this.tools) if (!this.joined.has(id)) { tool.card.remove(); this.tools.delete(id); }
  }
  private evict(mounted: ReadonlySet<string>): void {
    const offscreen = [...this.cache.keys()].filter(id => !mounted.has(id));
    for (const id of offscreen.slice(0, Math.max(0, offscreen.length - 32))) this.cache.delete(id);
    for (const [id, tool] of this.tools) {
      const owner = this.joined.get(id)?.owner;
      if (!owner || !this.cache.has(owner)) { tool.card.remove(); this.tools.delete(id); }
    }
  }
  private updateEntry(entry: EntryView): HTMLElement {
    let cached = this.cache.get(entry.id);
    if (!cached) {
      const node = element('div', 'entry'); node.dataset.entryId = entry.id; node.style.display = 'flow-root';
      cached = {node, messages: new Map()}; this.cache.set(entry.id, cached);
    }
    this.updateCustom(cached, entry);
    const children: HTMLElement[] = cached.custom ? [cached.custom] : [];
    const ids = new Set<string>();
    for (const message of entry.messages ?? []) {
      if (!presentMessage(message).visible || this.joinedMessage(entry.id, message)) continue;
      ids.add(message.id); children.push(this.updateMessage(cached, message, entry).node);
    }
    for (const id of cached.messages.keys()) if (!ids.has(id)) cached.messages.delete(id);
    reconcileChildren(cached.node, children); cached.source = entry; return cached.node;
  }
  private joinedMessage(entryId: string, message: MessageView): boolean {
    if (message.error || !message.parts.length) return false;
    return message.parts.every((part, index) => {
      if (part.type !== 'toolResult') return false;
      const tool = this.joined.get(part.callId);
      return !!tool && tool.slot !== slot(entryId, message.id, index);
    });
  }
  private visibleEntry(entry: EntryView): boolean {
    if (!entryVisible(entry)) return false;
    if (entry.data || !entry.messages?.length) return true;
    return entry.messages.some(message => presentMessage(message).visible && !this.joinedMessage(entry.id, message));
  }
  private displayId(id: string): string {
    if (this.visible.get(id)) return id;
    const entry = this.index.entries.get(id);
    for (const message of entry?.messages ?? []) for (const part of message.parts) {
      if (part.type === 'toolResult') return this.joined.get(part.callId)?.owner ?? id;
    }
    return id;
  }
  private updateCustom(cached: EntryNode, entry: EntryView): void {
    if (!entry.data && entry.messages?.length) { cached.custom = undefined; return; }
    if (cached.source === entry) return;
    if (cached.source?.data !== entry.data || cached.source?.head !== entry.head || !cached.custom) cached.custom = presentEntry(entry, {bounded, rawText, inspection, structured});
  }
  private createMessage(entry: EntryNode, message: MessageView): MessageNode {
    const node = element('article', `message ${message.role === 'user' ? 'user' : ''}`);
    const header = element('header', 'message-header'); const body = element('div', 'message-body'); const error = element('p', 'error message-error'); error.hidden = true;
    const role = presentMessage(message).label;
    header.append(element('span', 'sr-only', bounded(role, 4096)));
    header.append(button('Copy', () => { void copy(partText(entry.messages.get(message.id)?.source.parts ?? []), node); }, 'copy'));
    node.append(header, body, error);
    const cached = {node, header, body, error, parts: new Map<string, PartNode>(), source: message}; entry.messages.set(message.id, cached); return cached;
  }
  private updateMessage(entry: EntryNode, message: MessageView, retained: EntryView): MessageNode {
    const entryId = retained.id;
    const cached = entry.messages.get(message.id) ?? this.createMessage(entry, message);
    this.updateFork(cached, retained, message);
    this.updateTime(cached, message.timestamp);
    const children: HTMLElement[] = []; const keys = new Set<string>();
    message.parts.forEach((part, index) => {
      const key = `${index}:${part.type}`; keys.add(key);
      const node = this.updatePart(cached, part, index, message.state === 'partial', entryId);
      if (node) children.push(node);
    });
    for (const key of cached.parts.keys()) if (!keys.has(key)) cached.parts.delete(key);
    if (message.coverage.truncated || message.coverage.omitted > 0 || !message.coverage.complete) {
      const reason = previewText(message.coverage.reason ?? '', 6, 4096).text.trim();
      children.push(element('p', 'secondary', reason || 'Message content is not fully displayed.'));
    }
    reconcileChildren(cached.body, children); setText(cached.error, bounded(message.error ?? '')); cached.error.hidden = !message.error;
    cached.source = message; return cached;
  }
  private updateFork(cached: MessageNode, entry: EntryView, message: MessageView): void {
    const retained = entry.kind === 'message' && !entry.id.startsWith('message:') && !entry.id.startsWith('live:');
    const eligible = retained && message.role === 'user' && message.state === 'final' && !!this.hooks.fork;
    if (!eligible) { cached.fork?.remove(); cached.fork = undefined; return; }
    if (cached.fork) return;
    cached.fork = button('Fork', () => this.hooks.fork?.(cached.source, entry.id), 'copy'); cached.header.append(cached.fork);
  }
  private updateTime(message: MessageNode, time?: number): void {
    if (message.time === time) return;
    message.header.querySelector('.timestamp')?.remove();
    if (time !== undefined && relativeTime(time, Date.now())) message.header.append(timestamp(time)); message.time = time;
  }
  private updatePart(message: MessageNode, part: PartView, index: number, partial: boolean, entryId: string): HTMLElement | undefined {
    if (part.type === 'toolCall' || part.type === 'toolResult') {
      const tool = this.joined.get(part.callId);
      return tool?.slot === slot(entryId, message.source.id, index) ? this.updateTool(tool) : undefined;
    }
    const key = `${index}:${part.type}`; const previous = message.parts.get(key);
    if (previous?.source === part && previous.partial === partial) return previous.node;
    const node = previous?.node ?? this.createPart(part, entryId, message.source.id, index);
    node.querySelector('.output-pages')?.remove();
    this.partContent(node, part, partial, previous);
    if ((part.type === 'text' || part.type === 'thinking') && part.more) {
      const source = part; const generation = this.generation;
      node.append(outputPages(part.more, this.hooks.output, () => generation === this.generation && message.parts.get(key)?.source === source, () => this.schedule()));
    }
    message.parts.set(key, {node, source: part, partial}); return node;
  }
  private createPart(part: PartView, entryId: string, messageId: string, index: number): HTMLElement {
    if (part.type !== 'thinking') return element('div');
    const node = element('details', 'thinking'); const id = `thinking:${entryId}:${messageId}:${index}`;
    node.dataset.disclosure = id; node.open = this.showThinking || this.expanded.has(id);
    node.append(element('summary', undefined, 'Thinking'), element('div', 'stream-text'));
    this.trackDisclosure(node, id); return node;
  }
  private partContent(node: HTMLElement, part: PartView, partial: boolean, previous?: PartNode): void {
    if (part.type === 'text') {
      this.textContent(node, part.text, partial, previous);
    } else if (part.type === 'thinking') {
      const content = node.querySelector('.stream-text'); if (content) setText(content, part.redacted ? 'Thinking omitted by host' : bounded(part.text));
    } else if (part.type === 'omitted') { node.className = 'secondary'; setText(node, bounded(part.label)); }
  }
  private textContent(node: HTMLElement, text: string, partial: boolean, previous?: PartNode): void {
    if (previous?.source.type === 'text' && previous.source.text === text && previous.partial === partial) return;
    node.className = partial ? 'stream-text' : '';
    if (partial) setText(node, bounded(text, 8192)); else if (text.length > 8192) node.replaceChildren(markdownDom(bounded(text, 8192)), inspection('Retained text (bounded)', () => text));
    else node.replaceChildren(markdownDom(text));
  }
  private createTool(source: JoinedTool): ToolNode {
    const card = element('div', 'tool-shell'); const node = element('details', 'tool-card'); card.append(node); const summary = element('summary');
    const tier = element('span', 'tool-tier'); const glyph = element('span', 'tool-status'); glyph.setAttribute('role', 'img');
    const title = element('span', 'tool-name'); const target = element('span', 'tool-target'); const meta = element('span', 'tool-secondary');
    tier.append(glyph, title, target, meta); summary.append(tier);
    const preview = element('div', 'tool-preview'); const expanded = element('div', 'tool-expanded'); summary.append(preview); node.append(summary, expanded);
    node.dataset.disclosure = `tool:${source.callId}`; node.open = this.expanded.has(`tool:${source.callId}`);
    const action = button('', () => { void copy(tool.source?.result ? partText(tool.source.result) : '', tool.card).then(copied => { if (copied) { setIcon(action, 'check'); action.title = 'Copied'; } }); }, 'quiet tool-copy');
    setIcon(action, 'copy');
    action.setAttribute('aria-label', 'Copy tool output'); action.title = 'Copy tool output';
    action.addEventListener('click', event => event.stopPropagation());
    action.addEventListener('blur', () => { setIcon(action, 'copy'); action.title = 'Copy tool output'; }); card.append(action);
    const tool: ToolNode = {card, node, copy: action, title, target, glyph, meta, preview, expanded}; this.tools.set(source.callId, tool);
    this.trackDisclosure(node, `tool:${source.callId}`);
    node.addEventListener('toggle', () => this.toolExpansion(tool)); return tool;
  }
  private updateTool(source: JoinedTool): HTMLElement {
    const tool = this.tools.get(source.callId) ?? this.createTool(source);
    const previous = tool.source; tool.source = source;
    if (previous === source) return tool.card;
    setText(tool.title, source.name); setText(tool.target, subject(source.args)); tool.target.hidden = !tool.target.textContent;
    setText(tool.glyph, source.status === 'success' ? '✓' : source.status === 'error' ? '!' : '●');
    tool.glyph.className = `tool-status ${source.status}`; tool.glyph.setAttribute('aria-label', source.status);
    setText(tool.meta, [metadata(source.args), source.duration !== undefined && source.status !== 'working' ? `${source.duration} ms` : ''].filter(Boolean).join(' · '));
    tool.meta.hidden = !tool.meta.textContent; tool.copy.hidden = !source.result;
    const changed = previous?.args !== source.args || previous?.result !== source.result || previous?.argumentText !== source.argumentText || previous?.status !== source.status;
    if (changed) this.toolContent(tool);
    tool.preview.hidden = tool.node.open; tool.expanded.hidden = !tool.node.open; return tool.card;
  }
  private toolContent(tool: ToolNode): void {
    const source = tool.source; if (!source) return;
    const output = source.result ? partText(source.result) : '';
    const args = source.argumentText ?? (source.args ? rawText(source.args.value) : '');
    const preview = previewText(output || args, 5, 1800);
    setText(tool.preview, `${preview.text}${preview.truncated ? '\n…' : ''}`);
    if (tool.node.open) this.expandTool(tool);
  }
  private toolExpansion(tool: ToolNode): void {
    tool.preview.hidden = tool.node.open; tool.expanded.hidden = !tool.node.open;
    if (tool.node.open) this.expandTool(tool);
  }
  private toolArguments(tool: ToolNode): string {
    const source = tool.source; if (!source) return '';
    return source.args ? `${rawText(source.args.value)}${source.args.truncated ? '\nArguments omitted by host' : ''}` : source.argumentText ?? '';
  }
  private presentToolRegion(tool: ToolNode, source: JoinedTool): void {
    const region = presentTool(source, {bounded, rawText, inspection, structured});
    const previous = tool.contentSource;
    if (previous?.args === source.args && previous?.name === source.name && tool.presentation && region) {
      const heading = tool.presentation.querySelector('.tool-caption');
      if (heading) setText(heading, region.querySelector('.tool-caption')?.textContent ?? '');
      return;
    }
    tool.presentation?.remove(); tool.presentation = region;
    if (region) tool.expanded.prepend(region);
  }
  private expandedContent(tool: ToolNode, source: JoinedTool): void {
    if (tool.contentSource === source) return;
    if (tool.contentSource?.args !== source.args || tool.contentSource?.name !== source.name || tool.contentSource?.status !== source.status) {
      this.presentToolRegion(tool, source);
    }
    if (tool.contentSource?.result !== source.result) {
      tool.output?.remove(); tool.output = element('div');
      const generation = this.generation;
      const append = (parts: PartView[]) => { for (const part of parts) {
        if (part.type === 'toolResult') append(part.parts);
        else if ((part.type === 'text' || part.type === 'thinking') && part.more) tool.output?.append(outputPages(part.more, this.hooks.output, () => generation === this.generation && this.tools.get(source.callId) === tool && tool.source?.result === source.result, () => this.schedule()));
      } };
      append(source.result ?? []); tool.expanded.append(tool.output);
    }
    tool.contentSource = source;
  }
  private expandTool(tool: ToolNode): void {
    const source = tool.source; if (!source) return;
    const output = source.result ? partText(source.result) : '';
    this.expandedContent(tool, source);
    let pre = tool.expanded.querySelector('.tool-output-text');
    if (!pre) {
      pre = element('pre', 'tool-output-text'); tool.expanded.append(element('span', 'secondary', 'Output'), pre,
        inspection('Arguments', () => this.toolArguments(tool)),
        inspection('Raw result', () => rawText(tool.source?.result ?? [])));
      for (const node of tool.expanded.querySelectorAll('details')) node.className = 'tool-inspection';
    }
    setText(pre, bounded(output || (source.status === 'working' ? 'Working' : 'Returned successfully')));
    this.refreshToolInspections(tool, source);
  }
  private refreshToolInspections(tool: ToolNode, source: JoinedTool): void {
    for (const node of tool.expanded.querySelectorAll<HTMLDetailsElement>('details[open]')) {
      const title = node.firstElementChild?.textContent;
      if (title !== 'Arguments' && title !== 'Raw result') continue;
      const data = node.querySelector('pre'); if (data) setText(data, title === 'Arguments' ? bounded(this.toolArguments(tool)) : bounded(rawText(source.result ?? [])));
    }
  }
  private trackDisclosure(node: HTMLDetailsElement, id: string): void {
    node.querySelector('summary')?.addEventListener('click', event => {
      if (this.hasSelection() || event.detail > 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) event.preventDefault();
    });
    node.addEventListener('toggle', () => {
      const expected = this.expanded.has(id) || (id.startsWith('thinking:') && this.showThinking);
      if (node.open === expected) return;
      this.follow = false;
      if (node.open) this.expanded.add(id); else this.expanded.delete(id);
      if (!node.open && id.startsWith('thinking:') && this.showThinking) this.closeThinkingPreference(id);
      this.hooks.presentation([...this.expanded], this.showThinking); this.schedule();
    });
  }
  private closeThinkingPreference(excluded: string): void {
    for (const entry of this.cache.values()) for (const node of entry.node.querySelectorAll<HTMLDetailsElement>('.thinking')) {
      const id = node.dataset.disclosure;
      if (node.open && id && id !== excluded) this.expanded.add(id);
    }
    this.showThinking = false;
  }
  private applyPreferences(): void {
    for (const entry of this.cache.values()) for (const node of entry.node.querySelectorAll<HTMLDetailsElement>('[data-disclosure]')) {
      const id = node.dataset.disclosure ?? ''; node.open = this.expanded.has(id) || (id.startsWith('thinking:') && this.showThinking);
    }
  }
  expandLoaded(tools: boolean, expanded: boolean): void {
    if (!tools) this.showThinking = expanded;
    for (const id of this.loadedDisclosures(tools)) {
      if (expanded) this.expanded.add(id); else this.expanded.delete(id);
    }
    this.applyPreferences();
    this.follow = false; this.hooks.presentation([...this.expanded], this.showThinking); this.schedule();
  }
  private loadedDisclosures(tools: boolean): string[] {
    return [...this.index.disclosures.keys()].filter(id => id.startsWith(tools ? 'tool:' : 'thinking:'));
  }
  find(query: string): void {
    if (!query.trim()) return;
    const entry = this.entries.find(item => rawText(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (!entry) return;
    const id = this.displayId(entry.id);
    this.follow = false; this.pins.clear(); this.pins.add(id);
    this.restoring = {revision: this.readingRevision, anchorId: id, offsetPx: 0, followTail: false}; this.paint();
    const node = this.cache.get(id)?.node;
    if (node) { node.tabIndex = -1; node.focus({preventScroll: true}); }
  }
}
