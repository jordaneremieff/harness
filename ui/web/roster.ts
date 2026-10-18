import type { AgentRow, CachedRoster } from '../shared/api.ts';
import {cardAction, cardActionLabel} from './card-icons.ts';
import { byId, button, details, element, setText } from './dom.ts';
import { captureAnchor, layoutItems, restoreAnchor, visibleWindow } from './virtual.ts';
import type { LayoutItem, VirtualLayout } from './virtual.ts';
import { absoluteTime, compactAge, isValidTimestamp, previewText, relativeTime, timestampDetails } from './format.ts';
import { reconcileChildren } from './render.ts';
import {ConversationCaptions, agentName} from './tabs.ts';
import type {PresentationTone} from './conversation-presentation.ts';
import {parseMarkdown, type MarkdownBlock, type MarkdownInline} from './markdown.ts';

export type CachedPageSearch = {load: (cursor: string, signal: AbortSignal) => Promise<CachedRoster>; merge: (page: CachedRoster) => void};
const SEARCH_PAGE_LIMIT = 20;
const ROW_HEIGHT = 44;
const RECENT_AGE = 24 * 60 * 60 * 1000;
type RowNode = {node: HTMLElement; select: HTMLButtonElement; state: HTMLElement; name: HTMLElement; preview: HTMLElement; identity: HTMLElement; ageButton: HTMLButtonElement; message: HTMLButtonElement; age: HTMLTimeElement; source: AgentRow; absolute: boolean; previewSource?: string};
function inlinePreview(nodes: MarkdownInline[]): string {
  return nodes.map(node => node.type === 'text' || node.type === 'code' ? node.text : 'children' in node ? inlinePreview(node.children) : '').join('');
}
function blockPreview(block: MarkdownBlock): string {
  switch (block.type) {
    case 'paragraph': case 'heading': return inlinePreview(block.children);
    case 'code': return block.text;
    case 'quote': return block.children.map(blockPreview).join(' ');
    case 'list': return block.items.map(item => item.map(blockPreview).join(' ')).join(' ');
    case 'table': return [block.header, ...block.rows].map(row => row.map(inlinePreview).join(' ')).join(' ');
    case 'rule': return '';
  }
}
export function rosterPreview(source: string): string {
  const words = parseMarkdown(source.slice(0, 4096)).map(blockPreview).join(' ').replace(/\s+/g, ' ');
  return previewText(words, 1, 180).text;
}
function rowName(row: AgentRow): string {return agentName(row.name, row.handle, row.identity, undefined, row.firstMessage);}
export type RosterStatus = {hideVisibleState?: boolean; activity?: string; glyph: string; label: string; tone?: PresentationTone; name?: string; tail?: string; tool?: AgentRow['currentTool']};
function modelText(row: AgentRow): string {
  if (!row.model) return '';
  const thinking = row.model.thinkingLevel ?? row.thinkingLevel;
  return `${row.model.provider}/${row.model.modelId}${thinking ? ` · ${thinking}` : ''}`;
}
/** A catalog retry is a publication, never current input or execution authority. */
export function publishedRetryDescription(row: AgentRow): string {
  const retry = row.publishedRetry; if (!retry) return '';
  return `Published retry · attempt ${retry.attempt} of ${retry.maxAttempts} · delay at publication ${retry.delayMs} ms${row.observedAt ? ` · published ${row.observedAt}` : ' · publication time unavailable'}\n${retry.error}`;
}
function activityText(row: AgentRow): string {
  if (row.error) return row.error;
  if (row.currentTool) return `${row.currentTool.name} · ${row.currentTool.argument}`;
  return row.latestReply ?? row.firstMessage ?? '';
}
/** Status label plus distinct detail; a row without detail shows its status once. */
export function activityLine(row: AgentRow, label: string): string {
  const detail = previewText(activityText(row), 1, 1200).text;
  if (!detail || detail === label) return label;
  return `${label} · ${detail}`;
}
export class Roster {
  private cache = new Map<string, RowNode>();
  private heights = new Map<string, number>();
  private arrivals = new Map<string, {source: AgentRow; now: number}>();
  private gaps = new Map<string, HTMLElement>();
  private rows: AgentRow[] = [];
  private tails = new Map<string, string>();
  private captions = new ConversationCaptions();
  private displayName(row: AgentRow): string {const status = this.resolvedStatus(row), name = status.name ?? rowName(row), tail = status.name !== undefined ? status.tail : this.tails.get(row.identity); return tail ? `${name} · ${tail}` : name;}
  private selected?: string;
  private message?: (identity: string) => void;
  private resumes = new Set<string>();
  private expanded = false;
  private older = button('', () => { this.expanded = !this.expanded; this.paint(); }, 'roster-older');
  private paging = cardAction('next', 'More agents', () => { if (this.query() && this.search) void this.searchCached(true); else this.more('more'); }, 'roster-more');
  private pending = false;
  private meta?: Omit<CachedRoster, 'rows'>;
  private footerCount = -1;
  private search?: CachedPageSearch;
  private searchController?: AbortController;
  private searchQuery = '';
  private searchNotice = '';
  private searchError = '';
  private layout: VirtualLayout = layoutItems([], new Map(), ROW_HEIGHT);
  private resolvedStatus: (row: AgentRow) => RosterStatus;
  private select: (row: AgentRow) => void;
  private more: (action?: 'refresh' | 'more') => void;
  private empty = element('p', 'empty-state');
  readonly node = byId('roster');
  constructor(select: (row: AgentRow) => void, more: (action?: 'refresh' | 'more') => void, search: CachedPageSearch | undefined, message: ((identity: string) => void) | undefined, resolvedStatus: (row: AgentRow) => RosterStatus) {
    this.resolvedStatus = resolvedStatus; this.select = select; this.more = more; this.search = search; this.message = message;
    const searchField = byId<HTMLInputElement>('agent-search');
    searchField.addEventListener('input', () => { this.node.scrollTop = 0; this.paint(); void this.searchCached(); });
    searchField.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      searchField.value = ''; this.node.scrollTop = 0; this.node.focus(); this.paint(); void this.searchCached();
    });
    this.node.tabIndex = 0;
    this.node.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || Array.from(event.key).length !== 1) return;
      if (!this.node.contains(document.activeElement)) return;
      event.preventDefault(); searchField.focus(); searchField.value += event.key;
      this.node.scrollTop = 0; this.paint(); void this.searchCached();
    });
    this.node.addEventListener('scroll', () => this.schedule(), {passive: true});
  }
  set(rows: AgentRow[], meta?: Omit<CachedRoster, 'rows'>, selected?: string): void {
    const now = Date.now();
    for (const row of rows) if (this.arrivals.get(row.identity)?.source !== row) this.arrivals.set(row.identity, {source: row, now});
    const incoming = new Map(rows.map(row => [row.identity, row]));
    this.rows = this.rows.flatMap(row => { const current = incoming.get(row.identity); incoming.delete(row.identity); return current ? [current] : []; });
    this.rows.push(...incoming.values()); this.selected = selected;
    this.prune(new Set(rows.map(row => row.identity))); this.schedule();
    if (this.meta !== meta || this.footerCount !== rows.length) { this.meta = meta; this.footerCount = rows.length; this.footer(rows.length, meta, now); }
    void this.searchCached();
  }
  resume(identity: string, retained: boolean): void {
    if (retained) this.resumes.add(identity); else this.resumes.delete(identity);
    const cached = this.cache.get(identity); if (cached) this.messageAction(cached);
    this.schedule();
  }
  focusMessage(identity: string): boolean {
    const cached = this.cache.get(identity);
    if (!cached || cached.message.hidden || !this.node.contains(cached.node)) return false;
    cached.message.focus(); return true;
  }
  private messageAction(cached: RowNode): void {
    cached.message.hidden = this.selected === cached.source.identity || !this.message;
    const resume = this.resumes.has(cached.source.identity);
    const label = `${resume ? 'Resume message to' : 'Message'} ${this.displayName(cached.source)} · ${cached.source.identity}`;
    cardActionLabel(cached.message, resume ? 'Resume' : 'Message', label); cached.node.dataset.action = cached.message.hidden ? '' : resume ? 'resume' : 'message';
    cached.message.setAttribute('aria-label', label);
  }
  private query(): string { return byId<HTMLInputElement>('agent-search').value.trim().toLocaleLowerCase(); }
  private async searchCached(more = false): Promise<void> {
    const query = this.query();
    if (query !== this.searchQuery) {
      this.searchController?.abort(); this.searchController = undefined; this.searchQuery = ''; this.searchNotice = ''; this.searchError = '';
      this.footer(this.rows.length, this.meta, Date.now());
    }
    if (!this.search || !query || this.searchController || (!more && query === this.searchQuery)) return;
    const cursor = this.meta?.nextCursor;
    if (!cursor || (!more && this.filtered().length)) return;
    this.searchQuery = query; const controller = new AbortController(); this.searchController = controller;
    this.searchNotice = 'Searching agents…'; this.searchError = ''; this.footer(this.rows.length, this.meta, Date.now()); this.schedule();
    try { await this.searchPages(this.search, query, cursor, controller); } catch (error) {
      if (!controller.signal.aborted) { this.searchNotice = 'Agents could not be searched.'; this.searchError = error instanceof Error ? error.message : String(error); }
    } finally {
      if (this.searchController === controller) {
        this.searchController = undefined; this.footer(this.rows.length, this.meta, Date.now()); this.schedule();
      }
    }
  }
  private async searchPages(search: CachedPageSearch, query: string, cursor: string, controller: AbortController): Promise<void> {
    const seen = new Set<string>();
    for (let count = 0; count < SEARCH_PAGE_LIMIT; count++) {
      if (seen.has(cursor)) throw new Error('Repeated cached page cursor');
      seen.add(cursor); const page = await search.load(cursor, controller.signal);
      if (controller.signal.aborted || this.query() !== query) return;
      search.merge(page);
      if (this.filtered().length) { this.searchNotice = ''; return; }
      if (!page.nextCursor) { this.searchNotice = 'No more agents'; return; }
      cursor = page.nextCursor;
    }
    this.searchNotice = 'The agent list is incomplete. Select More agents to search further.';
  }
  private prune(ids: Set<string>): void {
    for (const [id, cached] of this.cache) if (!ids.has(id)) { cached.node.remove(); this.cache.delete(id); this.heights.delete(id); }
    for (const id of this.arrivals.keys()) if (!ids.has(id)) this.arrivals.delete(id);
  }
  private footer(count: number, meta: Omit<CachedRoster, 'rows'> | undefined, now: number): void {
    const footer = byId('roster-footer'); footer.replaceChildren();
    if (this.searchNotice) footer.append(element('p', 'roster-search-status', this.searchNotice));
    if (this.searchError) footer.append(details('Details', this.searchError));
    if (count && (meta?.error || meta?.scan.state === 'failed')) footer.append(element('p', 'error', 'Agents could not be loaded.'));
    if (meta?.error) footer.append(details('Details', meta.error.message));
    if (count && meta?.scan.state === 'running') footer.append(element('p', undefined, 'Loading agents…'));
    if (meta?.stale) footer.append(element('p', undefined, meta.observedAt ? `Saved agent list · ${relativeTime(meta.observedAt, now)}` : 'Saved agent list'));
    this.footerAction(footer, meta);
    if (meta?.scan.skipped) footer.append(element('p', undefined, 'Some records could not be read'));
    footer.hidden = !footer.children.length && !meta?.stale && !meta?.error && meta?.scan.state !== 'failed' && meta?.scan.state !== 'running';
  }
  private footerAction(footer: HTMLElement, meta?: Omit<CachedRoster, 'rows'>): void {
    const state = meta?.scan.state ?? 'not-started';
    if (meta?.error || state === 'failed') footer.append(cardAction('restart', 'Refresh agents', () => this.more('refresh')));
    else if (state === 'not-started' || meta?.stale) footer.append(cardAction('restart', 'Refresh agents', () => this.more('refresh')));
    if (this.query() && this.search && this.searchNotice) this.cachedSearchAction(footer, meta);
  }
  private cachedSearchAction(footer: HTMLElement, meta?: Omit<CachedRoster, 'rows'>): void {
    if (meta?.nextCursor && !this.searchController) footer.append(cardAction('next', 'More agents', () => { void this.searchCached(true); }));
  }
  private emptyState(): HTMLElement {
    let text: string;
    if (this.rows.length) text = 'No loaded agents match';
    else {
      switch (this.meta?.scan.state ?? 'not-started') {
        case 'not-started': text = 'Agents are not loaded.'; break;
        case 'running': text = 'Loading agents…'; break;
        case 'failed': text = 'Agents could not be loaded.'; break;
        case 'ready': text = 'No agents in this view'; break;
      }
    }
    const failed = this.meta?.scan.state === 'failed' && !this.rows.length;
    this.empty.className = failed ? 'roster-error error' : 'empty-state';
    setText(this.empty, text);
    return this.empty;
  }
  schedule(): void {
    if (this.pending) return;
    this.pending = true; requestAnimationFrame(() => { this.pending = false; this.paint(); });
  }
  private filtered(): AgentRow[] {
    const query = this.query();
    return this.rows.filter(row => `${this.displayName(row)} ${row.identity} ${row.name ?? ''} ${row.handle ?? ''} ${modelText(row)}`.toLocaleLowerCase().includes(query));
  }
  private pins(): Set<string> {
    const pins = new Set<string>(); if (this.selected) pins.add(this.selected);
    for (const [id, row] of this.cache) if (row.node.contains(document.activeElement)) pins.add(id);
    return pins;
  }
  private pagingLabel(): string {
    if (this.meta?.nextCursor) return 'More agents';
    const scan = this.meta?.scan;
    return scan?.state === 'ready' && !scan.complete && scan.scanId ? 'Load more agents' : '';
  }
  private controls(olderCount: number, query: string): HTMLElement[] {
    const controls: HTMLElement[] = [];
    if (olderCount) {
      setText(this.older, this.expanded ? 'Hide older agents' : `Show ${olderCount} older ${olderCount === 1 ? 'agent' : 'agents'}`);
      this.older.setAttribute('aria-expanded', String(this.expanded)); controls.push(this.older);
    }
    const label = this.pagingLabel();
    const searchMore = query && this.search && this.meta?.nextCursor && !this.searchController && !this.searchNotice;
    const pageMore = !query && label && (this.expanded || !olderCount);
    if (searchMore || pageMore) { cardActionLabel(this.paging, query ? 'More agents' : label); controls.push(this.paging); }
    return controls;
  }
  private paint(): void {
    const anchor = captureAnchor(this.layout, this.node.scrollTop); const pins = this.pins();
    const now = Date.now(); const filtered = this.filtered(); const query = this.query();
    const scoped = query ? filtered : filtered.filter(row => row.availability === 'live' || row.state === 'working' ||
      (isValidTimestamp(row.modifiedAt) && row.modifiedAt >= now - RECENT_AGE) || pins.has(row.identity) || this.resumes.has(row.identity));
    const olderCount = filtered.length - scoped.length;
    const rows = this.expanded && !query ? filtered : scoped;
    this.layout = layoutItems(rows.map(row => row.identity), this.heights, ROW_HEIGHT);
    if (anchor) pins.add(anchor.id);
    const selected = rows.length > 100 ? visibleWindow(this.layout, this.node.scrollTop, this.node.clientHeight, {pins}).items : this.layout.items;
    this.captions.update(this.rows);
    this.tails = new Map(this.rows.flatMap(row => {const tail = this.captions.get(row.identity).tail; return tail ? [[row.identity, tail]] : [];}));
    const children = this.children(selected, rows, this.tails);
    const controls = this.controls(olderCount, query);
    if (!rows.length && !olderCount) children.push(this.emptyState());
    children.push(...controls);
    reconcileChildren(this.node, children);
    for (const item of selected) {
      const node = this.cache.get(item.id)?.node; if (node && node.offsetHeight > 0) this.heights.set(item.id, node.offsetHeight);
    }
    this.layout = layoutItems(rows.map(row => row.identity), this.heights, ROW_HEIGHT);
    this.refreshGaps(selected);
    // List controls add scrollable height outside the row layout.
    const controlsHeight = controls.reduce((height, node) => height + node.offsetHeight, 0);
    const viewport = Math.max(0, this.node.clientHeight - controlsHeight);
    if (anchor) this.node.scrollTop = restoreAnchor(this.layout, anchor, viewport, this.node.scrollTop);
  }
  private gap(key: string, height: number): HTMLElement {
    let node = this.gaps.get(key);
    if (!node) { node = element('div', 'spacer'); node.setAttribute('aria-hidden', 'true'); this.gaps.set(key, node); }
    node.style.height = `${height}px`; return node;
  }
  private children(items: LayoutItem[], rows: AgentRow[], labels: Map<string, string>): HTMLElement[] {
    let offset = 0; const children: HTMLElement[] = [];
    for (const item of items) {
      if (item.top > offset) children.push(this.gap(item.id, item.top - offset));
      const row = rows[item.index]; if (!row) continue;
      children.push(this.row(row, labels.get(row.identity) ?? '').node); offset = item.bottom;
    }
    if (offset < this.layout.totalHeight) children.push(this.gap('tail', this.layout.totalHeight - offset));
    const keep = new Set(children); for (const [id, gap] of this.gaps) if (!keep.has(gap)) this.gaps.delete(id);
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
  private createRow(row: AgentRow): RowNode {
    const node = element('div', 'agent-row'); node.setAttribute('role', 'listitem');
    const select = button('', () => { const current = this.cache.get(row.identity)?.source; if (current) this.select(current); }, 'row-select');
    node.dataset.identity = row.identity;
    const heading = element('span', 'row-heading'); const state = element('span', 'row-state'); state.setAttribute('aria-hidden', 'true');
    const name = element('span', 'row-name'); const identity = element('code', 'row-identity muted'), preview=element('span','row-preview'); heading.append(name, identity, state,preview);
    const age = element('time', 'timestamp');
    const ageButton = button('', () => { cached.absolute = !cached.absolute; this.updateAge(cached, true); this.schedule(); }, 'row-age'); ageButton.append(age);
    const message = cardAction('message', 'Message', () => this.message?.(row.identity), 'row-message');
    select.append(heading); node.append(select, ageButton, message);
    const cached = {node, select, state, name, preview, identity, ageButton, message, age, source: row, absolute: false}; this.cache.set(row.identity, cached);
    return cached;
  }
  private updatePreview(cached: RowNode, source?: string): void {
    if (cached.previewSource !== source) {cached.previewSource = source; setText(cached.preview, rosterPreview(source ?? '')); cached.preview.title = cached.preview.textContent ?? '';}
    cached.preview.hidden = !cached.preview.textContent;
  }
  private row(row: AgentRow, identity: string): RowNode {
    const cached = this.cache.get(row.identity) ?? this.createRow(row);
    const state = this.resolvedStatus(row); setText(cached.state, state.activity || (state.label==='Ready'?'Idle':state.label)); cached.state.hidden = state.hideVisibleState === true || !cached.state.textContent; cached.state.title = state.label; cached.state.dataset.tone = state.tone ?? 'secondary'; setText(cached.name, state.name ?? rowName(row));
    const caption=this.captions.get(row.identity);cached.name.title=caption.source==='first-message'?'Title from first message, not a supplied name':'Conversation name';
    this.updatePreview(cached, row.latestReply);
    identity = state.name !== undefined ? state.tail ?? '' : identity; setText(cached.identity, identity); cached.identity.hidden = !identity; cached.identity.title = `Agent ID: ${row.identity}`;
    cached.identity.setAttribute('aria-label', cached.identity.title);
    cached.node.dataset.live = String(row.availability === 'live');
    cached.node.dataset.tool = String(!!state.tool);
    const reported = !state.tool && row.currentTool ? `Last reported tool · ${row.currentTool.name} · ${row.currentTool.argument}` : '';
    const description = [modelText(row), activityLine({...row, currentTool: state.tool}, state.label), reported, publishedRetryDescription(row)].filter(Boolean).join('\n');
    cached.select.title = description; cached.select.setAttribute('aria-description', [description, cached.preview.textContent ? `Preview: ${cached.preview.textContent}` : ''].filter(Boolean).join('\n'));
    cached.select.setAttribute('aria-current', row.identity === this.selected ? 'page' : 'false');
    cached.select.setAttribute('aria-label', `${this.displayName(row)} · ${row.identity} · ${state.label}`);
    cached.node.setAttribute('aria-label', this.displayName(row));
    cached.node.title = `${row.identity}\n${state.label}\n${row.ownerLabel ?? row.availability}`;
    cached.source = row; this.messageAction(cached); this.updateAge(cached);
    return cached;
  }
  private updateAge(cached: RowNode, deliberate = false): void {
    const row = cached.source; const now = deliberate ? Date.now() : this.arrivals.get(row.identity)?.now ?? Date.now();
    if (deliberate) this.arrivals.set(row.identity, {source: row, now});
    const label = cached.absolute ? absoluteTime(row.modifiedAt) : relativeTime(row.modifiedAt, now);
    const valid = row.modifiedAt > 0 && isValidTimestamp(row.modifiedAt) && !!label;
    cached.ageButton.dataset.absolute = String(cached.absolute);
    cached.ageButton.hidden = !valid; cached.ageButton.disabled = !valid; cached.ageButton.tabIndex = valid ? 0 : -1;
    setText(cached.age, valid ? cached.absolute ? label : compactAge(row.modifiedAt, now) : '');
    const details = valid ? timestampDetails(row.modifiedAt) : {exact: '', display: ''}; cached.age.dateTime = details.exact;
    cached.ageButton.title = valid ? `${details.exact} · ${details.display}` : '';
    cached.ageButton.setAttribute('aria-label', valid ? `Timestamp for ${this.displayName(row)} · ${label}` : '');
    cached.ageButton.setAttribute('aria-description', details.display);
  }
}
