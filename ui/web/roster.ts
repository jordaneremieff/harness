import type { AgentRow, CachedRoster } from '../shared/api.ts';
import { byId, button, element, setText } from './dom.ts';
import { captureAnchor, layoutItems, restoreAnchor, visibleWindow } from './virtual.ts';
import type { LayoutItem, VirtualLayout } from './virtual.ts';
import { absoluteTime, isValidTimestamp, previewText, relativeTime, timestampDetails } from './format.ts';
import { reconcileChildren } from './render.ts';

export type CachedPageSearch = {load: (cursor: string, signal: AbortSignal) => Promise<CachedRoster>; merge: (page: CachedRoster) => void};
const SEARCH_PAGE_LIMIT = 20;
type RowNode = {node: HTMLElement; select: HTMLButtonElement; state: HTMLElement; name: HTMLElement; identity: HTMLElement; ageButton: HTMLButtonElement; message: HTMLButtonElement; age: HTMLTimeElement; model: HTMLElement; activity: HTMLElement; source: AgentRow; absolute: boolean};
function rowName(row: AgentRow): string { return row.name ?? row.handle ?? row.identity; }
function duplicateLabels(rows: AgentRow[]): Map<string, string> {
  const groups = new Map<string, AgentRow[]>();
  for (const row of rows) { const name = rowName(row); const group = groups.get(name) ?? []; group.push(row); groups.set(name, group); }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const candidates = group.map(row => row.identity.includes(':') ? row.identity.slice(row.identity.lastIndexOf(':') + 1) : row.identity.slice(0, 8));
    const counts = new Map<string, number>(); for (const candidate of candidates) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    for (const [index, row] of group.entries()) {
      const candidate = candidates[index] ?? row.identity;
      labels.set(row.identity, counts.get(candidate) === 1 ? candidate : row.identity);
    }
  }
  return labels;
}
function status(row: AgentRow): {glyph: string; label: string} {
  if (row.availability !== 'live') return {glyph: '◌', label: row.availability};
  const values: Record<string, string> = {working: '●', failed: '!', done: '✓', idle: '○'};
  return {glyph: values[row.state] ?? '◇', label: row.state};
}
function modelText(row: AgentRow): string {
  if (!row.model) return '';
  const thinking = row.model.thinkingLevel ?? row.thinkingLevel;
  return `${row.model.provider}/${row.model.modelId}${thinking ? ` · ${thinking}` : ''}`;
}
function activityText(row: AgentRow): string {
  if (row.error) return row.error;
  if (row.currentTool) return `${row.currentTool.name} · ${row.currentTool.argument}`;
  return row.latestReply ?? row.firstMessage ?? '';
}
/** Status label plus distinct detail; a row without detail shows its status once. */
export function activityLine(row: AgentRow, label: string): string {
  const detail = previewText(activityText(row), 1, 1200).text;
  if (!detail || detail === label) return row.availability === 'live' || label === row.state ? label : `${label} · ${row.state}`;
  return `${label} · ${detail}`;
}
export class Roster {
  private cache = new Map<string, RowNode>();
  private heights = new Map<string, number>();
  private arrivals = new Map<string, {source: AgentRow; now: number}>();
  private gaps = new Map<string, HTMLElement>();
  private rows: AgentRow[] = [];
  private selected?: string;
  private message?: (identity: string) => void;
  private resumes = new Set<string>();
  private pending = false;
  private meta?: Omit<CachedRoster, 'rows'>;
  private footerCount = -1;
  private search?: CachedPageSearch;
  private searchController?: AbortController;
  private searchQuery = '';
  private searchNotice = '';
  private layout: VirtualLayout = layoutItems([], new Map(), 110);
  private select: (row: AgentRow) => void;
  private more: (action?: 'refresh' | 'more') => void;
  private empty = element('p', 'empty-state');
  readonly node = byId('roster');
  constructor(select: (row: AgentRow) => void, more: (action?: 'refresh' | 'more') => void, search?: CachedPageSearch, message?: (identity: string) => void) {
    this.select = select; this.more = more; this.search = search; this.message = message;
    byId<HTMLInputElement>('agent-search').addEventListener('input', () => { this.node.scrollTop = 0; this.paint(); void this.searchCached(); });
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
  }
  focusMessage(identity: string): boolean {
    const cached = this.cache.get(identity);
    if (!cached || cached.message.hidden || !this.node.contains(cached.node)) return false;
    cached.message.focus(); return true;
  }
  private messageAction(cached: RowNode): void {
    cached.message.hidden = !!this.selected || !this.message;
    setText(cached.message, this.resumes.has(cached.source.identity) ? 'Resume' : 'Message');
    cached.message.setAttribute('aria-label', `${this.resumes.has(cached.source.identity) ? 'Resume message to' : 'Message'} ${rowName(cached.source)} · ${cached.source.identity}`);
  }
  private query(): string { return byId<HTMLInputElement>('agent-search').value.trim().toLocaleLowerCase(); }
  private async searchCached(more = false): Promise<void> {
    const query = this.query();
    if (query !== this.searchQuery) {
      this.searchController?.abort(); this.searchController = undefined; this.searchQuery = ''; this.searchNotice = '';
      this.footer(this.rows.length, this.meta, Date.now());
    }
    if (!this.search || !query || this.searchController || (!more && query === this.searchQuery)) return;
    const cursor = this.meta?.nextCursor;
    if (!cursor || (!more && this.filtered().length)) return;
    this.searchQuery = query; const controller = new AbortController(); this.searchController = controller;
    this.searchNotice = 'Searching cached pages'; this.footer(this.rows.length, this.meta, Date.now());
    try { await this.searchPages(this.search, query, cursor, controller); } catch (error) {
      if (!controller.signal.aborted) this.searchNotice = `Cached search failed: ${error instanceof Error ? error.message : String(error)}`;
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
      if (!page.nextCursor) { this.searchNotice = 'No more cached agents'; return; }
      cursor = page.nextCursor;
    }
    this.searchNotice = 'Cached search limit reached · 20 pages read';
  }
  private prune(ids: Set<string>): void {
    for (const [id, cached] of this.cache) if (!ids.has(id)) { cached.node.remove(); this.cache.delete(id); this.heights.delete(id); }
    for (const id of this.arrivals.keys()) if (!ids.has(id)) this.arrivals.delete(id);
  }
  private footer(count: number, meta: Omit<CachedRoster, 'rows'> | undefined, now: number): void {
    const footer = byId('roster-footer'); footer.replaceChildren();
    if (this.searchNotice) footer.append(element('p', 'roster-search-status', this.searchNotice));
    if (count && meta?.error) footer.append(element('p', 'error', `Roster discovery failed: ${meta.error.message}`));
    if (count && meta?.scan.state === 'running') footer.append(element('p', undefined, 'Loading roster'));
    if (meta?.observedAt) footer.append(element('p', undefined, `${meta.stale ? 'Saved roster' : 'Roster'} · ${relativeTime(meta.observedAt, now)}`));
    this.footerAction(footer, count, meta);
    if (meta?.scan.skipped) footer.append(element('p', undefined, 'Some records could not be read'));
  }
  private footerAction(footer: HTMLElement, count: number, meta?: Omit<CachedRoster, 'rows'>): void {
    if (this.query() && this.search) {
      this.cachedSearchAction(footer, meta); return;
    }
    const state = meta?.scan.state ?? 'not-started';
    if (meta?.nextCursor) footer.append(button(count > 0 ? `${count} shown · More` : 'More agents', () => this.more('more')));
    if (state === 'not-started') { footer.append(button('Refresh', () => this.more('refresh'))); return; }
    if (state === 'failed') { if (count) footer.append(button('Retry', () => this.more('refresh'))); return; }
    if (meta?.nextCursor || state !== 'ready' || meta?.scan.complete) return;
    if (count > 0) footer.append(button(`${count} shown · More`, () => this.more('more')));
    else if (meta?.scan.scanId) footer.append(button('Continue roster scan', () => this.more('more')));
  }
  private cachedSearchAction(footer: HTMLElement, meta?: Omit<CachedRoster, 'rows'>): void {
    if (meta?.nextCursor && !this.searchController) footer.append(button('More cached agents', () => { void this.searchCached(true); }));
  }
  private emptyState(): HTMLElement {
    let text: string;
    if (this.rows.length) text = 'No loaded agents match';
    else {
      switch (this.meta?.scan.state ?? 'not-started') {
        case 'not-started': text = 'Roster not loaded'; break;
        case 'running': text = 'Loading roster'; break;
        case 'failed': text = `Roster discovery failed${this.meta?.error ? `: ${this.meta.error.message}` : ''}`; break;
        case 'ready': text = 'No agents in this view'; break;
      }
    }
    const failed = this.meta?.scan.state === 'failed' && !this.rows.length;
    this.empty.className = failed ? 'roster-error error' : 'empty-state';
    if (failed) this.empty.replaceChildren(element('span', undefined, text), button('Retry', () => this.more('refresh')));
    else setText(this.empty, text);
    return this.empty;
  }
  schedule(): void {
    if (this.pending) return;
    this.pending = true; requestAnimationFrame(() => { this.pending = false; this.paint(); });
  }
  private filtered(): AgentRow[] {
    const query = this.query();
    return this.rows.filter(row => `${row.identity} ${row.name ?? ''} ${row.handle ?? ''} ${modelText(row)}`.toLocaleLowerCase().includes(query));
  }
  private pins(): Set<string> {
    const pins = new Set<string>(); if (this.selected) pins.add(this.selected);
    for (const [id, row] of this.cache) if (row.node.contains(document.activeElement)) pins.add(id);
    return pins;
  }
  private paint(): void {
    const anchor = captureAnchor(this.layout, this.node.scrollTop); const rows = this.filtered();
    this.layout = layoutItems(rows.map(row => row.identity), this.heights, 110);
    const pins = this.pins(); if (anchor) pins.add(anchor.id);
    const selected = rows.length > 100 ? visibleWindow(this.layout, this.node.scrollTop, this.node.clientHeight, {pins}).items : this.layout.items;
    const children = this.children(selected, rows, duplicateLabels(this.rows));
    if (!children.length) children.push(this.emptyState());
    reconcileChildren(this.node, children);
    for (const item of selected) {
      const node = this.cache.get(item.id)?.node; if (node && node.offsetHeight > 0) this.heights.set(item.id, node.offsetHeight);
    }
    this.layout = layoutItems(rows.map(row => row.identity), this.heights, 110);
    this.refreshGaps(selected);
    if (anchor) this.node.scrollTop = restoreAnchor(this.layout, anchor, this.node.clientHeight, this.node.scrollTop);
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
    const name = element('span', 'row-name'); const identity = element('code', 'row-identity muted'); heading.append(state, name, identity);
    const age = element('time', 'timestamp');
    const ageButton = button('', () => { cached.absolute = !cached.absolute; this.updateAge(cached, true); }, 'row-age'); ageButton.append(age);
    const model = element('div', 'row-model'); const activity = element('div', 'row-activity');
    const message = button('Message', () => this.message?.(row.identity), 'row-message');
    select.append(heading, model, activity); node.append(select, ageButton, message);
    const cached = {node, select, state, name, identity, ageButton, message, age, model, activity, source: row, absolute: false}; this.cache.set(row.identity, cached);
    return cached;
  }
  private row(row: AgentRow, identity: string): RowNode {
    const cached = this.cache.get(row.identity) ?? this.createRow(row); const changed = cached.source !== row;
    const state = status(row); setText(cached.state, state.glyph); setText(cached.name, rowName(row));
    setText(cached.identity, identity); cached.identity.hidden = !identity;
    cached.state.dataset.state = row.availability === 'live' ? row.state : 'retained';
    setText(cached.model, modelText(row)); cached.model.hidden = !cached.model.textContent;
    setText(cached.activity, activityLine(row, state.label));
    cached.select.setAttribute('aria-current', row.identity === this.selected ? 'page' : 'false');
    cached.select.setAttribute('aria-label', `${rowName(row)} · ${row.identity} · ${state.label}`);
    cached.node.setAttribute('aria-label', rowName(row));
    cached.node.title = `${row.identity}\n${state.label}\n${row.ownerLabel ?? row.availability}`;
    cached.source = row; this.messageAction(cached); if (changed || !cached.age.textContent) this.updateAge(cached);
    return cached;
  }
  private updateAge(cached: RowNode, deliberate = false): void {
    const row = cached.source; const now = deliberate ? Date.now() : this.arrivals.get(row.identity)?.now ?? Date.now();
    const label = cached.absolute ? absoluteTime(row.modifiedAt) : relativeTime(row.modifiedAt, now);
    const valid = isValidTimestamp(row.modifiedAt) && !!label;
    cached.ageButton.dataset.absolute = String(cached.absolute);
    cached.ageButton.hidden = !valid; cached.ageButton.disabled = !valid; cached.ageButton.tabIndex = valid ? 0 : -1;
    setText(cached.age, label);
    const details = timestampDetails(row.modifiedAt); cached.age.dateTime = details.exact;
    cached.ageButton.title = valid ? `${details.exact} · ${details.display}` : '';
    cached.ageButton.setAttribute('aria-label', valid ? `Timestamp for ${rowName(row)} · ${label}` : '');
    cached.ageButton.setAttribute('aria-description', details.display);
  }
}
