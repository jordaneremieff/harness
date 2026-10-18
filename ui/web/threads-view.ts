import type {ErrorView, ThreadEventView, ThreadListItem, ThreadOverview, ThreadPageView, ThreadView} from '../shared/api.ts';
import {button, byId, details, element, setText} from './dom.ts';
import {absoluteTime} from './format.ts';
import {navigateOptions} from './list-navigation.ts';
import {markdownDom} from './safe-markdown.ts';
import {
  FRAME_LABELS, THREAD_FILTER_THRESHOLD, emptyListText, eventTime, exchangeRows, filterThreads, mergeEvents, noteFitsInline, olderBoundary,
  overviewLines, pageEvents, prependEvents, purposeNeedsExpansion, threadCount, threadMeta, type ExchangeRow, type FrameChange, type ThreadNameFor} from './threads.ts';

const SECTION_KEY = 'ui:sections:threads';
const OPERATOR = 'Operator';
const NOT_OFFERED = 'Threads are not available from this agent host.';
const REFRESH_AFTER_MS = 10_000;

/** The label for a conversation identity. It always answers: a short identity stands in when the browser holds no name. */
export type KnownName = (identity: string) => string;
function errorView(error: unknown): ErrorView | undefined {
  const view = (error as {view?: ErrorView} | undefined)?.view;
  return view && typeof view.code === 'string' ? view : undefined;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The request failed.'; }
function nameFor(known: KnownName): ThreadNameFor {
  return (identity, origin) => origin === 'operator' ? OPERATOR : known(identity);
}

export type ExplorerHooks = {
  overview(signal: AbortSignal): Promise<ThreadOverview>;
  name: KnownName;
  open(item: ThreadListItem, row: HTMLElement): void;
};
/** The THREADS section of the sidebar. It reads nothing until it is opened. */
export class ThreadExplorer {
  private readonly hooks: ExplorerHooks;
  private readonly section = byId('threads-section');
  private readonly heading = byId('threads-heading');
  private readonly body = byId('threads-section-body');
  private readonly count = byId('threads-count');
  private readonly refreshButton = byId<HTMLButtonElement>('threads-refresh');
  private readonly filterBox = byId('threads-filter-box');
  private readonly filter = byId<HTMLInputElement>('threads-filter');
  private readonly list = byId('threads-list');
  private readonly footer = byId('threads-footer');
  private collapsed = true;
  private overview?: ThreadOverview;
  private failure?: unknown;
  private loading = false;
  private loadedAt = 0;
  private controller?: AbortController;
  private current?: string;
  private lastNames = '';
  constructor(hooks: ExplorerHooks) {
    this.hooks = hooks;
    try { this.collapsed = sessionStorage.getItem(SECTION_KEY) !== 'false'; } catch { this.collapsed = true; }
    this.heading.addEventListener('click', () => this.toggle(!this.collapsed));
    this.refreshButton.addEventListener('click', () => { if (!this.collapsed) void this.load(); });
    this.filter.addEventListener('input', () => this.paint());
    this.filter.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.filter.value) return;
      event.preventDefault(); event.stopPropagation(); this.filter.value = ''; this.paint();
    });
    this.list.addEventListener('keydown', event => navigateOptions(event, this.list));
    this.paint();
    if (!this.collapsed) void this.load();
  }
  get items(): readonly ThreadListItem[] { return this.overview?.items ?? []; }
  get expanded(): boolean { return !this.collapsed; }
  /** Marks the row whose thread the reader shows. */
  setCurrent(id: string | undefined): void { if (this.current !== id) { this.current = id; this.paint(); } }
  focusRow(id: string): boolean {
    const row = this.rowFor(id);
    if (!row || this.collapsed) return false;
    row.focus({preventScroll: false}); return true;
  }
  private rowFor(id: string): HTMLButtonElement | undefined {
    return [...this.list.querySelectorAll<HTMLButtonElement>('button')].find(row => row.dataset.threadId === id);
  }
  /** Names can arrive after the list does, so the footer's agent names repaint on change. */
  refreshNames(): void { const names = this.nameSignature(); if (names !== this.lastNames) this.paint(); }
  /** Brings the list up to date after the page was hidden, at most once per interval. */
  refreshIfStale(now = Date.now()): void { if (!this.collapsed && !this.loading && now - this.loadedAt >= REFRESH_AFTER_MS) void this.load(); }
  private toggle(collapsed: boolean): void {
    this.collapsed = collapsed;
    try { sessionStorage.setItem(SECTION_KEY, String(collapsed)); } catch { /* The current tab keeps the section state in memory. */ }
    this.paint();
    if (!collapsed && !this.overview && !this.loading) void this.load();
  }
  async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController(); this.controller = controller; this.loading = true; this.paint();
    try {
      const overview = await this.hooks.overview(controller.signal);
      if (controller.signal.aborted) return;
      this.overview = overview; this.failure = undefined; this.loadedAt = Date.now();
    } catch (error) {
      if (controller.signal.aborted) return;
      this.failure = error;
    } finally {
      if (this.controller === controller) { this.loading = false; this.controller = undefined; this.paint(); }
    }
  }
  private nameSignature(): string {
    const ids = [...(this.overview?.storages ?? [])].filter(state => state.state !== 'answered').map(state => state.storageId);
    return ids.map(id => `${id}=${this.hooks.name(id)}`).join('|');
  }
  private paint(): void {
    const overview = this.overview;
    this.section.dataset.collapsed = String(this.collapsed);
    this.heading.setAttribute('aria-expanded', String(!this.collapsed));
    this.body.hidden = this.collapsed;
    const count = threadCount(overview); setText(this.count, count); this.count.hidden = !this.collapsed || !count;
    this.refreshButton.disabled = this.loading || this.collapsed;
    const query = this.filter.value.trim();
    this.filterBox.hidden = !(overview && (overview.items.length > THREAD_FILTER_THRESHOLD || query));
    this.lastNames = this.nameSignature();
    if (this.collapsed) return;
    const items = overview ? filterThreads(overview.items, query) : [];
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.threadId : undefined;
    const now = Date.now();
    this.list.replaceChildren(...items.map(item => this.row(item, now)));
    if (focused) this.rowFor(focused)?.focus({preventScroll: true});
    this.footer.replaceChildren(...this.footerNodes(overview, query, items.length));
  }
  private footerNodes(overview: ThreadOverview | undefined, query: string, shown: number): HTMLElement[] {
    const lines: HTMLElement[] = [];
    if (this.loading) lines.push(element('p', 'threads-note', overview ? 'Refreshing threads…' : 'Reading threads…'));
    if (this.failure !== undefined) {
      const failed = element('p', 'threads-note threads-failure', 'Threads could not be listed.');
      lines.push(failed, details('Details', errorText(this.failure)), button('Try again', () => { void this.load(); }, 'threads-retry'));
    }
    if (!overview) return lines;
    if (query && !shown && overview.items.length) lines.push(element('p', 'threads-note', 'No threads match.'));
    else if (!overview.items.length) lines.push(element('p', 'threads-note', emptyListText(overview)));
    for (const text of overviewLines(overview)) lines.push(element('p', 'threads-note', text));
    const trouble = overview.storages.filter(state => state.state !== 'answered');
    if (trouble.length) lines.push(details('Details', trouble.map(state => this.troubleLine(state)).join('\n')));
    return lines;
  }
  private troubleLine(state: ThreadOverview['storages'][number]): string {
    const name = this.hooks.name(state.storageId);
    return `${name}: ${state.state === 'unavailable' ? 'does not offer threads' : `did not answer${state.message ? ` (${state.message})` : ''}`}`;
  }
  private row(item: ThreadListItem, now: number): HTMLElement {
    const entry = element('li', 'thread-item');
    const row = element('button', `nav-row thread-row${item.closed ? ' closed' : ''}`);
    row.type = 'button'; row.dataset.threadId = item.id;
    const meta = threadMeta(item, now);
    row.append(element('span', 'row-title', item.title || 'Untitled thread'), element('span', 'row-meta', meta));
    row.title = [item.title, item.purpose, meta, item.updatedAt ? `Updated ${absoluteTime(item.updatedAt)}` : ''].filter(Boolean).join('\n');
    row.setAttribute('aria-label', `${item.title || 'Untitled thread'}, ${meta}`);
    if (item.id === this.current) row.setAttribute('aria-current', 'page');
    row.addEventListener('click', () => this.hooks.open(item, row));
    entry.append(row); return entry;
  }
}

export type ReaderHooks = {
  page(threadId: string, before: number | undefined, signal: AbortSignal): Promise<ThreadPageView>;
  name: KnownName;
  /** Opens the member's conversation in the pane that shows the reader. */
  openMember(identity: string): void;
  /** Leaves the reader and shows the pane's conversation again. */
  back(): void;
};
type Cached = {item: ThreadListItem; thread?: ThreadView; events: ThreadEventView[]; observedAt?: string};
/** Scroll positions outlive the cached content, so a thread read long ago still reopens where it was left. */
const SCROLL_LIMIT = 50;
type Failure = {kind: 'unavailable'} | {kind: 'failed'; message: string};
const CACHE_LIMIT = 8;

/** A read-only view of one thread. One instance serves the whole page and is placed in the pane that opened it. */
export class ThreadReader {
  readonly node = element('section', 'thread-reader');
  private readonly hooks: ReaderHooks;
  private readonly title = element('h2', 'inspection-title thread-title');
  private readonly status = element('p', 'inspection-status thread-status');
  private readonly refreshButton: HTMLButtonElement;
  private readonly scroller = element('div', 'thread-scroll');
  private readonly frame = element('div', 'thread-frame');
  private readonly earlier: HTMLButtonElement;
  private readonly exchange = element('ol', 'thread-exchange');
  private readonly notice = element('div', 'thread-notice');
  private readonly cache = new Map<string, Cached>();
  private readonly rows = new Map<number, {signature: string; node: HTMLElement}>();
  private entry?: Cached;
  private failure?: Failure;
  private loading = false;
  private loadingEarlier = false;
  private controller?: AbortController;
  private earlierController?: AbortController;
  private serial = 0;
  private earlierSerial = 0;
  private readonly scrolls = new Map<string, number | 'end'>();
  private restorePending = false;
  private framed = '';
  private lastNames = '';
  private loadedAt = 0;
  constructor(hooks: ReaderHooks) {
    this.hooks = hooks; this.node.hidden = true;
    this.node.setAttribute('aria-label', 'Thread');
    const header = element('div', 'inspection-header');
    header.append(this.title, button('Back to conversation', () => this.hooks.back(), 'inspection-back'));
    this.status.setAttribute('role', 'status');
    this.refreshButton = button('Refresh thread', () => { void this.refresh(); }, 'thread-refresh');
    const meta = element('div', 'thread-meta'); meta.append(this.status, this.refreshButton);
    this.earlier = button('Load earlier events', () => { void this.loadEarlier(); }, 'thread-earlier');
    this.scroller.tabIndex = 0; this.scroller.setAttribute('aria-label', 'Thread exchange');
    this.exchange.setAttribute('aria-label', 'Events, oldest first');
    this.scroller.append(this.frame, this.earlier, this.exchange, this.notice);
    this.node.append(header, meta, this.scroller);
    this.scroller.addEventListener('scroll', () => this.rememberScroll(), {passive: true});
    this.node.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); this.hooks.back();
    });
  }
  get active(): ThreadListItem | undefined { return this.node.hidden ? undefined : this.entry?.item; }
  get scrollNode(): HTMLElement { return this.scroller; }
  /** Shows a thread. A thread read earlier in this page appears at once at its old position, then refreshes. */
  open(item: ThreadListItem): void {
    this.rememberScroll(); this.cancel(); this.failure = undefined;
    const cached = this.cache.get(item.id);
    this.entry = cached ? {...cached, item} : {item, events: []};
    this.restorePending = !cached?.events.length && this.scrollOf(item.id) !== 'end';
    this.cache.delete(item.id); this.cache.set(item.id, this.entry);
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    this.rows.clear(); this.framed = '';
    this.node.hidden = false; this.paint(); this.restoreScroll();
    void this.refresh();
  }
  /** Leaves the thread without forgetting it; its scroll position stays for this page. */
  close(): void {
    this.rememberScroll(); this.cancel();
    this.node.hidden = true; this.paintControls();
  }
  private cancel(): void {
    this.controller?.abort(); this.earlierController?.abort(); this.serial++; this.earlierSerial++;
    this.controller = undefined; this.earlierController = undefined; this.loading = false; this.loadingEarlier = false;
  }
  /** Brings an open thread up to date after the page was hidden, at most once per interval. */
  refreshIfStale(now = Date.now()): void { if (this.active && !this.loading && now - this.loadedAt >= REFRESH_AFTER_MS) void this.refresh(); }
  /** Names can arrive after the thread does. */
  refreshNames(): void { if (this.active && this.nameSignature() !== this.lastNames) { this.rows.clear(); this.framed = ''; this.paint(); } }
  focus(): void { this.scroller.focus({preventScroll: true}); }
  private nameSignature(): string {
    const entry = this.entry; if (!entry) return '';
    const ids = new Set<string>([...entry.events.map(event => event.sender), ...(entry.thread?.members.map(member => member.identity) ?? []), ...(entry.thread?.integrator ? [entry.thread.integrator] : [])]);
    return [...ids].map(id => `${id}=${this.hooks.name(id)}`).join('|');
  }
  private rememberScroll(): void {
    const entry = this.entry; if (!entry || this.node.hidden || this.restorePending) return;
    const node = this.scroller;
    this.scrolls.delete(entry.item.id);
    this.scrolls.set(entry.item.id, node.scrollHeight - node.scrollTop - node.clientHeight <= 24 ? 'end' : node.scrollTop);
    while (this.scrolls.size > SCROLL_LIMIT) this.scrolls.delete(this.scrolls.keys().next().value as string);
  }
  private restoreScroll(): void {
    const entry = this.entry; if (!entry) return;
    const scroll = this.scrollOf(entry.item.id);
    this.scroller.scrollTop = scroll === 'end' ? this.scroller.scrollHeight : scroll;
  }
  private scrollOf(id: string): number | 'end' { return this.scrolls.get(id) ?? 'end'; }
  async refresh(): Promise<void> {
    const entry = this.entry; if (!entry) return;
    this.controller?.abort();
    const controller = new AbortController(), serial = ++this.serial; this.controller = controller;
    this.loading = true; this.failure = undefined; this.paintControls();
    try {
      const page = await this.hooks.page(entry.item.id, undefined, controller.signal);
      if (serial !== this.serial) return;
      this.take(entry, page, false);
      this.loadedAt = Date.now();
    } catch (error) {
      if (serial !== this.serial || controller.signal.aborted) return;
      this.failure = this.classify(error);
    } finally {
      if (serial === this.serial) { this.loading = false; this.controller = undefined; this.paint(); }
    }
  }
  private async loadEarlier(): Promise<void> {
    const entry = this.entry, before = entry ? olderBoundary(entry.events) : null;
    if (!entry || before === null || this.loadingEarlier) return;
    const controller = new AbortController(), serial = ++this.earlierSerial;
    this.earlierController = controller; this.loadingEarlier = true; this.failure = undefined; this.paintControls();
    try {
      const page = await this.hooks.page(entry.item.id, before, controller.signal);
      if (serial !== this.earlierSerial) return;
      const node = this.scroller, height = node.scrollHeight, top = node.scrollTop;
      this.take(entry, page, true); this.paint();
      node.scrollTop = top + (node.scrollHeight - height);
    } catch (error) {
      if (serial !== this.earlierSerial || controller.signal.aborted) return;
      this.failure = this.classify(error);
    } finally {
      if (serial === this.earlierSerial) { this.loadingEarlier = false; this.earlierController = undefined; this.paint(); }
    }
  }
  private classify(error: unknown): Failure {
    return errorView(error)?.code === 'threads_unavailable' ? {kind: 'unavailable'} : {kind: 'failed', message: errorText(error)};
  }
  private take(entry: Cached, page: ThreadPageView, older: boolean): void {
    if (page.thread.id !== entry.item.id) throw new Error('The host answered for a different thread.');
    entry.thread = page.thread; entry.observedAt = page.observedAt;
    entry.events = older ? prependEvents(pageEvents(page), entry.events) : mergeEvents(entry.events, pageEvents(page));
  }
  private paintControls(): void {
    this.refreshButton.disabled = this.loading || this.loadingEarlier;
    const entry = this.entry, more = entry ? olderBoundary(entry.events) !== null : false;
    this.earlier.hidden = !more || !!this.failure && !entry?.events.length;
    this.earlier.disabled = this.loadingEarlier;
    setText(this.earlier, this.loadingEarlier ? 'Loading earlier events…' : 'Load earlier events');
  }
  private paint(): void {
    const entry = this.entry; if (!entry) return;
    const wasEnd = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= 24;
    const thread = entry.thread, name = nameFor(this.hooks.name);
    this.lastNames = this.nameSignature();
    setText(this.title, thread?.title || entry.item.title || 'Thread');
    setText(this.status, this.statusText(thread)); this.status.title = thread?.integrator ? `Integrator ${thread.integrator}` : '';
    this.paintFrame(thread);
    const wanted = exchangeRows(entry.events, name).map(row => this.rowNode(row));
    this.exchange.replaceChildren(...wanted);
    const present = new Set(entry.events.map(event => event.sequence));
    for (const key of [...this.rows.keys()]) if (!present.has(key)) this.rows.delete(key);
    this.notice.replaceChildren(...this.noticeNodes(entry));
    this.paintControls();
    if (this.restorePending && entry.thread) { this.restorePending = false; this.restoreScroll(); }
    else if (wasEnd && this.scrollOf(entry.item.id) === 'end') this.scroller.scrollTop = this.scroller.scrollHeight;
  }
  private statusText(thread: ThreadView | undefined): string {
    if (!thread) return this.loading ? 'Reading thread…' : '';
    const integrator = thread.integrator ? this.hooks.name(thread.integrator) : '';
    const updated = thread.updatedAt ? `Updated ${eventTime(thread.updatedAt, Date.now())}` : '';
    return [thread.closed ? 'Closed' : 'Open', `${thread.members.length} ${thread.members.length === 1 ? 'member' : 'members'}`, integrator ? `Integrator ${integrator}` : '', updated, this.loading ? 'Refreshing…' : ''].filter(Boolean).join(' · ');
  }
  private noticeNodes(entry: Cached): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    if (this.loading && !entry.thread) nodes.push(element('p', 'thread-note', 'Reading thread…'));
    const failure = this.failure;
    if (failure?.kind === 'unavailable') nodes.push(element('p', 'thread-note thread-failure', NOT_OFFERED));
    else if (failure) {
      nodes.push(element('p', 'thread-note thread-failure', entry.thread ? 'The thread could not be refreshed. Showing what was read before.' : 'The thread could not be read.'),
        details('Details', failure.message), button('Try again', () => { void this.refresh(); }, 'thread-retry'));
    }
    if (entry.thread && !entry.events.length && !failure && !this.loading) nodes.push(element('p', 'thread-note', 'No events yet.'));
    return nodes;
  }
  private paintFrame(thread: ThreadView | undefined): void {
    const signature = JSON.stringify([thread, this.lastNames]);
    if (signature === this.framed) return;
    this.framed = signature;
    if (!thread) { this.frame.replaceChildren(); return; }
    const parts: HTMLElement[] = [];
    if (thread.purpose) {
      const purpose = element('div', 'thread-purpose'); purpose.append(markdownDom(thread.purpose));
      const long = purposeNeedsExpansion(thread.purpose); purpose.dataset.expanded = String(!long);
      parts.push(purpose);
      if (long) {
        const toggle = button('Show more', () => {
          const expanded = purpose.dataset.expanded !== 'true'; purpose.dataset.expanded = String(expanded); setText(toggle, expanded ? 'Show less' : 'Show more');
          toggle.setAttribute('aria-expanded', String(expanded));
        }, 'thread-toggle');
        toggle.setAttribute('aria-expanded', 'false'); parts.push(toggle);
      }
    }
    parts.push(this.members(thread), this.frameDetails(thread));
    this.frame.replaceChildren(...parts);
  }
  private members(thread: ThreadView): HTMLElement {
    const box = element('details', 'thread-members'); box.open = thread.members.length <= 4;
    box.append(element('summary', undefined, `Members (${thread.members.length})`));
    const list = element('ul', 'thread-member-list');
    for (const member of thread.members) {
      const item = element('li', 'thread-member');
      const label = this.hooks.name(member.identity);
      const who = button(label, () => this.hooks.openMember(member.identity), 'thread-person');
      who.title = member.identity; who.setAttribute('aria-label', `Open ${label}`);
      item.append(who);
      if (member.identity === thread.integrator) item.append(element('span', 'thread-role', 'integrator'));
      if (member.contribution) { const line = element('p', 'thread-contribution', member.contribution); line.title = member.contribution; item.append(line); }
      list.append(item);
    }
    box.append(list); return box;
  }
  private frameDetails(thread: ThreadView): HTMLElement {
    const box = element('details', 'thread-frame-details'); box.append(element('summary', undefined, 'Details'));
    for (const [field, label] of FRAME_LABELS) {
      if (field === 'title' || field === 'purpose' || field === 'integrator') continue;
      const value = thread[field]; if (!value) continue;
      const section = element('section', 'thread-fact'); section.append(element('h3', undefined, label)); const text = element('div', 'thread-prose'); text.append(markdownDom(value)); section.append(text); box.append(section);
    }
    const created = element('p', 'thread-note', `Created ${absoluteTime(thread.createdAt)} · revision ${thread.revision}`); box.append(created);
    return box;
  }
  private rowNode(row: ExchangeRow): HTMLElement {
    const signature = JSON.stringify([row, this.hooks.name(row.sender)]);
    const cached = this.rows.get(row.sequence);
    if (cached?.signature === signature) return cached.node;
    const node = row.type === 'message' ? this.messageNode(row) : this.lineNode(row);
    node.dataset.sequence = String(row.sequence);
    this.rows.set(row.sequence, {signature, node}); return node;
  }
  private messageNode(row: Extract<ExchangeRow, {type: 'message'}>): HTMLElement {
    const item = element('li', 'thread-event thread-message');
    item.dataset.kind = row.carried ? 'carried-authority' : 'contribution';
    const head = element('div', 'thread-event-head');
    const label = row.origin === 'operator' ? OPERATOR : this.hooks.name(row.sender);
    if (row.origin === 'operator') head.append(element('span', 'thread-sender', label));
    else { const who = button(label, () => this.hooks.openMember(row.sender), 'thread-sender'); who.title = row.sender; who.setAttribute('aria-label', `Open ${label}`); head.append(who); }
    if (row.carried) head.append(element('span', 'thread-kind', 'Carried authority'));
    const time = element('time', 'thread-time', eventTime(row.at, Date.now())); time.dateTime = new Date(row.at).toISOString(); time.title = absoluteTime(row.at); head.append(time);
    item.append(head);
    if (row.replyToName) item.append(element('p', 'thread-reply', `In reply to ${row.replyToName}`));
    const prose = element('div', 'thread-prose'); prose.append(markdownDom(row.message)); item.append(prose);
    if (row.source) item.append(element('p', 'thread-source', `Source: ${row.source}`));
    return item;
  }
  private lineNode(row: Extract<ExchangeRow, {type: 'line'}>): HTMLElement {
    const item = element('li', 'thread-event thread-line');
    const text = element('p', 'thread-line-text', row.text);
    const time = element('time', 'thread-time', eventTime(row.at, Date.now())); time.dateTime = new Date(row.at).toISOString(); time.title = absoluteTime(row.at);
    text.append(document.createTextNode(' '), time);
    item.append(text);
    if (row.note !== undefined) {
      if (noteFitsInline(row.note)) item.append(element('p', 'thread-line-note', row.note));
      else { const more = element('details', 'thread-line-details'); more.append(element('summary', undefined, 'Details'), element('p', 'thread-line-note', row.note)); item.append(more); }
    }
    if (row.changes?.length) item.append(this.changesNode(row.changes));
    return item;
  }
  private changesNode(changes: FrameChange[]): HTMLElement {
    const more = element('details', 'thread-line-details'); more.append(element('summary', undefined, 'Details'));
    for (const change of changes) {
      const section = element('section', 'thread-change'); section.append(element('h3', undefined, change.label));
      const before = element('div', 'thread-prose thread-before'), after = element('div', 'thread-prose thread-after');
      before.append(element('span', 'thread-change-label', 'Before'), document.createTextNode(change.before || 'Empty'));
      after.append(element('span', 'thread-change-label', 'After'), document.createTextNode(change.after || 'Empty'));
      section.append(before, after); more.append(section);
    }
    return more;
  }
}

