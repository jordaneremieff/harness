import type { EntryView, ImageView, JsonDisplay, MessageView, PartView, PresentationView, ReadingView } from '../shared/api.ts';
import { byId, button, copy, element, rawText, setText } from './dom.ts';
import { contextMenu, nativeEditingTarget, type ContextItem } from './context-menu.ts';
import { markdownDom } from './safe-markdown.ts';
import { highlight, languageFromPath } from './highlight.ts';
import { transcriptImage } from './image.ts';
import type { ToolState } from './state.ts';
import { absoluteTime, previewText, relativeTime, timestampDetails } from './format.ts';
import { entryVisible, presentEntry, presentMessage } from './entry-presentation.ts';
import { compactRead, presentTool, presentToolPreview, readRange } from './cards.ts';
import { TranscriptIndex, slot } from './transcript-tools.ts';
import type { JoinedTool } from './transcript-tools.ts';
import { outputPages } from './transcript-output.ts';
import { appendKey, presentArguments, presentResult, PreviewBudget } from './generic-content.ts';
import type { SessionGroup } from './transcript-tools.ts';
import type { OutputContinuation, OutputPage } from '../shared/api.ts';
import { captureAnchor, layoutItems, restoreAnchor, visibleWindow, updateHeights } from './virtual.ts';
import type { LayoutItem, VirtualLayout } from './virtual.ts';

export type ViewHooks = {presentation: (expanded: string[], showThinking: boolean) => void; reading: (anchor: ReadingView) => void; fork?: (message: MessageView, entryId: string) => void; output?: (more: OutputContinuation) => Promise<OutputPage>; image?: (part: ImageView) => string | undefined};
const RAW_LIMIT = 65536;
function selectionCopy(origin: HTMLElement): ContextItem[] {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !origin.contains(selection.anchorNode) || !origin.contains(selection.focusNode)) return [];
  const selectedText = selection.toString();
  return [{label: 'Copy selection', run: () => { void copy(selectedText, origin); }}];
}
function menuText(tool?: ToolNode, message?: MessageNode, entry?: EntryNode): string {
  if (tool?.source) return partText(tool.source.result ?? []);
  if (message?.source) return partText(message.source.parts);
  return rawText(entry?.source?.data?.value ?? entry?.source);
}
function partText(parts: PartView[]): string {
  return parts.map(part => {
    if (part.type === 'text' || part.type === 'thinking') return part.redacted ? 'Thinking omitted by host' : part.text;
    if (part.type === 'omitted') return part.label;
    if (part.type === 'image') return part.alt;
    return part.type === 'toolResult' ? partText(part.parts) : '';
  }).join('\n');
}
function hasStructuredResult(parts: readonly PartView[]): boolean {
  return parts.some(part => part.type === 'text' ? !!part.structured : part.type === 'toolResult' && hasStructuredResult(part.parts));
}
function imageParts(parts: readonly PartView[], images: ImageView[] = []): ImageView[] {
  for (const part of parts) {
    if (part.type === 'image') images.push(part);
    else if (part.type === 'toolResult') imageParts(part.parts, images);
  }
  return images;
}
function bounded(text: string, limit = RAW_LIMIT, lines = Number.MAX_SAFE_INTEGER): string {
  const value = previewText(text, lines, limit);
  const shown = value.truncated && value.text.length >= limit ? previewText(value.text, lines, Math.max(0, limit - 1)).text : value.text;
  return shown + (value.truncated ? '…' : '');
}
function record(display?: JsonDisplay): Record<string, unknown> {
  const value = display?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function subject(source: JoinedTool): string {
  const args = record(source.args);
  if (source.name === 'bash' && typeof args.command === 'string') return `$ ${bounded(args.command, 4096, 1)}`;
  const path = args.file_path ?? args.path;
  if (source.name === 'read' && typeof path === 'string') return bounded(path, 4096, 1);
  for (const key of ['path', 'file_path', 'command', 'sessionId', 'target', 'name', 'code']) {
    if (typeof args[key] === 'string') return bounded(args[key], 4096, 1);
  }
  return '';
}
function metadata(source: JoinedTool): string {
  const args = record(source.args); const facts: string[] = [];
  const range = source.name === 'read' ? readRange(args) : '';
  if (range) facts.push(range);
  if (source.name === 'bash' && typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout >= 0) facts.push(`(timeout ${args.timeout}s)`);
  for (const key of range ? ['cwd'] : ['cwd', 'offset', 'limit']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number') facts.push(`${key} ${bounded(String(value), 4096)}`);
  }
  return facts.join(' · ');
}
function truncationFacts(name: string, cut: NonNullable<NonNullable<JoinedTool['output']>['truncation']>): string[] {
  const facts = [name === 'read' ? 'Selected output truncated' : 'Output truncated'];
  if (cut.truncatedBy) facts.push(`${cut.truncatedBy === 'lines' ? 'line' : 'byte'} limit`);
  if (cut.outputLines !== undefined && cut.totalLines !== undefined) facts.push(`${cut.outputLines}/${cut.totalLines} lines`);
  if (cut.outputBytes !== undefined && cut.totalBytes !== undefined) facts.push(`${cut.outputBytes}/${cut.totalBytes} bytes`);
  if (cut.firstLineExceedsLimit) facts.push('first line exceeds byte limit');
  if (cut.lastLinePartial) facts.push('partial tail line');
  return facts;
}
function outputSummary(source: JoinedTool): string {
  const info = source.output; if (!info) return '';
  const facts = info.truncation ? truncationFacts(source.name, info.truncation) : [];
  if (info.fullOutputPath) facts.push('full output reference supplied');
  return facts.join(' · ');
}
function outputExplanation(source: JoinedTool): string {
  if (!source.output) return '';
  const cut = source.output.truncation; const limits = [cut?.maxLines === undefined ? '' : `${cut.maxLines} lines`, cut?.maxBytes === undefined ? '' : `${cut.maxBytes} bytes`].filter(Boolean);
  return [outputSummary(source), limits.length ? `Applied limits: ${limits.join(', ')}.` : '',
    source.output.fullOutputPath ? `Full output reference (text only): ${source.output.fullOutputPath}` : 'Full output reference not supplied.'].filter(Boolean).join('\n');
}
function timestamp(time: number): HTMLButtonElement {
  const node = button(relativeTime(time, Date.now()), () => {
    const absolute = node.dataset.absolute === 'true'; node.dataset.absolute = String(!absolute);
    setText(node, absolute ? relativeTime(time, Date.now()) : absoluteTime(time));
  }, 'timestamp');
  const details = timestampDetails(time); node.title = `${details.exact} · ${details.display}`;
  return node;
}
function preTextFrame(pre: HTMLElement): HTMLElement {
  const retained = [...pre.children].find(child => child.classList.contains('pre-text-frame')) as HTMLElement | undefined;
  if (retained) return retained;
  const frame = element('span', 'pre-text-frame');
  frame.append(...pre.childNodes); pre.append(frame); return frame;
}
function inspection(title: string, source: () => string): HTMLDetailsElement {
  const node = element('details'); const pre = element('pre'); const text = preTextFrame(pre);
  node.append(element('summary', undefined, title));
  node.addEventListener('toggle', () => {
    if (!node.open) return;
    setText(text, bounded(source()));
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
      const term = element('dt'); appendKey(term, label);
      grid.append(term, element('dd', undefined, text));
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
type MessageNode = {node: HTMLElement; actions: HTMLElement; body: HTMLElement; error: HTMLElement; parts: Map<string, PartNode>; source: MessageView; time?: number; fork?: HTMLButtonElement};
type EventPage = {node: HTMLElement; rows: HTMLElement; page: number; previous: HTMLButtonElement; next: HTMLButtonElement; cache: Map<string, {source: EntryView; node: HTMLElement}>};
type SessionNode = {source?: SessionGroup; details: HTMLDetailsElement; events: EventPage; notices: EventPage};
type EntryNode = {node: HTMLElement; messages: Map<string, MessageNode>; source?: EntryView; custom?: HTMLElement; session?: SessionNode};
type ToolNode = {card: HTMLElement; node: HTMLDetailsElement; copy: HTMLButtonElement; title: HTMLElement; target: HTMLElement; glyph: HTMLElement; meta: HTMLElement; preview: HTMLElement; expanded: HTMLElement; info: HTMLElement; source?: JoinedTool; presentation?: HTMLElement; output?: HTMLElement; images?: HTMLElement; contentSource?: JoinedTool; viewport?: HTMLElement; pageViewports?: Set<HTMLElement>; resultDocument?: HTMLElement; documentSource?: JoinedTool; previewBudget?: PreviewBudget};
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
  private resize?: ResizeObserver;
  private geometryTimer?: ReturnType<typeof setTimeout>;
  private geometryDirty = new Set<HTMLElement>();
  private outputNodes = new Set<HTMLElement>();
  private outputListeners = new WeakSet<HTMLElement>();
  private disclosureListeners = new WeakSet<HTMLElement>();
  private scrolling = new WeakSet<HTMLElement>();
  private sizes = new WeakMap<Element, string>();
  private reflowAnchor?: {id: string; offsetPx: number} | null;
  readonly node: HTMLElement;
  readonly prefix: 'primary' | 'agent';
  private hooks: ViewHooks;
  /** The earlier-history control is the first line inside the scroller, above the virtual window. */
  private lead?: HTMLElement;
  constructor(prefix: 'primary' | 'agent', hooks: ViewHooks) {
    this.prefix = prefix; this.hooks = hooks;
    this.node = byId(`${prefix}-transcript`);
    this.node.addEventListener('contextmenu', event => this.itemMenu(event));
    this.lead = document.getElementById(`${prefix}-earlier`) ?? undefined;
    this.node.addEventListener('scroll', () => {
      if (this.hidden()) return;
      this.scrolling.add(this.node); this.reflowAnchor = undefined; this.restoring = undefined;
      this.follow = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 48 && !this.hasSelection();
      byId(`${prefix}-latest`).hidden = this.follow;
      this.schedule();
    }, {passive: true});
    this.node.addEventListener('scrollend', event => {
      if (event.target !== this.node) return;
      this.scrolling.delete(this.node); this.queueGeometry(); this.saveReading();
    });
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(entries => {
        for (const entry of entries) this.resizeGeometry(entry);
        if (this.geometryDirty.size) this.queueGeometry();
      });
      this.resize.observe(this.node);
    }
    byId(`${prefix}-latest`).addEventListener('click', () => { this.follow = true; this.pins.clear(); this.paint(); this.queueGeometry(); });
    document.addEventListener('selectionchange', () => {
      if (!this.hidden() && this.hasSelection()) { this.follow = false; this.schedule(); }
      else { this.queueGeometry(); if (!this.hidden()) this.schedule(); }
    });
    this.node.addEventListener('focusout', () => { this.queueGeometry(); this.schedule(); });
    const fontChange = () => { this.geometryDirty.add(this.node); this.queueGeometry(); };
    document.fonts?.addEventListener('loading', fontChange); document.fonts?.addEventListener('loadingdone', fontChange);
    if (typeof matchMedia === 'function') {
      matchMedia('(forced-colors: active)').addEventListener('change', fontChange);
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fontChange);
    }
    if (typeof MutationObserver === 'function') {
      const appearance = new MutationObserver(fontChange);
      appearance.observe(document.documentElement, {attributes: true, attributeFilter: ['class', 'style', 'data-appearance']});
    }
  }
  private itemMenu(event: MouseEvent): void {
    if (nativeEditingTarget(event.target)) return;
    const target = event.target as HTMLElement | null;
    const origin = target?.closest<HTMLElement>('.tool-shell, .message, .entry'); if (!origin || !this.node.contains(origin)) return;
    const generation = this.generation;
    const tool = [...this.tools.values()].find(item => item.card === origin);
    const entryNode = origin.closest<HTMLElement>('.entry'); const entry = entryNode ? this.cache.get(entryNode.dataset.entryId ?? '') : undefined;
    const message = entry && [...entry.messages.values()].find(item => item.node === origin);
    const source = tool?.source ?? message?.source ?? entry?.source;
    const text = menuText(tool, message, entry);
    const items = [...selectionCopy(origin), {label: 'Copy content', run: () => { void copy(text, origin); }}];
    const disclosure = target?.closest<HTMLDetailsElement>('details') ?? origin.querySelector<HTMLDetailsElement>('details');
    if (disclosure && origin.contains(disclosure)) items.push({label: disclosure.open ? 'Collapse details' : 'Expand details', run: () => { disclosure.open = !disclosure.open; }});
    origin.tabIndex = -1;
    event.preventDefault(); event.stopPropagation();
    contextMenu.open(origin, {x: event.clientX, y: event.clientY}, 'Transcript item actions', items,
      () => generation === this.generation && origin.isConnected && !this.hidden() && source === (tool?.source ?? message?.source ?? entry?.source));
  }
  private hidden(): boolean { return this.node.closest<HTMLElement>('.conversation')?.hidden === true; }
  private hasSelection(): boolean {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed && (this.node.contains(selection.anchorNode) || this.node.contains(selection.focusNode));
  }
  configure(presentation?: PresentationView, reading?: ReadingView): void {
    this.expanded = new Set(presentation?.expanded ?? []); this.showThinking = presentation?.showThinking ?? false;
    if (reading) {
      this.follow = reading.followTail; this.readingRevision = reading.revision; this.restoring = reading.followTail ? undefined : reading;
      this.reflowAnchor = reading.anchorId ? {id: this.displayId(reading.anchorId), offsetPx: reading.offsetPx} : null;
    }
    this.applyPreferences();
  }
  reset(): void {
    if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer);
    this.geometryTimer = undefined; this.geometryDirty.clear(); this.outputNodes.clear();
    this.resize?.disconnect(); this.resize?.observe(this.node); this.sizes = new WeakMap(); this.scrolling = new WeakSet(); this.reflowAnchor = undefined;
    this.generation++; this.entries = []; this.displayed = []; this.cache.clear(); this.tools.clear(); this.index = new TranscriptIndex(); this.joined = this.index.joined; this.visible.clear(); this.dirtyLayout = true; this.pins.clear(); this.heights.clear(); this.gaps.clear();
    this.expanded.clear(); this.showThinking = false; this.follow = true; this.readingRevision = 0;
    this.layout = layoutItems([], this.heights, 140); this.restoring = undefined; this.node.replaceChildren(...(this.lead ? [this.lead] : [])); this.node.scrollTop = 0;
  }
  set(entries: EntryView[], tools: ReadonlyMap<string, ToolState> = new Map()): void {
    const sessions = new Map(this.index.sessions);
    this.entries = entries; this.index.update(entries, tools, entry => this.visibleEntry(entry)); this.reconcileSessions(sessions);
    for (const id of this.index.changed) {
      const entry = this.index.entries.get(id);
      if (entry) this.visible.set(id, this.visibleEntry(entry)); else this.visible.delete(id);
    }
    const displayed = entries.filter(entry => this.visible.get(entry.id) && (this.index.sessionOwners.get(entry.id) ?? entry.id) === entry.id);
    if (displayed.length !== this.displayed.length || displayed.some((entry, at) => entry.id !== this.displayed[at]?.id)) this.dirtyLayout = true;
    this.displayed = displayed; this.prune(); this.schedule();
  }
  private reconcileSessions(previous: ReadonlyMap<string, SessionGroup>): void {
    for (const [id, group] of previous) {
      const open = this.expanded.has(`events:${id}`); const owner = this.index.sessionOwners.get(id);
      if (open) {
        this.expanded.delete(`events:${id}`);
        this.inheritSessionOpen(group);
      }
      const cached = this.cache.get(id);
      if (!owner || owner === id || !cached || this.cache.has(owner) && !this.protectedNode(cached.node)) continue;
      this.cache.delete(id); this.cache.set(owner, cached); cached.node.dataset.entryId = owner;
      const height = this.heights.get(id); if (height !== undefined) this.heights.set(owner, height);
    }
  }
  private inheritSessionOpen(group: SessionGroup): void {
    for (const member of group.entries) { const head = this.index.sessionOwners.get(member.id); if (head) this.expanded.add(`events:${head}`); }
  }
  restore(reading?: ReadingView): void {
    if (this.hidden() || !reading || reading.followTail) return;
    this.follow = false; this.restoring = reading;
    this.reflowAnchor = reading.anchorId ? {id: this.displayId(reading.anchorId), offsetPx: reading.offsetPx} : null;
    this.schedule();
  }
  schedule(): void {
    if (this.pending) return; this.pending = true; const start = performance.now();
    requestAnimationFrame(() => {
      this.pending = false; this.paint();
      if (!this.hidden()) this.queueGeometry();
      performance.measure('ui:stream-receive-to-paint', {start, end: performance.now()});
    });
  }
  private anchor(): {id: string; offsetPx: number} | null {
    let first = true;
    for (const child of this.node.children) {
      const node = child as HTMLElement;
      if (node === this.lead) continue;
      const top = node.offsetTop - this.node.offsetTop;
      // Above the first laid-out item (padding and the earlier control) there is no entry to anchor.
      if (first && this.node.scrollTop < top) return null;
      first = false;
      if (node.dataset.entryId && top <= this.node.scrollTop && top + node.offsetHeight > this.node.scrollTop) {
        return {id: node.dataset.entryId, offsetPx: this.node.scrollTop - (node.offsetTop - this.node.offsetTop)};
      }
    }
    return captureAnchor(this.layout, this.node.scrollTop);
  }
  private geometryGuard(): boolean {
    return this.hidden() || !!this.restoring || this.hasSelection() || (document.activeElement !== this.node && this.node.contains(document.activeElement));
  }
  private resizeGeometry(entry: ResizeObserverEntry): void {
    const target = entry.target as HTMLElement;
    if (target !== this.node && !this.outputNodes.has(target)) return;
    const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
    if (this.sizes.get(target) === size) return;
    this.sizes.set(target, size); this.geometryDirty.add(target);
  }
  private queueGeometry(): void {
    if (!this.geometryDirty.size) return;
    if (this.geometryTimer !== undefined) clearTimeout(this.geometryTimer);
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = undefined; this.settleGeometry();
      this.scrolling.delete(this.node); for (const node of this.outputNodes) this.scrolling.delete(node);
    }, 120);
  }
  private settleGeometry(): void {
    if (!this.geometryDirty.size || this.geometryGuard() || this.scrolling.has(this.node)) return;
    const anchor = this.follow ? null : this.reflowAnchor ?? this.anchor(); let reflow = false;
    for (const node of this.geometryDirty) {
      if (node === this.node) { reflow = true; this.geometryDirty.delete(node); continue; }
      if (this.scrolling.has(node)) continue;
      this.geometryDirty.delete(node);
      reflow = node.isConnected && this.outputNodes.has(node) || reflow;
    }
    if (reflow) {
      if (anchor) this.restorePosition(anchor);
      this.paint(anchor); this.saveReading();
    }
  }
  private registerOutput(node: HTMLElement): void {
    if (!this.outputNodes.has(node)) { this.outputNodes.add(node); this.resize?.observe(node); }
    if (this.outputListeners.has(node)) return;
    this.outputListeners.add(node);
    node.addEventListener('scroll', () => {
      if (!this.outputNodes.has(node)) return;
      this.scrolling.add(node); this.queueGeometry();
    }, {passive: true});
    node.addEventListener('scrollend', () => {
      this.scrolling.delete(node);
      if (!this.outputNodes.has(node)) return;
      this.queueGeometry();
    });
  }
  private releaseOutput(node: HTMLElement): void {
    this.resize?.unobserve(node); this.outputNodes.delete(node); this.geometryDirty.delete(node);
    this.releaseFrames(node);
  }
  private releaseToolGeometry(tool: ToolNode): void {
    if (tool.viewport) this.releaseOutput(tool.viewport);
    for (const page of tool.pageViewports ?? []) this.releaseOutput(page);
  }
  private registerContent(root: HTMLElement): void {
    const outputs = root.querySelectorAll<HTMLElement>('pre, table');
    for (const node of outputs) {
      this.registerOutput(node); node.tabIndex = 0;
      node.setAttribute('role', 'region'); node.setAttribute('aria-label', 'Scrollable content');
    }
    if (root.tagName.toLowerCase() === 'pre') { this.registerOutput(root); root.tabIndex = 0; }
    for (const detail of root.querySelectorAll<HTMLDetailsElement>('details')) this.observeDisclosure(detail);
    if (root.tagName.toLowerCase() === 'details') this.observeDisclosure(root);
  }
  private observeDisclosure(node: HTMLElement): void {
    if (this.disclosureListeners.has(node)) return;
    this.disclosureListeners.add(node);
    node.addEventListener('toggle', () => { if (this.node.contains(node)) { this.registerContent(node); this.schedule(); } });
  }
  private retireNode(node?: HTMLElement): void { if (node) { this.releaseFrames(node); node.remove(); } }
  private releaseFrames(root: HTMLElement): void {
    for (const node of this.outputNodes) if (root.contains(node)) {
      this.resize?.unobserve(node); this.outputNodes.delete(node); this.geometryDirty.delete(node);
    }
  }
  private replaceContent(root: HTMLElement, ...children: Node[]): void {
    this.releaseFrames(root); root.replaceChildren(...children); this.registerContent(root);
  }
  private inspection(title: string, source: () => string): HTMLDetailsElement {
    const node = inspection(title, source); this.registerContent(node); return node;
  }
  private presentationContext() {
    return {bounded, rawText, inspection: (title: string, source: () => string) => this.inspection(title, source),
      structured: (display: JsonDisplay) => { const node = structured(display); this.registerContent(node); return node; }};
  }
  private saveReading(): void {
    if (this.hidden()) return;
    const anchor = this.anchor(); this.reflowAnchor = anchor;
    this.hooks.reading({revision: this.readingRevision, anchorId: anchor?.id ?? null, offsetPx: anchor?.offsetPx ?? 0, followTail: this.follow});
  }
  private paint(anchorOverride?: {id: string; offsetPx: number} | null): void {
    if (this.hidden()) return;
    // Current tail intent supersedes a saved reading position that has not reached the DOM yet.
    if (this.follow) this.restoring = undefined;
    const anchor = this.follow ? null : anchorOverride ?? this.anchor();
    if (this.dirtyLayout) { this.layout = layoutItems(this.displayed.map(entry => entry.id), this.heights, 140); this.dirtyLayout = false; }
    const scrollTop = this.prepareScroll();
    const pins = this.currentPins(); if (anchor) pins.add(anchor.id);
    const selected = visibleWindow(this.layout, scrollTop, this.node.clientHeight, {pins}).items;
    const children = this.children(selected); const mounted = new Set(children);
    for (const child of this.node.children) if (!mounted.has(child as HTMLElement)) this.releaseFrames(child as HTMLElement);
    reconcileChildren(this.node, children);
    this.measure(selected);
    this.refreshGaps(selected);
    this.evict(new Set(selected.map(item => item.id)));
    if (this.follow && !this.hasSelection()) this.node.scrollTop = this.node.scrollHeight;
    else this.restorePosition(anchor);
    byId(`${this.prefix}-latest`).hidden = this.follow;
    // Measurements and restored scroll positions can expose rows outside the window chosen above.
    const next = visibleWindow(this.layout, this.prepareScroll(), this.node.clientHeight, {pins}).items;
    if (next.length !== selected.length || next.some((item, index) => item.id !== selected[index]?.id)) this.schedule();
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
    const original = this.readingAnchor() ?? anchor;
    const wanted = original ? {id: this.displayId(original.id), offsetPx: original.offsetPx} : null;
    const node = wanted && this.cache.get(wanted.id)?.node;
    const item = wanted && this.layout.byId.get(wanted.id);
    if (node?.isConnected && wanted && item) {
      const position = restoreAnchor(this.layout, wanted, 0);
      this.node.scrollTop = node.offsetTop - this.node.offsetTop + position - item.top;
    }
    if (this.restoring && node?.isConnected) this.restoring = undefined;
  }
  private currentPins(): Set<string> {
    const pins = new Set([...this.pins].map(id => this.displayId(id))); const selection = document.getSelection();
    for (const [id, entry] of this.cache) {
      if (entry.node.contains(document.activeElement) || entry.node.contains(selection?.anchorNode ?? null) || entry.node.contains(selection?.focusNode ?? null)) pins.add(this.displayId(id));
      if ([...entry.node.querySelectorAll<HTMLDetailsElement>('details[open]')].some(node => !node.dataset.disclosure)) pins.add(id);
    }
    if (this.restoring?.anchorId) pins.add(this.displayId(this.restoring.anchorId));
    return pins;
  }
  private gap(key: string, height: number): HTMLElement {
    let node = this.gaps.get(key);
    if (!node) { node = element('div', 'spacer'); node.setAttribute('aria-hidden', 'true'); this.gaps.set(key, node); }
    node.style.height = `${height}px`; return node;
  }
  private children(items: LayoutItem[]): HTMLElement[] {
    const children: HTMLElement[] = this.lead ? [this.lead] : []; let offset = 0;
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
    for (const [id, entry] of this.cache) if (!this.index.entries.has(id)) { this.releaseFrames(entry.node); entry.node.remove(); this.cache.delete(id); this.pins.delete(id); }
    for (const id of this.index.changed) if (!this.index.entries.has(id)) this.heights.delete(id);
    for (const [id, tool] of this.tools) if (!this.joined.has(id)) { this.releaseToolGeometry(tool); tool.card.remove(); this.tools.delete(id); }
  }
  private evict(mounted: ReadonlySet<string>): void {
    const offscreen = [...this.cache.keys()].filter(id => !mounted.has(id));
    for (const id of offscreen.slice(0, Math.max(0, offscreen.length - 32))) { const entry = this.cache.get(id); if (entry) this.releaseFrames(entry.node); this.cache.delete(id); }
    for (const [id, tool] of this.tools) {
      const owner = this.joined.get(id)?.owner;
      if (!owner || !this.cache.has(owner)) { this.releaseToolGeometry(tool); tool.card.remove(); this.tools.delete(id); }
    }
  }
  private updateEntry(entry: EntryView): HTMLElement {
    let cached = this.cache.get(entry.id);
    if (!cached) {
      const node = element('div', 'entry'); node.dataset.entryId = entry.id; node.style.display = 'flow-root';
      cached = {node, messages: new Map()}; this.cache.set(entry.id, cached);
    }
    const session = this.index.sessions.get(entry.id);
    if (session) cached.node.classList.add('session-event-group'); else cached.node.classList.remove('session-event-group');
    if (session) this.updateSession(cached, session);
    else { if (cached.session) cached.custom = undefined; cached.session = undefined; this.updateCustom(cached, entry); }
    const children: HTMLElement[] = cached.custom ? [cached.custom] : [];
    const ids = new Set<string>();
    for (const message of entry.messages ?? []) {
      if (!presentMessage(message).visible || this.joinedMessage(entry.id, message)) continue;
      ids.add(message.id); children.push(this.updateMessage(cached, message, entry).node);
    }
    this.pruneMessages(cached, ids);
    reconcileChildren(cached.node, children); this.registerContent(cached.node); cached.source = entry; return cached.node;
  }
  private pruneMessages(entry: EntryNode, ids: ReadonlySet<string>): void {
    for (const [id, message] of entry.messages) if (!ids.has(id)) { this.releaseFrames(message.node); entry.messages.delete(id); }
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
    const session = this.index.sessionOwners.get(id); if (session) return session;
    if (this.visible.get(id)) return id;
    const entry = this.index.entries.get(id);
    for (const message of entry?.messages ?? []) for (const part of message.parts) {
      if (part.type === 'toolResult') return this.joined.get(part.callId)?.owner ?? id;
    }
    return id;
  }
  private eventPage(entries: () => readonly EntryView[], size: number, notice = false): EventPage {
    const node = element('div', 'session-events-body'); const rows = element('div');
    const page: EventPage = {node, rows, page: 0, cache: new Map(), previous: button(notice ? 'Previous notices' : 'Previous events', () => change(-1)), next: button(notice ? 'Next notices' : 'Next events', () => change(1))};
    const change = (delta: number) => { page.page += delta; this.renderEventPage(page, entries(), size, notice); this.schedule(); };
    node.append(rows, page.previous, page.next); return page;
  }
  private renderEventPage(page: EventPage, entries: readonly EntryView[], size: number, notice = false): void {
    page.page = Math.max(0, Math.min(page.page, Math.ceil(entries.length / size) - 1));
    const start = page.page * size; const wanted: HTMLElement[] = []; const ids = new Set<string>();
    for (const entry of entries.slice(start, start + size)) {
      let cached = page.cache.get(entry.id);
      if (!cached || cached.source !== entry && !this.protectedNode(cached.node)) {
        if (cached) this.releaseFrames(cached.node);
        const node = presentEntry(entry, {...this.presentationContext(), bounded: (text, limit = 1024) => bounded(text, Math.min(limit, 1024)),
          inspection: (title, source) => this.inspection(title, () => bounded(source(), 8192))});
        this.registerContent(node);
        node.dataset.sessionEventId = entry.id; if (notice) node.classList.add('warning');
        cached = {source: entry, node}; page.cache.set(entry.id, cached);
      }
      this.registerContent(cached.node); ids.add(entry.id); wanted.push(cached.node);
    }
    for (const [id, cached] of page.cache) if (!ids.has(id)) { this.releaseFrames(cached.node); page.cache.delete(id); }
    reconcileChildren(page.rows, wanted);
    page.previous.hidden = start === 0; page.next.hidden = start + size >= entries.length;
  }
  private protectedNode(node: HTMLElement): boolean {
    const selection = document.getSelection();
    return node.contains(document.activeElement) || !!selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode));
  }
  private updateSession(cached: EntryNode, group: SessionGroup): void {
    let session = cached.session;
    if (!session) {
      const details = element('details', 'session-events'); const id = `events:${group.id}`;
      details.dataset.disclosure = id; details.append(element('summary'));
      session = {details, events: this.eventPage(() => cached.session?.source?.entries ?? [], 32), notices: this.eventPage(() => cached.session?.source?.notices ?? [], 16, true)};
      cached.session = session; cached.custom = element('section'); cached.custom.append(session.notices.node, details);
      details.addEventListener('toggle', () => {
        const current = cached.session; if (!current?.source) return;
        if (details.open) { this.renderEventPage(current.events, current.source.entries, 32); details.append(current.events.node); }
        else this.retireNode(current.events.node);
      });
      this.trackDisclosure(details, id);
    }
    session.source = group;
    session.details.dataset.disclosure = `events:${group.id}`;
    const summary = session.details.querySelector('summary');
    if (summary && !this.protectedNode(summary)) setText(summary, `${group.entries.length} session ${group.entries.length === 1 ? 'event' : 'events'}`);
    session.notices.node.hidden = !group.notices.length;
    if (group.notices.length) this.renderEventPage(session.notices, group.notices, 16, true);
    else this.reconcileContent(session.notices.rows, []);
    session.details.open = this.expanded.has(`events:${group.id}`);
    if (session.details.open) { this.renderEventPage(session.events, group.entries, 32); session.details.append(session.events.node); }
  }
  private updateCustom(cached: EntryNode, entry: EntryView): void {
    if (!entry.data && entry.messages?.length) { cached.custom = undefined; return; }
    if (cached.source === entry) return;
    if (cached.source?.data !== entry.data || cached.source?.head !== entry.head || !cached.custom) {
      if (cached.custom) this.releaseFrames(cached.custom);
      cached.custom = presentEntry(entry, this.presentationContext()); this.registerContent(cached.custom);
    }
  }
  private createMessage(entry: EntryNode, message: MessageView): MessageNode {
    const node = element('article', `message ${message.role === 'user' ? 'user' : ''}`);
    const actions = element('div', 'message-actions'); const body = element('div', 'message-body'); const error = element('p', 'error message-error'); error.hidden = true;
    node.setAttribute('aria-label', message.role === 'user' ? 'User message' : bounded(`${presentMessage(message).label} message`, 4096));
    actions.append(button('copy', () => { void copy(partText(entry.messages.get(message.id)?.source.parts ?? []), node); }, 'copy'));
    node.append(body, error, actions);
    const cached = {node, actions, body, error, parts: new Map<string, PartNode>(), source: message}; entry.messages.set(message.id, cached); return cached;
  }
  private updateMessage(entry: EntryNode, message: MessageView, retained: EntryView): MessageNode {
    const entryId = retained.id;
    const cached = entry.messages.get(message.id) ?? this.createMessage(entry, message);
    this.updateFork(cached, retained, message);
    this.updateTime(cached, message.timestamp);
    const children: HTMLElement[] = []; const keys = new Set<string>();
    message.parts.forEach((part, index) => {
      if ((part.type === 'text' || part.type === 'thinking') && !part.text.trim() && !part.redacted && !part.more) return;
      const key = `${index}:${part.type}`; keys.add(key);
      const node = this.updatePart(cached, part, index, message.state === 'partial', entryId);
      if (node) children.push(node);
    });
    this.pruneParts(cached, keys);
    if (message.coverage.truncated || message.coverage.omitted > 0 || !message.coverage.complete) {
      const reason = bounded(message.coverage.reason ?? '', 4096, 6).trim();
      const notice = element('p', 'secondary', reason || 'Message content is not fully displayed.');
      children.push(notice);
    }
    const error = message.error || (message.stopReason === 'error' ? 'Response stopped with an error.' : message.stopReason === 'aborted' ? 'Response aborted.' : '');
    cached.error.className = `${message.stopReason === 'aborted' && !message.error ? 'warning' : 'error'} message-error`;
    this.reconcileContent(cached.body, children); setText(cached.error, bounded(error)); cached.error.hidden = !error;
    this.updateMessageLayout(cached, children, error);
    cached.source = message; return cached;
  }
  private updateMessageLayout(cached: MessageNode, children: HTMLElement[], error: string): void {
    const toolOnly = children.some(child => child.classList.contains('tool-shell')) && children.every(child => child.classList.contains('tool-shell') || child.classList.contains('thinking')) && !error;
    if (toolOnly) cached.node.classList.add('tool-only'); else cached.node.classList.remove('tool-only');
    const copyAction = cached.actions.querySelector('.copy');
    if (copyAction) { setText(copyAction, toolOnly ? 'copy all' : 'copy'); copyAction.setAttribute('aria-label', 'Copy message content'); }
    const thinkingOnly = children.length > 0 && children.every(child => child.classList.contains('thinking')) && !error;
    if (thinkingOnly) cached.node.classList.add('thinking-only'); else cached.node.classList.remove('thinking-only');
  }
  private pruneParts(message: MessageNode, keys: ReadonlySet<string>): void {
    for (const [key, part] of message.parts) if (!keys.has(key)) { this.releaseFrames(part.node); message.parts.delete(key); }
  }
  private reconcileContent(root: HTMLElement, children: HTMLElement[]): void {
    const wanted = new Set(children);
    for (const child of root.children) if (!wanted.has(child as HTMLElement)) this.releaseFrames(child as HTMLElement);
    reconcileChildren(root, children);
  }
  private updateFork(cached: MessageNode, entry: EntryView, message: MessageView): void {
    const retained = entry.kind === 'message' && !entry.id.startsWith('message:') && !entry.id.startsWith('live:');
    const eligible = retained && message.role === 'user' && message.state === 'final' && !!this.hooks.fork;
    if (!eligible) { cached.fork?.remove(); cached.fork = undefined; return; }
    if (cached.fork) return;
    cached.fork = button('fork', () => this.hooks.fork?.(cached.source, entry.id), 'copy'); cached.actions.append(cached.fork);
  }
  private updateTime(message: MessageNode, time?: number): void {
    if (message.time === time) return;
    message.actions.querySelector('.timestamp')?.remove();
    if (time !== undefined && relativeTime(time, Date.now())) message.actions.append(timestamp(time)); message.time = time;
  }
  private updatePart(message: MessageNode, part: PartView, index: number, partial: boolean, entryId: string): HTMLElement | undefined {
    if (part.type === 'toolCall' || part.type === 'toolResult') {
      const tool = this.joined.get(part.callId);
      return tool?.slot === slot(entryId, message.source.id, index) ? this.updateTool(tool) : undefined;
    }
    const key = `${index}:${part.type}`; const previous = message.parts.get(key);
    if (previous?.source === part && previous.partial === partial) return previous.node;
    const node = previous?.node ?? this.createPart(part, entryId, message.source.id, index);
    const pages = node.querySelector<HTMLElement>('.output-pages'); if (pages) { this.releaseFrames(pages); pages.remove(); }
    this.partContent(node, part, partial, previous);
    if ((part.type === 'text' || part.type === 'thinking') && part.more) {
      const source = part; const generation = this.generation;
      const pages = outputPages(part.more, this.hooks.output, () => generation === this.generation && message.parts.get(key)?.source === source, () => this.schedule());
      node.append(pages); this.registerContent(pages);
    }
    this.registerContent(node); message.parts.set(key, {node, source: part, partial}); return node;
  }
  private createPart(part: PartView, entryId: string, messageId: string, index: number): HTMLElement {
    if (part.type !== 'thinking') return element('div');
    const node = element('details', 'thinking'); const id = `thinking:${entryId}:${messageId}:${index}`;
    node.dataset.disclosure = id; node.open = this.showThinking || this.expanded.has(id);
    node.append(element('summary', undefined, 'thinking'), element('div', 'thinking-content'));
    this.trackDisclosure(node, id); return node;
  }
  private partContent(node: HTMLElement, part: PartView, partial: boolean, previous?: PartNode): void {
    if (part.type === 'text') {
      this.textContent(node, part.text, partial, previous);
    } else if (part.type === 'thinking') {
      this.thinkingContent(node, part, partial);
    } else if (part.type === 'image') this.imageContent(node, part);
    else if (part.type === 'omitted') { node.className = 'secondary'; setText(node, bounded(part.label)); }
  }
  private imageContent(node: HTMLElement, part: ImageView): void {
    const url = this.hooks.image?.(part); const key = JSON.stringify([part.digest, part.source, part.width, part.height, part.bytes, url]);
    if (node.dataset.imageKey === key) return;
    const generation = this.generation; node.className = 'image-part'; node.dataset.imageKey = key;
    node.replaceChildren(transcriptImage(part, url, () => { if (generation === this.generation) this.schedule(); }));
  }
  private updateToolImages(tool: ToolNode, parts: readonly PartView[]): void {
    const images = imageParts(parts);
    if (!images.length && !tool.images) return;
    if (!tool.images) { tool.images = element('div', 'tool-images'); tool.expanded.append(tool.images); }
    const previous = [...tool.images.children] as HTMLElement[];
    const wanted = images.map((image, index) => { const node = previous[index] ?? element('div'); this.imageContent(node, image); return node; });
    reconcileChildren(tool.images, wanted); tool.images.hidden = !images.length;
  }
  private thinkingContent(node: HTMLElement, part: Extract<PartView, {type: 'text' | 'thinking'}>, partial: boolean): void {
    const content = node.querySelector('.thinking-content'); if (!content) return;
    content.className = partial ? 'thinking-content stream-text' : 'thinking-content';
    const root = content as HTMLElement;
    if (part.redacted || partial) { this.releaseFrames(root); setText(root, part.redacted ? 'Thinking omitted by host' : bounded(part.text, 8192)); }
    else if (part.text.length > 8192) this.replaceContent(root, markdownDom(bounded(part.text, 8192)), this.inspection('Retained thinking (bounded)', () => part.text));
    else this.replaceContent(root, markdownDom(part.text));
  }
  private textContent(node: HTMLElement, text: string, partial: boolean, previous?: PartNode): void {
    if (previous?.source.type === 'text' && previous.source.text === text && previous.partial === partial) return;
    node.className = partial ? 'stream-text' : '';
    if (partial) { this.releaseFrames(node); setText(node, bounded(text, 8192)); }
    else if (text.length > 8192) this.replaceContent(node, markdownDom(bounded(text, 8192)), this.inspection('Retained text (bounded)', () => text));
    else this.replaceContent(node, markdownDom(text));
  }
  private createTool(source: JoinedTool): ToolNode {
    const card = element('div', 'tool-shell'); const node = element('details', 'tool-card'); card.append(node); const summary = element('summary');
    const tier = element('span', 'tool-tier'); const glyph = element('span', 'tool-status'); glyph.setAttribute('role', 'img');
    const title = element('span', 'tool-name'); const target = element('span', 'tool-target'); const meta = element('span', 'tool-secondary');
    tier.append(glyph, title, target, meta); summary.append(tier);
    const preview = element('div', 'tool-preview'); const expanded = element('div', 'tool-expanded'); const info = element('p', 'secondary tool-output-info'); expanded.append(info); summary.append(preview); node.append(summary, expanded);
    node.dataset.disclosure = `tool:${source.callId}`; node.open = this.expanded.has(`tool:${source.callId}`);
    const action = button('copy', () => { void copy(tool.source?.result ? partText(tool.source.result) : '', tool.card).then(copied => { if (copied) { setText(action, 'copied'); action.title = 'Copied'; } }); }, 'tool-copy');
    action.setAttribute('aria-label', 'Copy tool output'); action.title = 'Copy tool output';
    action.addEventListener('click', event => event.stopPropagation());
    action.addEventListener('blur', () => { setText(action, 'copy'); action.title = 'Copy tool output'; }); card.append(action);
    const tool: ToolNode = {card, node, copy: action, title, target, glyph, meta, preview, expanded, info}; this.tools.set(source.callId, tool);
    this.trackDisclosure(node, `tool:${source.callId}`);
    node.addEventListener('toggle', () => this.toolExpansion(tool)); this.registerContent(card); return tool;
  }
  private updateTool(source: JoinedTool): HTMLElement {
    const tool = this.tools.get(source.callId) ?? this.createTool(source);
    const previous = tool.source; tool.source = source;
    if (previous === source) { if (tool.node.open && tool.documentSource !== source) this.expandTool(tool); return tool.card; }
    tool.card.dataset.status = source.status;
    this.toolHeading(tool, source);
    setText(tool.glyph, source.status === 'success' ? '✓' : source.status === 'error' ? '! error' : '●');
    tool.glyph.className = `tool-status ${source.status}`; tool.glyph.setAttribute('aria-label', source.status);
    setText(tool.meta, [metadata(source), outputSummary(source), source.duration !== undefined && source.status !== 'working' ? `${source.duration} ms` : ''].filter(Boolean).join(' · '));
    const explanation = outputExplanation(source); tool.meta.title = explanation; setText(tool.info, explanation); tool.info.hidden = !explanation;
    tool.meta.hidden = !tool.meta.textContent; tool.copy.hidden = !source.result;
    const changed = previous?.args !== source.args || previous?.result !== source.result || previous?.argumentText !== source.argumentText || previous?.status !== source.status;
    if (changed) this.toolContent(tool);
    tool.preview.hidden = tool.node.open; tool.expanded.hidden = !tool.node.open; return tool.card;
  }
  private toolHeading(tool: ToolNode, source: JoinedTool): void {
    const classification = source.name === 'read' && !tool.node.open ? compactRead(record(source.args)) : undefined;
    setText(tool.title, classification?.name ?? source.name);
    setText(tool.target, classification ? bounded(classification.target, 4096) : subject(source));
    tool.target.hidden = !tool.target.textContent; tool.target.title = subject(source);
  }
  private toolContent(tool: ToolNode): void {
    const source = tool.source; if (!source) return;
    const output = source.result ? partText(source.result) : '';
    const args = source.argumentText ?? (source.args ? rawText(source.args.value) : '');
    const edits = Object.getOwnPropertyDescriptor(record(source.args), 'edits')?.value;
    const content = Array.isArray(edits) && edits.length > 8 ? undefined : presentToolPreview(source);
    if (content) this.replaceContent(tool.preview, content);
    else {
      const preview = previewText(output || args, 2, 1800);
      this.releaseFrames(tool.preview); setText(tool.preview, `${preview.text}${preview.truncated ? '\n…' : ''}`);
    }
    if (tool.node.open) this.expandTool(tool);
  }
  private toolExpansion(tool: ToolNode): void {
    if (!tool.source || this.tools.get(tool.source.callId) !== tool) return;
    this.toolHeading(tool, tool.source);
    tool.preview.hidden = tool.node.open; tool.expanded.hidden = !tool.node.open;
    if (tool.node.open) this.expandTool(tool);
  }
  private toolArguments(tool: ToolNode): string {
    const source = tool.source; if (!source) return '';
    return source.args ? `${rawText(source.args.value)}${source.args.truncated ? '\nArguments omitted by host' : ''}` : source.argumentText ?? '';
  }
  private presentToolRegion(tool: ToolNode, source: JoinedTool): void {
    const previous = tool.contentSource;
    const sameArgs = previous?.args === source.args || previous?.args?.value === source.args?.value;
    if (sameArgs && previous?.name === source.name && tool.presentation) {
      this.refreshArgumentCaption(tool, source); return;
    }
    const context = this.presentationContext();
    const generic = presentArguments(source.args, context);
    const edits = Object.getOwnPropertyDescriptor(record(source.args), 'edits')?.value;
    const region = generic && (generic.querySelector('.tool-source') || Array.isArray(edits)) ? generic : presentTool(source, context) ?? generic;
    this.retireNode(tool.presentation); tool.presentation = region;
    if (region) { tool.expanded.prepend(region); this.registerContent(region); }
    tool.previewBudget = undefined;
  }
  private refreshArgumentCaption(tool: ToolNode, source: JoinedTool): void {
    const heading = tool.presentation?.querySelector('.tool-caption');
    if (heading && source.name === 'write') setText(heading, source.status === 'success' ? 'written content' : 'supplied content');
  }
  private resultBudget(tool: ToolNode): PreviewBudget {
    const budget = new PreviewBudget(); const argumentsRoot = tool.presentation;
    if (argumentsRoot && !budget.adopt(argumentsRoot)) {
      const cost = budget.retainedCost(argumentsRoot);
      if (!budget.retain(argumentsRoot, cost, 0, 0)) budget.text = 0;
    }
    tool.previewBudget = budget; return budget;
  }
  private expandedContent(tool: ToolNode, source: JoinedTool): void {
    if (tool.contentSource === source) return;
    const rich = source.status !== 'working' && hasStructuredResult(source.result ?? []);
    this.updateToolImages(tool, rich ? [] : source.result ?? []);
    if (tool.contentSource?.args !== source.args || tool.contentSource?.name !== source.name || tool.contentSource?.status !== source.status) {
      this.presentToolRegion(tool, source);
    }
    if (tool.contentSource?.result !== source.result) this.replaceToolPages(tool, source, rich);
    tool.contentSource = source;
  }
  private replaceToolPages(tool: ToolNode, source: JoinedTool, rich: boolean): void {
    for (const page of tool.pageViewports ?? []) this.releaseOutput(page);
    tool.pageViewports?.clear(); this.retireNode(tool.output); const output = element('div'); tool.output = output;
    const generation = this.generation;
    const append = (parts: PartView[]) => { for (const part of parts) {
      if (part.type === 'toolResult') append(part.parts);
      else if ((part.type === 'text' || part.type === 'thinking') && part.more) output.append(this.toolOutputPages(part.more, source, tool, generation));
    } };
    if (!rich) append(source.result ?? []);
    const text = tool.expanded.querySelector('.tool-output-text');
    if (text) text.after(output); else tool.expanded.append(output);
  }
  private expandTool(tool: ToolNode): void {
    const source = tool.source; if (!source) return;
    const output = source.result ? partText(source.result) : '';
    this.expandedContent(tool, source);
    let pre = tool.expanded.querySelector('.tool-output-text');
    if (!pre) {
      pre = element('pre', 'tool-output-text'); preTextFrame(pre as HTMLElement); tool.expanded.append(element('span', 'secondary', 'output'), pre);
      if (tool.output) pre.after(tool.output);
      const argumentsInspection = this.inspection('arguments', () => this.toolArguments(tool));
      const resultInspection = this.inspection('raw result', () => partText(tool.source?.result ?? []));
      argumentsInspection.classList.add('tool-inspection'); resultInspection.classList.add('tool-inspection');
      tool.expanded.append(argumentsInspection, resultInspection);
    }
    this.updateResultDocument(tool, source, pre as HTMLElement);
    if (!tool.resultDocument) this.paintToolOutput(pre, source, bounded(output || (source.status === 'working' ? 'working' : source.status === 'error' ? 'Tool failed without retained output.' : 'returned successfully')));
    else if (pre.textContent) setText(preTextFrame(pre as HTMLElement), '');
    this.refreshToolPages(tool, source); this.refreshToolInspections(tool, source);
  }
  private updateResultDocument(tool: ToolNode, source: JoinedTool, pre: HTMLElement): void {
    if (tool.documentSource?.result !== source.result || tool.documentSource?.status !== source.status || tool.documentSource?.args !== source.args) {
      if (tool.resultDocument && this.protectedNode(tool.resultDocument)) return;
      this.retireNode(tool.resultDocument);
      tool.resultDocument = source.status !== 'working' && hasStructuredResult(source.result ?? []) ? this.resultParts(tool, source) : undefined;
      if (tool.resultDocument) pre.after(tool.resultDocument);
    }
    tool.documentSource = source;
    pre.hidden = !!tool.resultDocument;
    if (pre.hidden) { this.releaseOutput(pre); tool.viewport = undefined; }
    else { tool.viewport = pre; this.registerOutput(pre); }
  }
  private resultParts(tool: ToolNode, source: JoinedTool): HTMLElement {
    const node = element('div', 'tool-result-parts'); const generation = this.generation; const budget = this.resultBudget(tool);
    const append = (parts: readonly PartView[]): void => {
      for (const part of parts) {
        if (part.type === 'toolResult') append(part.parts);
        else node.append(this.resultPart(part, source, tool, generation, budget));
      }
    };
    append(source.result ?? []);
    const limited = [...node.children].some(part => part.hasAttribute('aria-label'));
    if (limited && !node.querySelector('.preview-omission') && !tool.presentation?.querySelector('.preview-omission')) {
      node.append(element('p', 'secondary tool-caption preview-omission', 'Preview shortened. Inspect raw output or Copy for retained content.'));
    }
    if (tool.presentation) this.registerContent(tool.presentation);
    this.registerContent(node); return node;
  }
  private resultPart(part: PartView, source: JoinedTool, tool: ToolNode, generation: number, budget: PreviewBudget): HTMLElement {
    const section = element('section', 'tool-result-part');
    if (part.type === 'image') { const image = element('div'); this.imageContent(image, part); section.append(image); }
    else if (part.type === 'omitted') section.append(element('p', 'secondary', bounded(part.label)));
    else if (part.type === 'text' || part.type === 'thinking') {
      this.resultTextPart(section, part, source, budget);
      if (part.more) section.append(this.toolOutputPages(part.more, source, tool, generation));
    }
    this.registerContent(section); return section;
  }
  private resultTextPart(section: HTMLElement, part: Extract<PartView, {type: 'text' | 'thinking'}>, source: JoinedTool, budget: PreviewBudget): void {
    if (part.type === 'text' && part.structured) {
      const document = presentResult(part.structured, this.presentationContext(), budget);
      if (document) section.append(document);
      else {
        budget.limit();
        section.setAttribute('aria-label', 'Structured part exceeds the content preview limit. Use raw result or copy.');
      }
      return;
    }
    const text = element('pre', 'tool-result-text');
    this.paintToolOutput(text, source, bounded(part.redacted ? 'Thinking omitted by host' : part.text)); section.append(text); this.registerOutput(text);
  }
  private refreshToolPages(tool: ToolNode, source: JoinedTool): void {
    for (const page of tool.output?.querySelectorAll<HTMLElement>('.output-page') ?? []) {
      if (!page.hidden) this.paintToolOutput(page, source, page.textContent ?? '');
    }
  }
  private paintToolOutput(pre: Element, source: JoinedTool, text: string, force = false): void {
    const args = record(source.args);
    const language = source.name === 'read' && source.status === 'success' ? languageFromPath(args.file_path ?? args.path) : undefined;
    const node = pre as HTMLElement;
    if (!force && pre.textContent === text && node.dataset.language === (language ?? '')) return;
    const frame = preTextFrame(node);
    if (language) frame.replaceChildren(highlight(text, language));
    else { if (node.dataset.language) frame.replaceChildren(); setText(frame, text); }
    node.dataset.language = language ?? '';
  }
  private toolOutputPages(more: OutputContinuation, source: JoinedTool, tool: ToolNode, generation: number): HTMLElement {
    const current = () => generation === this.generation && this.tools.get(source.callId) === tool && tool.source?.result === source.result;
    let pages: HTMLElement | undefined;
    const changed = () => {
      const pre = pages?.querySelector<HTMLElement>('.output-page');
      if (pre && !pre.hidden && current()) this.paintToolOutput(pre, tool.source ?? source, pre.textContent ?? '', true);
      this.schedule();
    };
    pages = outputPages(more, this.hooks.output, current, changed); this.registerContent(pages);
    const pre = pages.querySelector<HTMLElement>('.output-page');
    if (pre) {
      if (!tool.pageViewports) tool.pageViewports = new Set();
      tool.pageViewports.add(pre); this.registerOutput(pre);
    }
    return pages;
  }
  private refreshToolInspections(tool: ToolNode, source: JoinedTool): void {
    for (const node of tool.expanded.querySelectorAll<HTMLDetailsElement>('details[open]')) {
      const title = node.firstElementChild?.textContent;
      if (title !== 'arguments' && title !== 'raw result') continue;
      const data = node.querySelector<HTMLElement>('pre'); if (data) setText(preTextFrame(data), title === 'arguments' ? bounded(this.toolArguments(tool)) : bounded(partText(source.result ?? [])));
    }
  }
  private trackDisclosure(node: HTMLDetailsElement, id: string): void {
    node.querySelector('summary')?.addEventListener('click', event => {
      if (this.hasSelection() || event.detail > 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) event.preventDefault();
    });
    node.addEventListener('toggle', () => {
      if (!this.node.contains(node)) return;
      const current = node.dataset.disclosure ?? id;
      const expected = this.expanded.has(current) || (current.startsWith('thinking:') && this.showThinking);
      if (node.open === expected) return;
      this.follow = false;
      if (node.open) this.expanded.add(current); else this.expanded.delete(current);
      if (!node.open && current.startsWith('thinking:') && this.showThinking) this.closeThinkingPreference(current);
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
    const group = this.index.sessions.get(id);
    if (group) this.expanded.add(`events:${id}`);
    this.restoring = {revision: this.readingRevision, anchorId: id, offsetPx: 0, followTail: false}; this.paint();
    const session = this.cache.get(id)?.session;
    if (session && group) {
      session.events.page = Math.floor(group.entries.findIndex(member => member.id === entry.id) / 32);
      this.renderEventPage(session.events, group.entries, 32); this.hooks.presentation([...this.expanded], this.showThinking);
    }
    const node = this.cache.get(id)?.node;
    if (node) { node.tabIndex = -1; node.focus({preventScroll: true}); }
  }
}
