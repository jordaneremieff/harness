import type { AgentRow, CachedRoster } from '../shared/api.ts';
import {cardAction, cardActionLabel} from './card-icons.ts';
import { byId, button, element, setText } from './dom.ts';
import { captureAnchor, layoutItems, restoreAnchor, visibleWindow } from './virtual.ts';
import type { LayoutItem, VirtualLayout } from './virtual.ts';
import { absoluteTime, compactAge, isValidTimestamp, previewText, relativeTime, timestampDetails } from './format.ts';
import { reconcileChildren } from './render.ts';
import {ConversationCaptions, agentName} from './tabs.ts';
import type {PresentationTone} from './conversation-presentation.ts';
import type {Attention} from './attention.ts';
import {parseMarkdown, type MarkdownBlock, type MarkdownInline} from './markdown.ts';

export type CachedPageSearch = {load: (cursor: string, signal: AbortSignal) => Promise<CachedRoster>; merge: (page: CachedRoster) => void};
export function savedRosterLabel(meta: Omit<CachedRoster,'rows'> | undefined, now = Date.now()): string {
  const observed = meta?.observedAt, at = Date.parse(observed ?? '');
  if (!meta?.stale && (!Number.isFinite(at) || now - at <= 300000)) return '';
  return Number.isFinite(at) && observed ? `Saved agent list · ${relativeTime(observed,now)}` : 'Saved agent list';
}
const SEARCH_PAGE_LIMIT = 20;
const ROW_HEIGHT = 30;
type RowNode = {node: HTMLElement; select: HTMLButtonElement; state: HTMLElement; name: HTMLElement; summary: HTMLElement; separator: HTMLElement; preview: HTMLElement; identity: HTMLElement; ageButton: HTMLButtonElement; message: HTMLButtonElement; age: HTMLTimeElement; source: AgentRow; absolute: boolean; previewSource?: string};
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
  return parseMarkdown(source).map(blockPreview).join(' ').replace(/\s+/g, ' ');
}
function rowName(row: AgentRow): string {return agentName(row.name, row.handle, row.identity, undefined, row.firstMessage);}
export type RosterStatus = {attention?: Attention; hideVisibleState?: boolean; glyph: string; label: string; tone?: PresentationTone; name?: string; tail?: string; tool?: AgentRow['currentTool']};
export function rosterWorking(row: AgentRow, status: RosterStatus): boolean {
  return status.label === 'Working' || status.hideVisibleState === true && row.availability === 'live' && row.state === 'working';
}
function servedFact(row: AgentRow, status: RosterStatus): string | undefined {
  if (status.attention) {
    const hint=row.attention;
    if(hint?.kind==='provider-blocked')return 'Provider blocked';
    if(hint?.kind==='failed-turn')return 'Turn failed';
    if(hint?.kind==='task-blocked')return hint.reason?`Task blocked: ${hint.reason.replaceAll('_',' ')}`:'Task blocked';
    return status.attention.label==='Failed'?'Turn failed':status.attention.title;
  }
  if (rosterWorking(row,status)) return status.tool ? `${status.tool.name} · ${status.tool.argument}` : undefined;
  return row.role;
}
function modelText(row: AgentRow): string {
  if (!row.model) return '';
  const thinking = row.model.thinkingLevel ?? row.thinkingLevel;
  return `${row.model.provider}/${row.model.modelId}${thinking ? ` · ${thinking}` : ''}`;
}
function rosterDescription(row:AgentRow,state:RosterStatus):string {
  const reported = !state.tool && row.currentTool ? `Last reported tool · ${row.currentTool.name} · ${row.currentTool.argument}` : '';
  return [state.attention?.title,modelText(row),state.label,state.tool ? `${state.tool.name} · ${state.tool.argument}` : '',row.role ? `Role: ${row.role}` : '',row.latestReply ? `Last reply: ${row.latestReply}` : '',reported,publishedRetryDescription(row)].filter(Boolean).join('\n');
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
  private focused?: string;
  private message?: (identity: string) => void;
  private resumes = new Set<string>();
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
  private filterBox = byId('agent-filter-box');
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
      event.preventDefault(); this.focusSearch(); searchField.value += event.key;
      this.node.scrollTop = 0; this.paint(); void this.searchCached();
    });
    this.node.addEventListener('scroll', () => this.schedule(), {passive: true});
  }
  focusSearch(): void { this.filterBox.hidden = false; byId<HTMLInputElement>('agent-search').focus(); }
  set(rows: AgentRow[], meta?: Omit<CachedRoster, 'rows'>, selected?: string, focused?: string): void {
    const now = Date.now();
    for (const row of rows) if (this.arrivals.get(row.identity)?.source !== row) this.arrivals.set(row.identity, {source: row, now});
    const incoming = new Map(rows.map(row => [row.identity, row]));
    this.rows = this.rows.flatMap(row => { const current = incoming.get(row.identity); incoming.delete(row.identity); return current ? [current] : []; });
    this.rows.push(...incoming.values()); this.selected = selected; this.focused = focused;
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
    this.searchNotice = 'Searching agents'; this.searchError = ''; this.footer(this.rows.length, this.meta, Date.now()); this.schedule();
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
  diagnostics(): string {
    const meta = this.meta;
    return [savedRosterLabel(meta),this.searchNotice,this.searchError,meta?.error?.message,meta ? `Agent scan: ${meta.scan.state}; complete: ${meta.scan.complete}; skipped: ${meta.scan.skipped}` : '',meta?.nextCursor ? 'More cached agent rows are available.' : ''].filter(Boolean).join('\n');
  }
  private footer(count: number, meta: Omit<CachedRoster, 'rows'> | undefined, now: number): void {
    const footer = byId('roster-footer'); footer.replaceChildren(); footer.hidden = true;
    byId('agent-refresh').title = ['Refresh agents',`${count} loaded`,savedRosterLabel(meta,now),this.diagnostics()].filter(Boolean).join('\n');
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
  private controls(query: string): HTMLElement[] {
    const controls: HTMLElement[] = [], label = this.pagingLabel();
    if (label && !this.searchController) {cardActionLabel(this.paging, query ? 'More agents' : label);controls.push(this.paging);}
    return controls;
  }
  private filterVisibility(query: string): void {
    this.filterBox.hidden = this.rows.length <= 8 && !query && document.activeElement !== byId('agent-search');
  }
  private priority(row: AgentRow): number {
    const status = this.rowStatus(row);return status.attention ? 0 : rosterWorking(row,status) ? 1 : row.handle ? 2 : 3;
  }
  private selectedRows(filtered: AgentRow[]): AgentRow[] {
    return filtered.sort((a,b)=>this.priority(a)-this.priority(b)||b.modifiedAt-a.modifiedAt);
  }
  private paint(): void {
    try {
    const anchor = captureAnchor(this.layout, this.node.scrollTop); const pins = this.pins();
    const filtered = this.filtered(); const query = this.query(); this.filterVisibility(query);
    const rows = this.selectedRows(filtered);
    this.layout = layoutItems(rows.map(row => row.identity), this.heights, ROW_HEIGHT);
    if (anchor) pins.add(anchor.id);
    const selected = rows.length > 100 ? visibleWindow(this.layout, this.node.scrollTop, this.node.clientHeight, {pins}).items : this.layout.items;
    this.captions.update(this.rows);
    this.tails = new Map(this.rows.flatMap(row => {const tail = this.captions.get(row.identity).tail; return tail ? [[row.identity, tail]] : [];}));
    const children = this.children(selected, rows, this.tails);
    if (!rows.length) children.push(element('p', 'secondary roster-empty', query ? 'No matching agents.' : 'No agents yet.'));
    const controls = this.controls(query);
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
    } catch (error) {try {window.reportClientError?.('Agents',error);} catch {} throw error;}
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
    const name = element('span', 'row-name'); const identity = element('code', 'row-identity muted'), preview=element('span','row-preview'); heading.append(name, identity);
    const summary = element('span', 'row-summary'), separator = element('span', 'row-separator', ' · '); separator.setAttribute('aria-hidden', 'true'); summary.append(state, separator, preview);
    const age = element('time', 'timestamp');
    const ageButton = button('', () => { cached.absolute = !cached.absolute; this.updateAge(cached, true); this.schedule(); }, 'row-age'); ageButton.append(age);
    const message = cardAction('message', 'Message', () => this.message?.(row.identity), 'row-message');
    ageButton.tabIndex = -1; message.tabIndex = -1;
    node.addEventListener('keydown', event => this.actionKey(event, [select, ageButton, message]));
    select.append(heading, summary); node.append(select, ageButton, message);
    const cached = {node, select, state, name, summary, separator, preview, identity, ageButton, message, age, source: row, absolute: false}; this.cache.set(row.identity, cached);
    return cached;
  }
  /** A row is one Tab stop; its age and message actions are reached with the horizontal arrow keys. */
  private actionKey(event: KeyboardEvent, controls: HTMLButtonElement[]): void {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const available = controls.filter(control => !control.hidden && !control.disabled);
    const index = available.indexOf(event.target as HTMLButtonElement); if (index < 0) return;
    const next = available[index + (event.key === 'ArrowRight' ? 1 : -1)]; if (!next) return;
    event.preventDefault(); next.focus();
  }
  private updatePreview(cached: RowNode, source?: string): void {
    if (cached.previewSource !== source) {cached.previewSource = source; setText(cached.preview, rosterPreview(source ?? '')); cached.preview.title = source ?? '';}
    cached.preview.hidden = !cached.preview.textContent;
    cached.separator.hidden = cached.state.hidden || cached.preview.hidden;
    cached.summary.hidden = cached.state.hidden && cached.preview.hidden;
  }
  private rowStatus(row: AgentRow): RosterStatus {
    const resolved = this.resolvedStatus(row);
    if (resolved.attention) return {...resolved, label: resolved.attention.label, tone: resolved.attention.tone, hideVisibleState: false};
    return resolved.hideVisibleState && rosterWorking(row, resolved)
      ? {...resolved, label: 'Working', tone: 'info', hideVisibleState: false} : resolved;
  }
  private row(row: AgentRow, identity: string): RowNode {
    const cached = this.cache.get(row.identity) ?? this.createRow(row);
    const state = this.rowStatus(row);
    const working = rosterWorking(row,state);
    setText(cached.state, state.attention ? 'Blocked' : working ? 'Working' : ''); cached.state.hidden = !cached.state.textContent; cached.state.title = state.attention?.title ?? state.label; cached.state.dataset.tone = state.tone ?? 'secondary'; cached.state.dataset.busy = String(working); setText(cached.name, state.name ?? rowName(row));
    const caption=this.captions.get(row.identity);cached.name.title=`${cached.name.textContent}\n${caption.source==='first-message'?'Title from first message, not a supplied name':'Conversation name'}`;
    cached.node.dataset.previewKind = state.attention ? 'failure' : working ? 'work' : 'role';
    const fact = servedFact(row,state);
    this.updatePreview(cached, fact); cached.node.dataset.detail = String(!cached.preview.hidden);
    identity = state.name !== undefined ? state.tail ?? '' : identity; setText(cached.identity, identity); cached.identity.hidden = !identity; cached.identity.title = `Agent ID: ${row.identity}`;
    cached.identity.setAttribute('aria-label', cached.identity.title);
    cached.node.dataset.live = String(row.availability === 'live');
    cached.node.dataset.tool = String(!!state.tool);
    const description = rosterDescription(row,state);
    cached.name.title = [cached.name.title,description].filter(Boolean).join('\n');
    cached.select.title = description; cached.select.setAttribute('aria-description', [description, cached.preview.textContent ? `Preview: ${cached.preview.textContent}` : ''].filter(Boolean).join('\n'));
    cached.select.setAttribute('aria-current', row.identity === this.focused ? 'page' : 'false');
    cached.select.setAttribute('aria-label', `${this.displayName(row)} · ${row.identity} · ${state.label}`);
    cached.node.setAttribute('aria-label', this.displayName(row));
    cached.node.title = `${row.identity}\n${description}\n${row.ownerLabel ?? row.availability}`;
    cached.source = row; this.messageAction(cached); this.updateAge(cached);
    return cached;
  }
  private updateAge(cached: RowNode, deliberate = false): void {
    const row = cached.source; const now = deliberate ? Date.now() : this.arrivals.get(row.identity)?.now ?? Date.now();
    if (deliberate) this.arrivals.set(row.identity, {source: row, now});
    const label = cached.absolute ? absoluteTime(row.modifiedAt) : relativeTime(row.modifiedAt, now);
    const state = this.rowStatus(row);
    const valid = !state.attention && !rosterWorking(row,state) && row.modifiedAt > 0 && isValidTimestamp(row.modifiedAt) && !!label;
    cached.ageButton.dataset.absolute = String(cached.absolute);
    cached.ageButton.hidden = !valid; cached.ageButton.disabled = !valid; cached.ageButton.tabIndex = -1;
    setText(cached.age, valid ? cached.absolute ? label : compactAge(row.modifiedAt, now) : '');
    const details = valid ? timestampDetails(row.modifiedAt) : {exact: '', display: ''}; cached.age.dateTime = details.exact;
    cached.ageButton.title = valid ? `${details.exact} · ${details.display}` : '';
    cached.ageButton.setAttribute('aria-label', valid ? `Timestamp for ${this.displayName(row)} · ${label}` : '');
    cached.ageButton.setAttribute('aria-description', details.display);
  }
}
