import type {AgentRow, ErrorView, ThreadEventView, ThreadListItem, ThreadOverview, ThreadPageView, ThreadView} from '../shared/api.ts';
import {button, byId, copy, details, element, setText} from './dom.ts';
import {absoluteTime, compactAge} from './format.ts';
import {navigateOptions} from './list-navigation.ts';
import {markdownDom} from './safe-markdown.ts';
import {
  FRAME_LABELS, THREAD_FILTER_THRESHOLD, eventTime, exchangeRows, filterThreads, mergeEvents, noteFitsInline, olderBoundary,
  overviewLines, pageEvents, prependEvents, purposeNeedsExpansion, threadMeta, type ExchangeRow, type FrameChange, type ThreadNameFor} from './threads.ts';

const OPERATOR = 'You';
const NOT_OFFERED = 'Threads are not available from this agent host.';
const REFRESH_AFTER_MS = 10_000;

/** An exact thread identity opens directly, even before its list metadata is available. */
export type ThreadEntry = Pick<ThreadListItem, 'id'> & Partial<Omit<ThreadListItem, 'id'>>;
/** The shared caption for a conversation identity. */
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
/** The Threads destination shows every loaded thread within the overview's existing bounds. */
export class ThreadExplorer {
  private readonly hooks: ExplorerHooks;
  private readonly body = byId('threads-section-body');
  private readonly refreshButton = byId<HTMLButtonElement>('threads-refresh');
  private readonly filterBox = byId('threads-filter-box');
  private readonly filter = byId<HTMLInputElement>('threads-filter');
  private readonly list = byId('threads-list');
  private readonly footer = byId('threads-footer');
  private readonly retry = button('Threads did not load · Retry',()=>{void this.load();},'nav-row sidebar-action');
  private overview?: ThreadOverview;
  private failure?: unknown;
  private loading = false;
  private loadedAt = 0;
  private controller?: AbortController;
  private current?: string;
  private lastNames = '';
  constructor(hooks: ExplorerHooks) {
    this.hooks = hooks;
    this.refreshButton.addEventListener('click', () => { void this.load(); });
    this.filter.addEventListener('input', () => this.paint());
    this.filter.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.filter.value) return;
      event.preventDefault(); event.stopPropagation(); this.filter.value = ''; this.paint();
    });
    this.list.addEventListener('keydown', event => navigateOptions(event, this.list));
    this.paint();
    void this.load();
  }
  get items(): readonly ThreadListItem[] { return this.overview?.items ?? []; }
  loadIfNeeded(): void { if (!this.overview && !this.loading) void this.load(); }
  /** Marks the row whose thread the reader shows. */
  setCurrent(id: string | undefined): void { if (this.current !== id) { this.current = id; this.paint(); } }
  focusRow(id: string): boolean {
    const row = this.rowFor(id);
    if (!row) return false;
    row.focus({preventScroll: false}); return true;
  }
  private rowFor(id: string): HTMLButtonElement | undefined {
    return [...this.list.querySelectorAll<HTMLButtonElement>('button')].find(row => row.dataset.threadId === id);
  }
  /** Names can arrive after the list does, so the footer's agent names repaint on change. */
  refreshNames(): void { const names = this.nameSignature(); if (names !== this.lastNames) this.paint(); }
  /** Brings the list up to date after the page was hidden, at most once per interval. */
  refreshIfStale(now = Date.now()): void { if (!this.loading && now - this.loadedAt >= REFRESH_AFTER_MS) void this.load(); }
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
    try {
    const overview = this.overview;
    this.body.hidden = false;
    this.refreshButton.title = ['Refresh threads',this.diagnostics()].filter(Boolean).join('\n');
    this.refreshButton.disabled = this.loading;
    const query = this.filter.value.trim();
    this.filterBox.hidden = (overview?.items.length ?? 0) <= THREAD_FILTER_THRESHOLD && !query && document.activeElement !== this.filter;
    this.lastNames = this.nameSignature();
    const items = filterThreads(overview?.items ?? [],query);
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.threadId : undefined;
    const now = Date.now();
    const status = this.emptyStatus(items.length, !!query);
    this.list.replaceChildren(...items.map(item => this.row(item, now)), ...(status ? [element('p', 'secondary thread-empty', status)] : []));
    this.paintFooter(focused);
    } catch (error) {try {window.reportClientError?.('Threads',error);} catch {} throw error;}
  }
  /** One true line where the list would otherwise be a heading with nothing under it. */
  private emptyStatus(shown: number, filtered: boolean): string {
    if (shown) return '';
    if (!this.overview) return this.loading ? 'Reading threads…' : '';
    if (filtered) return 'No matching threads';
    return this.failedEmpty() ? '' : 'No threads yet';
  }
  private paintFooter(focused:string|undefined):void {
    this.retry.disabled=this.loading;this.retry.title=this.diagnostics();
    this.footer.replaceChildren(...(this.failedEmpty()?[this.retry]:[]));
    this.footer.hidden = !this.failedEmpty();
    if (focused) (this.rowFor(focused)??this.refreshButton).focus({preventScroll: true});
  }
  private failedEmpty():boolean {
    const overview=this.overview;
    return !overview?.items.length&&(this.failure!==undefined||!!overview&&(!overview.rosterComplete||overview.hosts.failed>0||overview.hosts.unavailable>0));
  }
  diagnostics(): string {
    const overview = this.overview;
    return [this.loading ? 'Reading threads' : '',this.failure === undefined ? '' : errorText(this.failure),...(overview ? overviewLines(overview) : []),...(overview?.storages.filter(state=>state.state!=='answered').map(state=>this.troubleLine(state)) ?? [])].filter(Boolean).join('\n');
  }
  private troubleLine(state: ThreadOverview['storages'][number]): string {
    const name = this.hooks.name(state.storageId);
    return `${name}: ${state.state === 'unavailable' ? 'does not offer threads' : `did not answer${state.message ? ` (${state.message})` : ''}`}`;
  }
  private row(item: ThreadListItem, now: number): HTMLElement {
    const entry = element('li', 'thread-item');
    const row = element('button', `nav-row thread-row${item.closed ? ' closed' : ''}`);
    row.type = 'button'; row.dataset.threadId = item.id;
    const meta = `${item.members} · ${compactAge(item.updatedAt,now)}`, detail = threadMeta(item,now);
    const name=element('span','thread-name');
    const purpose=item.purpose.split(/\r?\n/,1)[0];
    name.append(element('span','row-title',item.title||'Untitled thread'),element('span','thread-purpose',purpose));
    row.append(name, element('span', 'row-meta', meta));
    row.title = [item.title, item.purpose, detail, item.updatedAt ? `Updated ${absoluteTime(item.updatedAt)}` : ''].filter(Boolean).join('\n');
    row.setAttribute('aria-label', [item.title || 'Untitled thread',purpose,detail].filter(Boolean).join(', '));
    if (item.id === this.current) row.setAttribute('aria-current', 'page');
    row.addEventListener('click', () => this.hooks.open(item, row));
    entry.append(row); return entry;
  }
}

export type ReaderHooks = {
  page(threadId: string, before: number | undefined, signal: AbortSignal): Promise<ThreadPageView>;
  name: KnownName;
  profile?(identity: string): Pick<AgentRow, 'handle' | 'model' | 'role'> | undefined;
  /** Opens the member's conversation in the pane that shows the reader. */
  openMember(identity: string): void;
  /** Leaves the reader and shows the pane's conversation again. */
  back(): void;
  changed?(): void;
};
type Cached = {item: ThreadEntry; thread?: ThreadView; events: ThreadEventView[]; observedAt?: string; source?: 'live' | 'retained'};
/** Scroll positions outlive the cached content, so a thread read long ago still reopens where it was left. */
const SCROLL_LIMIT = 50;
type Failure = {kind: 'unavailable'} | {kind: 'failed'; message: string};
const CACHE_LIMIT = 8;
/** Scrolling up within this many pixels of the top reads the next older page. */
const EARLIER_EDGE = 120;

/** A read-only view of one thread. One instance serves the whole page and is placed in the pane that opened it. */
export class ThreadReader {
  readonly node = element('section', 'thread-reader');
  private readonly hooks: ReaderHooks;
  private readonly title = element('h2', 'inspection-title thread-title');
  private readonly status = element('p', 'inspection-status thread-status');
  private readonly refreshButton: HTMLButtonElement;
  private readonly scroller = element('div', 'thread-scroll');
  private readonly frame = element('div', 'thread-frame');
  private readonly participants = element('details', 'thread-members');
  /** The narrow disclosure choice is independent of the always-visible wide column. */
  private participantsOpen = false;
  private participantsWide = false;
  private readonly backButton: HTMLButtonElement;
  private readonly expandedPosts = new Set<string>();
  private highlightTimer?: ReturnType<typeof setTimeout>;
  private postCursor?: {event: ThreadEventView; top: number};
  private postMarker?: HTMLElement;
  private postTimer?: ReturnType<typeof setTimeout>;
  /** The queued scroll from a loaded-post jump must not request an older page. */
  private postNavigationScroll = false;
  private destroyed = false;
  private readonly earlier: HTMLButtonElement;
  private readonly earlierRow = element('div', 'thread-earlier-row');
  private readonly earlierNote = element('p', 'thread-note', 'Older events not loaded.');
  private lastTop = 0;
  /** The first visible event and its position at the last reading change, so later height changes can restore it. */
  private reading?: {sequence: string; top: number};
  private readonly resize?: ResizeObserver;
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
  selectionSource(selection: Selection): import('./primary-draft-actions.ts').PrimaryDraftSource|undefined {
    const entry = this.entry; if (!entry) return;
    for (const [sequence,cached] of this.rows) {
      const body = cached.node.querySelector<HTMLElement>('.thread-post-body');
      if (!body || !selection.anchorNode || !selection.focusNode || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) continue;
      const event = entry.events.find(event=>event.sequence === sequence); if (!event) return;
      return {caption: () => `${entry.thread?.title || entry.item.title || 'Thread'} · ${event.origin === 'operator' ? OPERATOR : this.hooks.name(event.sender)} · #${sequence}`,
        current: () => this.entry === entry && this.rows.get(sequence) === cached && entry.events.includes(event) && cached.node.isConnected && !this.node.closest('[hidden],[inert]')};
    }
    return undefined;
  }
  constructor(hooks: ReaderHooks) {
    this.hooks = hooks; this.node.hidden = true;
    this.node.setAttribute('aria-label', 'Thread');
    const header = element('div', 'inspection-header');
    this.backButton = button('Close thread', () => this.hooks.back(), 'inspection-back');
    header.append(this.title, this.backButton);
    this.status.setAttribute('role', 'status');
    this.refreshButton = button('Refresh thread', () => { void this.refresh(); }, 'thread-refresh');
    const meta = element('div', 'thread-meta'); meta.append(this.status, this.refreshButton);
    this.earlier = button('Load earlier events', () => { void this.loadEarlier(); }, 'thread-earlier');
    this.scroller.tabIndex = 0; this.scroller.setAttribute('aria-label', 'Thread exchange');
    this.exchange.setAttribute('aria-label', 'Events, oldest first');
    this.earlierRow.append(this.earlierNote, this.earlier);
    const forum = element('div', 'thread-forum'), posts = element('div', 'thread-posts');
    this.participants.addEventListener('click', event => {
      if (event.target !== this.participants.querySelector('summary')) return;
      event.preventDefault();
      if (!this.participantsWide) {this.participantsOpen = !this.participantsOpen; this.layoutParticipants();}
    });
    posts.append(this.frame, this.earlierRow, this.exchange, this.notice);
    forum.append(this.participants, posts); this.scroller.append(forum);
    this.node.append(header, meta, this.scroller);
    if (typeof ResizeObserver === 'function') { this.resize = new ResizeObserver(() => {this.layoutParticipants(); this.measurePosts(); this.settle();}); this.resize.observe(this.node); this.resize.observe(this.exchange); }
    this.scroller.addEventListener('scroll', () => {
      const navigation = this.postNavigationScroll && this.postCursor?.top === this.scroller.scrollTop; this.postNavigationScroll = false;
      if (this.postCursor && this.postCursor.top !== this.scroller.scrollTop) this.clearPostNavigation();
      this.rememberScroll(); this.reading = this.anchorRow();
      const top = this.scroller.scrollTop, up = top < this.lastTop; this.lastTop = top;
      if (up && top <= EARLIER_EDGE && !this.failure && !navigation && this.active) void this.loadEarlier();
    }, {passive: true});
    this.node.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); this.hooks.back();
    });
  }
  returnLabel(label: string): void { setText(this.backButton, label); }
  captureReload():{entry?:Cached;scrolls:[string,number|'end'][];expanded:string[];participants:boolean;back:string} {
    this.rememberScroll();return structuredClone({entry:this.entry,scrolls:[...this.scrolls],expanded:[...this.expandedPosts],participants:this.participantsOpen,back:this.backButton.textContent??'Close thread'});
  }
  restoreReload(value:ReturnType<ThreadReader['captureReload']>):void {
    this.cancel();this.scrolls.clear();for(const [key,position] of value.scrolls)this.scrolls.set(key,position);
    this.expandedPosts.clear();for(const key of value.expanded)this.expandedPosts.add(key);
    this.participantsOpen=value.participants;this.layoutParticipants();setText(this.backButton,value.back);
    if(value.entry){this.entry=value.entry;this.cache.set(value.entry.item.id,value.entry);this.rows.clear();this.framed='';this.node.hidden=false;this.paint();this.restoreScroll();this.reading=this.anchorRow();this.lastTop=this.scroller.scrollTop;this.restorePending=false;}
  }
  get active(): ThreadEntry | undefined { return this.destroyed || this.node.hidden ? undefined : this.entry?.item; }
  get scrollNode(): HTMLElement { return this.scroller; }
  private postRows(): {event: ThreadEventView; node: HTMLElement; at: number}[] {
    const events = new Map<HTMLElement, ThreadEventView>();
    for (const event of this.entry?.events ?? []) {
      const node = this.rows.get(event.sequence)?.node;
      if (node && (event.kind === 'contribution' || event.kind === 'carried-authority')) events.set(node, event);
    }
    return Array.from(this.exchange.children).flatMap((node, at) => {
      const event = events.get(node as HTMLElement);
      return event ? [{event, node: node as HTMLElement, at}] : [];
    });
  }
  private postPosition(): number {
    if (this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= 24) return this.exchange.children.length;
    const anchor = this.anchorRow();
    if (!anchor || anchor.top >= this.scroller.getBoundingClientRect().bottom) return -1;
    return Array.from(this.exchange.children).findIndex(row => (row as HTMLElement).dataset.sequence === anchor.sequence);
  }
  post(direction: -1 | 1): ThreadEventView | undefined {
    if (!this.active || !this.node.isConnected || this.node.closest('[hidden],[inert]')) return;
    const rows = this.postRows(), cursor = this.postCursor;
    const current = cursor?.top === this.scroller.scrollTop ? rows.findIndex(row => row.event === cursor.event) : -1;
    if (current >= 0) return rows[current + direction]?.event;
    const at = this.postPosition();
    return (direction < 0 ? rows.findLast(row => row.at < at) : rows.find(row => row.at > at))?.event;
  }
  jumpPost(event: ThreadEventView): boolean {
    if (!this.active || !this.node.isConnected || this.node.closest('[hidden],[inert]')) return false;
    const row = this.postRows().find(row => row.event === event); if (!row) return false;
    this.clearPostNavigation();
    const top = this.scroller.scrollTop;
    this.reveal(event.sequence, false);
    this.postNavigationScroll ||= this.scroller.scrollTop !== top;
    this.postCursor = {event, top: this.scroller.scrollTop}; this.rememberScroll(); this.reading = this.anchorRow();
    this.postMarker = row.node; row.node.classList.add('own-message-focus');
    this.postTimer = setTimeout(() => this.clearPostMarker(), 1500);
    return true;
  }
  private clearPostMarker(): void {
    if (this.postTimer !== undefined) clearTimeout(this.postTimer);
    this.postTimer = undefined; this.postMarker?.classList.remove('own-message-focus'); this.postMarker = undefined;
  }
  private clearPostNavigation(): void { this.clearPostMarker(); this.postCursor = undefined; }
  destroy(): void { this.destroyed = true; this.cancel(); this.resize?.disconnect(); }
  /** Shows a thread. A thread read earlier in this page appears at once at its old position, then refreshes. */
  open(item: ThreadEntry): void {
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
    this.clearPostNavigation(); this.postNavigationScroll = false;
    this.controller?.abort(); this.earlierController?.abort(); this.serial++; this.earlierSerial++;
    this.controller = undefined; this.earlierController = undefined; this.loading = false; this.loadingEarlier = false;
  }
  /** Brings an open thread up to date after the page was hidden, at most once per interval. */
  refreshIfStale(now = Date.now()): void { if (this.active && !this.loading && now - this.loadedAt >= REFRESH_AFTER_MS) void this.refresh(); }
  /** Names can arrive after the thread does. */
  refreshNames(): void { if (this.active && this.nameSignature() !== this.lastNames) { this.clearPostNavigation(); this.rows.clear(); this.framed = ''; this.paint(); } }
  focus(): void { this.scroller.focus({preventScroll: true}); }
  private nameSignature(): string {
    const entry = this.entry; if (!entry) return '';
    const ids = new Set<string>([...entry.events.flatMap(event => [event.sender, ...event.notify]), ...(entry.thread?.members.map(member => member.identity) ?? []), ...(entry.thread?.integrator ? [entry.thread.integrator] : [])]);
    return [...ids].map(id => `${id}=${this.hooks.name(id)}:${JSON.stringify(this.hooks.profile?.(id))}`).join('|');
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
      this.take(entry, page, true); this.paint();
    } catch (error) {
      if (serial !== this.earlierSerial || controller.signal.aborted) return;
      this.failure = this.classify(error);
    } finally {
      if (serial === this.earlierSerial) { this.loadingEarlier = false; this.earlierController = undefined; this.paint(); }
    }
  }
  /** The first event row whose bottom is below the top edge of the exchange, with its position. Rows are in document order, so a bisection finds it. */
  private anchorRow(): {sequence: string; top: number} | undefined {
    if (this.node.hidden) return undefined;
    const edge = this.scroller.getBoundingClientRect().top, rows = Array.from(this.exchange.children) as HTMLElement[];
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1, bottom = rows[middle]?.getBoundingClientRect().bottom ?? 0;
      if (bottom > edge) high = middle; else low = middle + 1;
    }
    const row = rows[low];
    return row?.dataset.sequence ? {sequence: row.dataset.sequence, top: row.getBoundingClientRect().top} : undefined;
  }
  /** Scrolls by however far the anchor row moved, whatever changed above or below it. */
  private holdAnchor(anchor: {sequence: string; top: number} | undefined): void {
    if (!anchor) return;
    const row = [...this.exchange.querySelectorAll<HTMLElement>('[data-sequence]')].find(candidate => candidate.dataset.sequence === anchor.sequence);
    const target = row?.closest<HTMLElement>('.thread-event-group') ?? row;
    const moved = target ? target.getBoundingClientRect().top - anchor.top : 0;
    if (Math.abs(moved) < 0.5) return;
    this.scroller.scrollTop += moved; this.lastTop = this.scroller.scrollTop;
  }
  /** Rows can change height after they are placed (late names, Markdown, fonts). A reader at the end stays at the end; any other reader keeps the first visible event where it was. */
  private settle(): void {
    const entry = this.entry; if (!entry || this.node.hidden || this.restorePending) return;
    if (this.scrollOf(entry.item.id) === 'end') { this.scroller.scrollTop = this.scroller.scrollHeight; this.lastTop = this.scroller.scrollTop; return; }
    this.holdAnchor(this.reading); this.reading = this.anchorRow();
  }
  private classify(error: unknown): Failure {
    return errorView(error)?.code === 'threads_unavailable' ? {kind: 'unavailable'} : {kind: 'failed', message: errorText(error)};
  }
  private take(entry: Cached, page: ThreadPageView, older: boolean): void {
    if (page.thread.id !== entry.item.id) throw new Error('The host answered for a different thread.');
    this.clearPostNavigation();
    entry.thread = page.thread; entry.observedAt = page.observedAt; entry.source = page.source;
    entry.item = {...entry.item, title: page.thread.title}; this.hooks.changed?.();
    entry.events = (older ? prependEvents(pageEvents(page), entry.events) : mergeEvents(entry.events, pageEvents(page))).filter(event => event.sequence <= page.thread.sequence);
  }
  private paintControls(): void {
    this.refreshButton.disabled = this.loading || this.loadingEarlier;
    const entry = this.entry, more = entry ? olderBoundary(entry.events) !== null : false;
    this.earlierRow.hidden = !more || !!this.failure && !entry?.events.length;
    this.earlier.disabled = this.loadingEarlier;
    setText(this.earlier, this.loadingEarlier ? 'Loading earlier events' : 'Load earlier events');
  }
  private paint(): void {
    const entry = this.entry; if (!entry) return;
    const wasEnd = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= 24;
    const anchor = wasEnd ? undefined : this.anchorRow();
    const thread = entry.thread, name = nameFor(this.hooks.name);
    this.lastNames = this.nameSignature();
    setText(this.title, thread?.title || entry.item.title || 'Thread');
    setText(this.status, this.statusText(thread, entry.events)); this.status.title = thread ? `Updated ${absoluteTime(thread.updatedAt)}` : '';
    this.paintFrame(thread);
    const wanted = exchangeRows(entry.events, name).map(row => this.rowNode(row));
    this.exchange.replaceChildren(...this.groupQuiet(wanted, entry.events));
    this.measurePosts();
    const present = new Set(entry.events.map(event => event.sequence));
    for (const key of [...this.rows.keys()]) if (!present.has(key)) this.rows.delete(key);
    this.notice.replaceChildren(...this.noticeNodes(entry));
    this.paintControls();
    if (this.restorePending && entry.thread) { this.restorePending = false; this.restoreScroll(); }
    else if (wasEnd && this.scrollOf(entry.item.id) === 'end') this.scroller.scrollTop = this.scroller.scrollHeight;
    else this.holdAnchor(anchor);
    this.reading = this.anchorRow();
  }
  private statusText(thread: ThreadView | undefined, events: readonly ThreadEventView[]): string {
    if (!thread) return this.loading ? 'Reading thread' : '';
    const updated = thread.updatedAt ? `updated ${eventTime(thread.updatedAt, Date.now())}` : '';
    setText(this.earlierNote, `Newest ${events.length} of ${thread.sequence}`);
    return [thread.closed ? 'Closed' : 'Open', `${thread.members.length} participants`, updated, this.entry?.source === 'retained' ? 'Read from saved storage' : '', this.loading ? 'Refreshing' : ''].filter(Boolean).join(' · ');
  }
  private noticeNodes(entry: Cached): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    if (this.loading && !entry.thread) nodes.push(element('p', 'thread-note', 'Reading thread'));
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
    const signature = JSON.stringify([thread, this.lastNames, this.entry?.events]);
    if (signature === this.framed) return;
    this.framed = signature;
    if (!thread) { this.frame.replaceChildren(); this.participants.replaceChildren(); return; }
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
    this.members(thread);
    const decided = this.decided(); if (decided) parts.push(decided);
    parts.push(this.frameDetails(thread));
    this.frame.replaceChildren(...parts);
  }
  private layoutParticipants(): void {
    this.participantsWide = this.scroller.getBoundingClientRect().width >= 1000;
    this.participants.open = this.participantsWide || this.participantsOpen;
    const summary = this.participants.querySelector('summary'); if (summary) summary.tabIndex = this.participantsWide ? -1 : 0;
  }
  private members(thread: ThreadView): HTMLElement {
    const box = this.participants;
    box.replaceChildren(element('summary', undefined, `Participants · ${thread.members.length}`));
    this.layoutParticipants();
    const list = element('ul', 'thread-member-list');
    const events = this.entry?.events ?? [], posts = events.filter(event => event.kind === 'contribution' || event.kind === 'carried-authority');
    const latest = (identity: string) => Math.max(0, ...posts.filter(post => post.sender === identity).map(post => post.sequence));
    const members = [...thread.members].sort((a, b) => Number(b.identity === thread.integrator) - Number(a.identity === thread.integrator) || latest(b.identity) - latest(a.identity));
    const former = [...new Set(posts.filter(post => post.origin !== 'operator').map(post => post.sender))].filter(identity => !members.some(member => member.identity === identity));
    for (const member of [...members, ...former.map(identity => ({identity, contribution: '', joinedAt: 0}))]) {
      if (member.identity === former[0]) {const earlier = element('li', 'thread-earlier-participants', 'Earlier participants'); list.append(earlier);}
      list.append(this.memberNode(member, thread, posts));
    }
    box.append(list); return box;
  }
  private memberNode(member: ThreadView['members'][number], thread: ThreadView, posts: ThreadEventView[]): HTMLElement {
      const item = element('li', 'thread-member');
      const who = this.personButton(member.identity, 'thread-person');
      item.append(who);
      if (member.identity === thread.integrator) item.append(element('span', 'thread-role', 'integrator'));
      const profile = this.hooks.profile?.(member.identity), metadata = this.profileLine(member.identity);
      if (metadata) item.append(element('p', 'thread-profile', metadata));
      if (profile?.role) {const role = element('p', 'thread-profile-role', profile.role); role.title = profile.role; item.append(role);}
      if (member.contribution) { const line = element('p', 'thread-contribution', `Holds: ${member.contribution}`); line.title = member.contribution; item.append(line); }
      const count = posts.filter(post => post.sender === member.identity).length;
      const facts = element('p', 'thread-participant-facts', [member.joinedAt ? `joined ${eventTime(member.joinedAt, Date.now())}` : '', `${count} ${count === 1 ? 'post' : 'posts'} here`].filter(Boolean).join(' · '));
      facts.title = olderBoundary(this.entry?.events ?? []) !== null ? 'Post count covers loaded events only.' : 'Post count covers this thread.';
      item.append(facts); return item;
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
    const signature = JSON.stringify([row, this.lastNames, this.entry?.events.filter(event => event.replyTo === row.sequence).map(event => [event.sequence, event.sender, event.origin])]);
    const cached = this.rows.get(row.sequence);
    if (cached?.signature === signature) return cached.node;
    const node = row.type === 'message' ? this.messageNode(row) : this.lineNode(row);
    node.dataset.sequence = String(row.sequence); node.tabIndex = -1;
    node.id = `thread-post-${row.sequence}`;
    this.rows.set(row.sequence, {signature, node}); return node;
  }
  private messageNode(row: Extract<ExchangeRow, {type: 'message'}>): HTMLElement {
    const item = element('li', 'thread-event thread-message');
    item.dataset.kind = row.carried ? 'carried-authority' : 'contribution';
    item.append(this.authorHead(row, item));
    this.postReply(row, item);
    this.postBody(row, item);
    return item;
  }
  private authorHead(row: Extract<ExchangeRow, {type: 'message'}>, item: HTMLElement): HTMLElement {
    const head = element('div', 'thread-event-head');
    const label = row.origin === 'operator' ? OPERATOR : this.hooks.name(row.sender);
    if (row.origin === 'operator') head.append(element('span', 'thread-sender', label));
    else head.append(this.personButton(row.sender, 'thread-sender'));
    if (row.carried) head.append(element('span', 'thread-kind', 'Carried authority'));
    const time = element('time', 'thread-time', eventTime(row.at, Date.now())); time.dateTime = new Date(row.at).toISOString(); time.title = absoluteTime(row.at); head.append(time);
    const metadata = this.profileLine(row.sender); if (metadata && row.origin !== 'operator') head.insertBefore(element('span', 'thread-author-profile', metadata), time);
    const anchor = button(`#${row.sequence}`, () => { void copy(`#${row.sequence}`, item); }, 'thread-anchor'); anchor.title = `Copy post #${row.sequence} anchor`; head.append(anchor);
    return head;
  }
  private postReply(row: Extract<ExchangeRow, {type: 'message'}>, item: HTMLElement): void {
    if (row.replyTo !== null) {
      const parent = this.entry?.events.find(event => event.sequence === row.replyTo);
      const label = parent ? `↳ Reply to ${parent.origin === 'operator' ? OPERATOR : this.hooks.name(parent.sender)} “${parent.message.split(/\r?\n/,1)[0]??''}”` : `↳ Reply to post #${row.replyTo}`;
      item.append(button(label, () => {if (parent) this.reveal(parent.sequence); else void this.loadEarlier();}, 'thread-reply'));
      if (!parent) item.append(button('Load earlier events', () => { void this.loadEarlier(); }, 'thread-earlier'));
      item.classList.toggle('thread-direct-reply', this.entry?.events.find(event => event.sequence === row.sequence - 1)?.sequence === row.replyTo);
    }
    const event = this.entry?.events.find(event => event.sequence === row.sequence);
    if (event?.notify.length) item.append(element('p', 'thread-to', `To ${event.notify.map(identity => this.hooks.name(identity)).join(', ')}`));
  }
  private postBody(row: Extract<ExchangeRow, {type: 'message'}>, item: HTMLElement): void {
    const prose = element('div', 'thread-prose thread-post-body'); prose.append(markdownDom(row.message));
    const key = `${this.entry?.item.id}:${row.sequence}`; prose.dataset.expanded = String(this.expandedPosts.has(key));
    const whole = button(this.expandedPosts.has(key) ? 'Show less' : 'Show whole post', () => {
      const expanded = !this.expandedPosts.has(key); if (expanded) this.expandedPosts.add(key); else this.expandedPosts.delete(key);
      prose.dataset.expanded = String(expanded); whole.setAttribute('aria-expanded', String(expanded)); setText(whole, expanded ? 'Show less' : 'Show whole post');
    }, 'thread-whole-post'); whole.hidden = true; whole.setAttribute('aria-expanded', prose.dataset.expanded);
    item.append(prose, whole, button('Copy', () => { void copy(row.message, item); }, 'thread-copy'));
    if (row.source) item.append(element('p', 'thread-source', `Source: ${row.source}`));
    const replies = this.entry?.events.filter(event => event.replyTo === row.sequence) ?? [];
    if (replies.length) {
      const line = element('p', 'thread-replies', `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}: `); line.title = 'Loaded replies only';
      for (const reply of replies) line.append(button(reply.origin === 'operator' ? OPERATOR : this.hooks.name(reply.sender), () => this.reveal(reply.sequence), 'thread-reply-author'));
      item.append(line);
    }
  }
  private profileLine(identity: string): string {
    const profile = this.hooks.profile?.(identity), model = profile?.model;
    return [profile?.handle, model ? `${model.provider}/${model.modelId}` : '', model?.thinkingLevel].filter(Boolean).join(' · ');
  }
  private personButton(identity: string, className: string): HTMLButtonElement {
    const label = this.hooks.name(identity), who = button(label, () => this.hooks.openMember(identity), className);
    if (label.startsWith('Unnamed conversation · ')) {
      setText(who, 'Unnamed conversation'); who.append(element('span', 'thread-identity', ` · ${identity.slice(0, 8)}`));
    }
    who.title = identity; who.setAttribute('aria-label', `Open ${label}`); return who;
  }
  private measurePosts(): void {
    for (const item of this.exchange.querySelectorAll<HTMLElement>('.thread-message')) {
      const prose = item.querySelector<HTMLElement>('.thread-post-body'), whole = item.querySelector<HTMLButtonElement>('.thread-whole-post'); if (!prose || !whole) continue;
      const lineHeight = Number.parseFloat(getComputedStyle(prose).lineHeight) || 26.4;
      const long = prose.scrollHeight > lineHeight * 10;
      prose.dataset.long = String(long); whole.hidden = !long;
    }
  }
  private reveal(sequence: number, focus = true): void {
    const row = this.exchange.querySelector<HTMLElement>(`#thread-post-${sequence}`); if (!row) return;
    if (focus) this.clearPostNavigation();
    const disclosure = row.closest('details'); if (focus && disclosure) disclosure.open = true;
    const group = row.closest<HTMLElement>('.thread-event-group'); const target = group ?? row;
    target.scrollIntoView({block: 'center'});
    if (!focus) return;
    row.focus({preventScroll: true});
    for (const previous of this.exchange.querySelectorAll('.thread-highlight')) previous.classList.remove('thread-highlight');
    row.classList.add('thread-highlight'); if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => row.classList.remove('thread-highlight'), 2000);
  }
  private decided(): HTMLElement | undefined {
    const entry = this.entry; if (!entry) return;
    const decisions = entry.events.filter(event => event.kind === 'carried-authority' || entry.thread?.closed && event.kind === 'close' && event.message);
    if (!decisions.length) return;
    const box = element('section', 'thread-decided'); box.append(element('h3', undefined, 'Decided'));
    if (olderBoundary(entry.events) !== null) box.append(element('p', 'thread-note', 'From loaded events'));
    for (const event of decisions) {
      const row = button('', () => this.reveal(event.sequence), 'thread-decision');
      row.append(element('span', 'thread-decision-head', `${event.origin === 'operator' ? OPERATOR : this.hooks.name(event.sender)} · ${eventTime(event.at, Date.now())}`), element('span', 'thread-decision-text', event.message));
      if (event.source) row.append(element('span', 'thread-source', `Source: ${event.source}`)); box.append(row);
    }
    return box;
  }
  private groupQuiet(nodes: HTMLElement[], events: readonly ThreadEventView[]): HTMLElement[] {
    const result: HTMLElement[] = []; let index = 0;
    while (index < nodes.length) {
      const event = events[index], node = nodes[index]; if (!node) break;
      if (!event || !['join', 'leave'].includes(event.kind)) {result.push(node); index++; continue;}
      const start = index; while (index < nodes.length && ['join', 'leave'].includes(events[index]?.kind ?? '')) index++;
      if (index - start === 1) {result.push(node); continue;}
      result.push(this.quietGroup(events.slice(start, index)));
    }
    return result;
  }
  private quietGroup(batch: readonly ThreadEventView[]): HTMLElement {
      const group = element('li', 'thread-event thread-line thread-event-group'); group.dataset.sequence = String(batch[0]?.sequence);
      const lines: string[] = [];
      for (const kind of ['join', 'leave']) {
        const names = batch.filter(event => event.kind === kind).map(event => event.origin === 'operator' ? OPERATOR : this.hooks.name(event.sender));
        if (!names.length) continue;
        const label = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others` : names.join(' and ');
        lines.push(`${label} ${kind === 'join' ? 'joined' : 'left'}`);
      }
      const summary = element('p', 'thread-line-text', `${lines.join(' · ')} · ${eventTime(batch.at(-1)?.at ?? 0, Date.now())}`);
      group.append(summary);
      const more = element('details', 'thread-line-details'), originals = element('ol', 'thread-quiet-originals'); more.append(element('summary', undefined, 'Details'), originals);
      for (const event of batch) originals.append(this.quietOriginal(event));
      group.append(more); return group;
  }
  private quietOriginal(event: ThreadEventView): HTMLElement {
        const original = element('li', 'thread-line'); original.id = `thread-post-${event.sequence}`; original.dataset.sequence = String(event.sequence); original.tabIndex = -1;
        original.append(element('p', 'thread-line-text', `${event.origin === 'operator' ? OPERATOR : this.hooks.name(event.sender)} ${event.kind === 'join' ? 'joined' : 'left'} · ${eventTime(event.at, Date.now())}`));
        if (event.message && !['Joined the thread.', 'Left the thread.'].includes(event.message)) original.append(element('p', 'thread-quiet-note', event.message));
        return original;
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

