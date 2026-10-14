import type { Bootstrap, OperationView, PrimaryView, RecentProjectPage, SavedSession, SavedSessionPage, Snapshot } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
import { button, details, element, input } from './dom.ts';
import { cardAction, cardDisclosure, controlIcon } from './card-icons.ts';
import { projectIdentity, projectLabels } from './conversation-presentation.ts';
import { contextMenu, type ContextItem } from './context-menu.ts';
import { duplicateIdentityTails } from './tabs.ts';
import { absoluteTime, relativeTime } from './format.ts';
import type { Modal } from './modal.ts';
import { filterSessions, mergeSessions, mergeSessionTitles, savedPathValid, sessionCoverage, sessionEmptyMessage, sessionOwner, sessionSize, sessionLabel, type SessionList } from './picker-state.ts';
import { operation, request } from './transport.ts';

function pickerField(control: {label: HTMLLabelElement; field: HTMLElement}, visibleLabel = false): HTMLElement {
  control.field.className = 'picker-input';
  const line = element('div', 'picker-input-row');
  control.label.className = visibleLabel ? 'picker-field-label' : 'sr-only'; line.append(control.label, control.field); return line;
}
function sessionSearchEmpty(data: SessionList, query: string): string {
  if (!query.trim()) return sessionEmptyMessage(data);
  const incomplete = !!data.nextCursor || !!data.omitted || data.items.some(item => item.titleState !== 'ready');
  return `No ${incomplete ? 'loaded ' : ''}sessions match “${query.trim()}”.${data.nextCursor ? ' Use More saved sessions to search further.' : incomplete ? ' The list is incomplete.' : ''}`;
}
function projectCoverage(page: RecentProjectPage): string {
  if (!page.nextCursor && !page.omitted) return '';
  const omitted = page.omitted ? ` · ${page.omitted} ${page.omitted === 1 ? 'entry is' : 'entries are'} not listed.` : '';
  return `${page.items.length} of ${page.total} projects shown${omitted}`;
}
function projectPage(previous: RecentProjectPage | undefined, page: RecentProjectPage, append: boolean): RecentProjectPage {
  return {...page, items: append ? [...(previous?.items ?? []), ...page.items] : page.items};
}

type Context = {snapshot(): Snapshot | undefined; primary(): PrimaryView | undefined; modal: Modal;
  selection(change: SelectionChange): Promise<void>; reload(): Promise<void>; project?(): string | undefined; projectsChanged?(): void; workingFolder?(path:string):Promise<void>};

/** Metadata caches belong to the picker, never to execution or writer ownership. */
export class ProjectPicker {
  private ctx: Context;
  private cached = new Map<string, SessionList>();
  private projects?: RecentProjectPage;
  private pending = new AbortController();
  private choosing = 0;
  private inline?: HTMLElement;
  private inlineActions?: HTMLElement;
  private shownProject?: string;
  private inlineError?: HTMLElement;
  private revision = 0;
  private modalToken?: number;
  private running = new Set<number>();
  mount(root: HTMLElement, project?: string): void {
    if (this.inline === root || this.modalToken !== undefined && this.ctx.modal.owns(this.modalToken)) return;
    this.unmount(); this.inline = root; root.classList.add('session-picker-inline');
    this.show(project ?? this.project());
  }
  unmount(): void {
    if (!this.inline) return;
    this.pending.abort(); this.revision++; this.inline.replaceChildren(); this.inline = undefined;
  }
  newSession(project?: string): void {
    const cwd = project ?? this.project();
    if (!cwd) { this.openProject(); return; }
    if (!this.inline) this.begin('Starting session…');
    void this.run(() => this.start(cwd));
  }
  private project(): string | undefined { return this.ctx.project?.() ?? this.ctx.primary()?.cwd ?? (this.ctx.snapshot() as Bootstrap | undefined)?.launchCwd; }
  projectPaths(): string[] {
    const snapshot = this.ctx.snapshot();
    return [...new Set([...(snapshot?.primaries.map(item => item.cwd) ?? []), ...(this.projects?.items.map(item => item.path) ?? []),
      (snapshot as Bootstrap | undefined)?.launchCwd, this.project()].filter((path): path is string => !!path))];
  }
  private projectName(path: string): string { return projectIdentity({cwd: path}, undefined, this.projectPaths()).name; }
  private owns(token: number): boolean { return this.revision === token && (!!this.inline || this.modalToken !== undefined && this.ctx.modal.owns(this.modalToken)); }
  private actions(...buttons: HTMLButtonElement[]): void {
    if (!this.inline) { this.ctx.modal.actions(...buttons); return; }
    this.inlineActions?.replaceChildren(...buttons);
  }
  private error(cause: unknown, message = 'The session did not open. Your project choice is unchanged.'): void {
    const text = cause instanceof Error ? cause.message : String(cause);
    const disclosure = details('Details', text); disclosure.className = 'picker-error-details';
    const summary = element('p', 'error', message); summary.hidden = !message; summary.setAttribute('role', 'alert');
    this.inlineError?.replaceChildren(summary, ...(cause === undefined ? [] : [disclosure]));
  }
  private async run(action: () => Promise<unknown>, failed?: (cause: unknown) => void): Promise<void> {
    if (!this.inline && !failed) { await this.ctx.modal.run(action, true, 'The session did not open. Your project choice is unchanged.'); return; }
    const revision = this.revision; if (this.running.has(revision)) return;
    this.running.add(revision);
    const host = this.inline ?? this.ctx.modal.body;
    const enabled = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(node => !node.disabled);
    for (const node of enabled) node.disabled = true;
    try { await action(); if (this.owns(revision)) this.closeHost(); }
    catch (cause) { if (this.owns(revision)) (failed ?? this.error.bind(this))(cause); }
    finally { this.running.delete(revision); for (const node of enabled) node.disabled = false; }
  }
  private closeHost(): void { if (this.inline) this.unmount(); else this.ctx.modal.close(); }
  constructor(ctx: Context) { this.ctx = ctx; }
  private begin(title: string): {body: HTMLElement; token: number; signal: AbortSignal} {
    contextMenu.close(false); this.pending.abort(); this.pending = new AbortController(); this.revision++; this.shownProject = undefined;
    let body: HTMLElement;
    if (this.inline) {
      const header = element('div', 'picker-header'); this.inlineActions = element('div', 'dialog-actions');
      header.append(element('h1', 'picker-title', title), this.inlineActions); this.inline.replaceChildren(header);
      body = element('div', 'session-picker-body'); this.inline.append(body);
      this.inlineError = element('div', 'picker-error'); this.inline.append(this.inlineError);
    } else {
      const pending = this.pending, revision = this.revision;
      const abort = () => {pending.abort(); if (this.revision === revision) this.pending.abort();};
      body = this.ctx.modal.open(title, () => {if (this.revision === revision) {abort(); this.ctx.modal.close();}}, abort);
      this.ctx.modal.node.dataset.variant = 'picker'; this.modalToken = this.ctx.modal.token;
      this.inlineError = element('div', 'picker-error'); body.append(this.inlineError);
    }
    return {body, token: this.revision, signal: this.pending.signal};
  }
  open(project?: string): void {
    const cwd = project ?? this.project();
    if (this.inline && this.shownProject === cwd) { this.inline.querySelector<HTMLInputElement>('#picker-search')?.focus(); return; }
    this.show(cwd);
  }
  openProject(origin?: HTMLElement): void { this.selectProject(origin); }
  private sessionActions(project: string): void {
    this.actions(...(this.inline ? [] : [cardAction('folder', 'Change working folder', () => this.selectProject())]), cardAction('plus', 'New session', () => { void this.run(() => this.start(project)); }));
  }
  private show(project?: string): void {
    if (!project) { this.selectProject(); return; }
    const {body, token} = this.begin(`Sessions in ${this.projectName(project)}`); this.shownProject = project;
    body.append(element('p', 'secondary', 'Loading sessions…'));
    this.sessionActions(project);
    void this.sessions(project).catch(cause => {
      if (!this.owns(token)) return;
      body.replaceChildren(element('p', 'error', 'Sessions could not be loaded.'), cardAction('restart', 'Retry saved sessions', () => this.show(project)));
      if (this.inlineError && !this.inline) body.append(this.inlineError);
      this.sessionActions(project); this.error(cause, '');
    });
  }
  private selectProject(origin?: HTMLElement, cursor?: string): void {
    this.pending.abort(); this.pending = new AbortController(); this.revision++;
    const host = this.inline;
    const control = origin ?? document.getElementById('project-button') ?? undefined;
    const snapshot = this.ctx.snapshot();
    let body: HTMLElement | undefined;
    if (host) { body = this.begin('Working folder').body; }
    else { this.ctx.modal.close(false); this.modalToken = undefined; if (!control) return; }
    const revision = this.revision;
    let loading = true, failed = false;
    const current = () => this.revision === revision && (host ? this.inline === host : !!control && contextMenu.owns(control));
    const paint = () => {
      const items = [...this.projectItems(snapshot), ...this.projectStatus(control, loading, failed)];
      if (body) { body.replaceChildren(...items.map(item => { const row = button(item.label, item.run, 'picker-project-row'); row.disabled = item.enabled === false; if (item.description) {row.title = item.description; row.setAttribute('aria-description', item.description);} return row; })); }
      else if (control) { const box = control.getBoundingClientRect(); contextMenu.open(control, {x: box.left, y: box.bottom}, 'Working folder', items, () => this.revision === revision); }
    };
    paint();
    const signal = this.pending.signal;
    void request<RecentProjectPage>(`/api/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, signal).then(page => {
      if (!current() || signal.aborted) return;
      this.projects = projectPage(this.projects, page, !!cursor); this.ctx.projectsChanged?.(); loading = false; paint();
    }).catch(() => { if (current() && !signal.aborted) {loading = false; failed = true; paint();} });
  }
  private workingFolderItems():ContextItem[] {
    const labels = projectLabels(this.projectPaths());
    return this.projectPaths().map(path=>({key:`project:${path}`,label:labels.get(path) ?? path,description:path,checked:path === this.project(),run:()=> {
      void this.ctx.workingFolder?.(path).catch(cause=> {this.begin('Working folder');this.error(cause,'The working folder is unchanged.');});
    }}));
  }
  private retainedPrimaryItems(snapshot?:Snapshot):ContextItem[] {
    return (snapshot?.primaryIndex ?? []).filter(primary=>!snapshot?.primaries.some(item=>item.key === primary.key)).map(primary=>({key:`primary:${primary.key}`,label:`Session ${primary.key.slice(0,8)}`,description:primary.lifecycle,
      run:()=> {void this.select({primaryKey:primary.key,selectedTarget:{kind:'primary',key:primary.key,epoch:primary.epoch}}).catch(cause=> {this.begin('Project could not be selected');this.error(cause);});}}));
  }
  private projectItems(snapshot?: Snapshot): ContextItem[] {
    const items: ContextItem[] = []; const paths = new Set<string>();
    const labels = projectLabels(this.projectPaths());
    const name = (path: string) => labels.get(path) ?? path;
    if (this.ctx.workingFolder) return this.workingFolderItems();
    for (const primary of snapshot?.primaries ?? []) {
      paths.add(primary.cwd);
      items.push({key: `primary:${primary.key}`, label: name(primary.cwd), description: [primary.cwd, primary.sessionName ?? primary.sessionId ?? primary.key, primary.lifecycle].join(' · '),
        run: () => { void this.select({primaryKey: primary.key, selectedTarget: {kind: 'primary', key: primary.key, epoch: primary.epoch}}).catch(cause => {
        this.begin('Project could not be selected'); this.error(cause, 'The project choice is unchanged.');
        }); }});
    }
    items.push(...this.retainedPrimaryItems(snapshot));
    for (const path of [(snapshot as Bootstrap | undefined)?.launchCwd, this.project()]) if (path && !paths.has(path)) {
      paths.add(path); items.push({key: `project:${path}`, label: name(path), description: path, run: () => this.show(path)});
    }
    for (const project of this.projects?.items ?? []) if (!paths.has(project.path)) { paths.add(project.path); items.push({key: `project:${project.path}`, label: name(project.path), description: project.path, run: () => this.show(project.path)}); }
    return items;
  }
  private projectStatus(control: HTMLElement | undefined, loading: boolean, failed: boolean): ContextItem[] {
    const items: ContextItem[] = [];
    if (loading && !this.projects) items.push({label: 'Loading projects…', enabled: false, run() {}});
    if (failed) items.push({label: 'Recent projects are unavailable.', enabled: false, run() {}}, {key: 'retry', label: 'Try again', run: () => this.selectProject(control)});
    const coverage = this.projects && projectCoverage(this.projects);
    if (coverage) items.push({label: coverage, enabled: false, run() {}});
    if (this.projects?.nextCursor) items.push({key: 'more', label: 'More recent projects', run: () => this.selectProject(control, this.projects?.nextCursor ?? undefined)});
    items.push({key: 'folder', label: 'Other folder…', separatorBefore: true, run: () => this.selectFolder()}, {key: 'refresh', label: 'Refresh recent projects', description: this.projects ? `Saved list · ${relativeTime(this.projects.observedAt, Date.now())}` : undefined, run: () => this.selectProject(control)});
    return items;
  }
  private selectFolder(): void {
    const {body, token} = this.begin('Working folder');
    const directory = input('Working folder', this.project() ?? ''); directory.field.id = 'picker-project'; directory.label.htmlFor = directory.field.id;
    const error = element('p', 'error'); error.setAttribute('role', 'alert');
    const next = () => {
      if (!savedPathValid(directory.field.value)) {error.textContent = 'Enter a working folder path that starts with /.'; directory.field.focus(); return;}
      error.textContent = '';
      if (this.ctx.workingFolder) {void this.run(async()=> {await this.ctx.workingFolder?.(directory.field.value);});return;}
      void this.sessions(directory.field.value).catch(cause => {if (this.owns(token)) {error.textContent = 'The working folder is unavailable.'; this.error(cause, '');}});
    };
    body.append(pickerField(directory, true), error); this.actions(button('Use folder', next));
    directory.field.addEventListener('keydown', event => {if (event instanceof KeyboardEvent && event.key === 'Enter') {event.preventDefault(); next();}});
    directory.field.focus(); directory.field.setSelectionRange(0, 0); directory.field.scrollLeft = 0;
  }
  private async sessions(project: string): Promise<void> {
    const choosing = ++this.choosing;
    this.pending.abort(); this.pending = new AbortController();
    // An uncached invalid directory leaves the first screen and its field intact.
    const existing = this.cached.get(project);
    const initialToken = this.revision;
    let first: SavedSessionPage | undefined;
    if (!existing) {
      first = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}`, 'GET', undefined, undefined, this.pending.signal);
      if (!this.owns(initialToken) || choosing !== this.choosing) return;
    }
    const {body, token, signal} = this.begin(`Sessions in ${this.projectName(project)}`); this.shownProject = project;
    const projectDetails = element('details', 'picker-path');
    const folderSummary = element('summary', 'secondary', 'Working folder'); cardDisclosure(folderSummary);
    projectDetails.append(folderSummary, element('p', 'identity', project));
    body.append(projectDetails);
    this.sessionActions(project);
    const safety = element('p', 'secondary picker-safety', 'If a session is open in a terminal, close it there before opening it here.');
    const search = input('Search sessions'); search.field.id = 'picker-search'; search.label.htmlFor = search.field.id; search.field.placeholder = 'Search sessions';
    const searchRow = element('div', 'picker-search-row'); searchRow.append(pickerField(search)); body.append(searchRow, safety);
    const list = element('div', 'picker-sessions'); const coverage = element('p', 'secondary'); coverage.id = 'picker-coverage'; coverage.setAttribute('aria-live', 'polite');
    const error = element('p', 'error'); error.setAttribute('role', 'alert');
    let data = first ? mergeSessions(undefined, first) : existing;
    let render = 0; let loading = 0; const titleRequests = new Set<string>();
    const more = cardAction('next', 'More saved sessions', () => { void load(data?.nextCursor ?? undefined); }); more.id = 'picker-more';
    const freshness = element('details', 'picker-list-details');
    const observed = element('p', 'secondary'); const listSummary = element('summary', undefined, 'List details'); cardDisclosure(listSummary);
    freshness.append(listSummary, observed); freshness.hidden = true;
    const updateCoverage = (matches: number) => {
      if (!data) return;
      const incomplete = !!data.nextCursor || !!data.omitted || data.items.some(item => item.titleState !== 'ready');
      coverage.textContent = incomplete ? sessionCoverage(data, matches, search.field.value) : search.field.value.trim() ? `${matches} matches in loaded sessions` : '';
      coverage.hidden = !coverage.textContent;
      observed.textContent = `Saved list · ${relativeTime(data.observedAt, Date.now())}`;
    };
    const paint = () => {
      const focusedPath = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('picker-select') ? document.activeElement.dataset.sessionPath : undefined;
      const version = ++render; list.replaceChildren();
      if (!data) return;
      const matches = filterSessions(data.items, search.field.value);
      const tails = duplicateIdentityTails(data.items.map(item => ({name: sessionLabel(item), identity: item.id})));
      if (focusedPath && !matches.some(item => item.path === focusedPath)) { search.field.focus(); error.textContent = 'The selected session is no longer in this loaded list.'; }
      updateCoverage(matches.length);
      more.hidden = !data.nextCursor; safety.hidden = !file.open && !matches.some(item => !sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path));
      let offset = 0;
      const batch = () => {
        if (version !== render || !this.owns(token)) return;
        const fragment = document.createDocumentFragment();
        const latest = new Map(data?.items.map(item => [item.path, item]));
        const rows = matches.slice(offset, offset + 20).map(item => this.row(latest.get(item.path) ?? item, tails.get(item.id)));
        fragment.append(...rows); list.append(fragment); offset += 20;
        if (focusedPath) rows.find(row => row.querySelector<HTMLButtonElement>('.picker-select')?.dataset.sessionPath === focusedPath)?.querySelector<HTMLButtonElement>('.picker-select')?.focus();
        if (offset < matches.length) requestAnimationFrame(batch);
      };
      batch();
      if (!matches.length) list.append(element('p', 'secondary', sessionSearchEmpty(data, search.field.value)));
    };
    const save = () => {
      if (!data) return;
      this.cached.delete(project); this.cached.set(project, data);
      if (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value ?? '');
    };
    const load = async (cursor?: string) => {
      const generation = ++loading; const current = () => this.owns(token) && generation === loading;
      more.disabled = true; refresh.disabled = true; error.textContent = '';
      try {
        const page = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, signal);
        if (!this.owns(token)) return;
        if (generation !== loading) return;
        data = mergeSessions(data, page, !!cursor); save(); paint(); void fillTitles(page);
      } catch (cause) { if (!signal.aborted && current()) { error.textContent = 'The saved list did not refresh. Use Refresh to reload the first page.'; this.error(cause, ''); } }
      finally { if (current()) {more.disabled = false; refresh.disabled = false;} }
    };
    const fillTitles = async (page: SavedSessionPage) => {
      if (!page.titleCursor || !page.items.some(item => item.titleState === 'pending') || titleRequests.has(page.titleCursor)) return;
      titleRequests.add(page.titleCursor);
      try {
        const filled = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}&titles=${encodeURIComponent(page.titleCursor)}`, 'GET', undefined, undefined, signal);
        if (!this.owns(token) || !data) return;
        data = mergeSessionTitles(data, filled); save();
        if (search.field.value.trim()) paint(); else {
          this.patchTitles(list, data);
          updateCoverage(data.items.length);
        }
      } catch (cause) { if (!signal.aborted && this.owns(token)) { error.textContent = 'Some session titles did not load. Use Refresh.'; this.error(cause, ''); } }
    };
    const refresh = cardAction('restart', 'Refresh saved sessions', () => { void load(); }); searchRow.append(refresh);
    const file = this.sessionFile(project, search.field, () => {safety.hidden = !file.open && !filterSessions(data?.items ?? [], search.field.value).some(item => !sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path));}); file.hidden = true;
    const options = cardAction('more', 'Saved session options', () => {
      const box = options.getBoundingClientRect();
      contextMenu.open(options, {x: box.left, y: box.bottom}, 'Saved session options', [
        {key: 'details', label: 'List details', run: () => { freshness.hidden = false; freshness.open = true; listSummary.focus(); }},
        {key: 'file', label: 'Session file…', run: () => { file.hidden = false; file.open = true; file.querySelector<HTMLInputElement>('#picker-session-path')?.focus(); }},
      ], () => this.owns(token));
    });
    options.setAttribute('aria-haspopup', 'menu'); options.setAttribute('aria-expanded', 'false');
    searchRow.append(options);
    const utilities = element('div', 'picker-project-actions picker-footer');
    utilities.append(coverage, freshness, more);
    body.append(list, error, utilities, file);
    list.addEventListener('keydown', event => this.navigate(event, list));
    search.field.addEventListener('input', paint); search.field.addEventListener('keydown', event => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') this.navigate(event, list);
      if (event.key === 'Enter') { event.preventDefault(); list.querySelector<HTMLButtonElement>('.picker-select')?.click(); }
    });
    save(); paint(); for (const page of data?.pendingTitles ?? []) void fillTitles(page); search.field.focus();
  }
  private patchTitles(list: HTMLElement, data: SessionList): void {
    const items = new Map(data.items.map(item => [item.path, item]));
    const tails = duplicateIdentityTails(data.items.map(item => ({name: sessionLabel(item), identity: item.id})));
    for (const row of list.querySelectorAll<HTMLElement>('.picker-session')) {
      const select = row.querySelector<HTMLButtonElement>('.picker-select'); if (!select) continue;
      const item = items.get(select.dataset.sessionPath ?? ''); const title = select.querySelector('.picker-session-title');
      if (item && title) { title.textContent = sessionLabel(item); select.title = item.title;
        const full = row.querySelector('.picker-session-full-title'); if (full) full.textContent = item.title;
        const tail = tails.get(item.id);
        const identity = select.querySelector<HTMLElement>('.picker-session-tail'); if (identity) { identity.textContent = tail ?? ''; identity.hidden = !tail; }
      }
    }
  }
  private row(item: SavedSession, tail?: string): HTMLElement {
    const row = element('div', 'picker-session');
    const opened = sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path);
    const select = button('', () => this.enter(item.project, item.path), 'picker-select');
    select.dataset.sessionPath = item.path; select.title = item.title;
    const heading = element('span', 'picker-session-heading'); const identity = element('span', 'picker-session-tail', tail ?? ''); identity.hidden = !tail;
    heading.append(element('strong', 'picker-session-title', sessionLabel(item)), identity);
    const metadata = element('span', 'picker-session-meta');
    metadata.append(element('span', 'picker-session-folder', this.projectName(item.project)));
    if (opened) metadata.append(element('span', 'info', 'In this window'));
    else select.setAttribute('aria-description', 'If this session is active in a terminal, close it there first.');
    select.append(heading, metadata);
    let absolute = false;
    const formatted = absoluteTime(item.modifiedAt);
    const describeTime = () => age.setAttribute('aria-label', `Session time: ${formatted}. Show ${absolute ? 'relative' : 'absolute'} time.`);
    const age = button(relativeTime(item.modifiedAt, Date.now()), () => { absolute = !absolute; age.textContent = absolute ? formatted : relativeTime(item.modifiedAt, Date.now()); age.setAttribute('aria-pressed', String(absolute)); describeTime(); }, 'picker-age quiet');
    age.title = formatted; describeTime();
    const details = element('details', 'picker-session-details'); const summary = element('summary'); controlIcon(summary, 'info', `Details for ${item.title}`);
    details.append(summary, element('p', 'picker-session-full-title', item.title), element('p', 'identity', item.project), element('p', 'identity', item.id), element('p', 'identity', item.path), element('p', 'secondary', sessionSize(item.size)));
    if (!opened) details.append(element('p', 'secondary', 'If this session is active in a terminal, close it there first.'));
    row.append(select, age, details); return row;
  }
  private navigate(event: KeyboardEvent, list: HTMLElement): void {
    if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && event.target.matches('.picker-select, .picker-project-row')) {
      event.preventDefault(); event.target.click(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>('.picker-select, .picker-project-row')]; if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? (current + 1) % rows.length : (current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length);
    rows[index]?.focus();
  }
  private sessionFile(project: string, search: HTMLElement, changed: () => void): HTMLDetailsElement {
    const disclosure = element('details', 'picker-file'); const summary = element('summary', 'secondary', 'Session file…'); cardDisclosure(summary); disclosure.append(summary);
    const session = input('Session file'); session.field.id = 'picker-session-path'; session.label.htmlFor = session.field.id;
    const error = element('p', 'error'); error.id = 'picker-file-error'; error.setAttribute('role', 'alert'); session.field.setAttribute('aria-describedby', error.id);
    const resume = () => {
      error.textContent = '';
      if (!savedPathValid(session.field.value)) { error.textContent = 'Enter a saved session path that starts with /.'; session.field.focus(); return; }
      this.enter(project, session.field.value, cause => { error.textContent = cause instanceof Error ? cause.message : String(cause); session.field.focus(); });
    };
    disclosure.append(pickerField(session, true), error, button('Resume session', resume, 'main-action'));
    disclosure.addEventListener('toggle', () => { changed(); disclosure.hidden = !disclosure.open; if (disclosure.open) session.field.focus(); else search.focus(); });
    session.field.addEventListener('keydown', event => { if (event instanceof KeyboardEvent && event.key === 'Enter') { event.preventDefault(); resume(); } });
    return disclosure;
  }
  private enter(project: string, path: string, failed?: (cause: unknown) => void): void {
    if (!savedPathValid(path)) { this.error(undefined, 'Enter a saved session path that starts with /.'); return; }
    const current = sessionOwner(this.ctx.snapshot()?.primaries ?? [], path);
    void this.run(() => current
      ? this.select({primaryKey: current.key, selectedTarget: {kind: 'primary', key: current.key, epoch: current.epoch}})
      : this.start(project, path), failed);
  }
  private async select(change: SelectionChange): Promise<void> {
    await this.ctx.selection(change);
    await this.ctx.reload();
  }
  private async start(project: string, path?: string): Promise<void> {
    const result = await operation('primary.open', '/api/primaries', {cwd: project, ...(path !== undefined ? {sessionFile: path} : {})});
    const opened = result as unknown as {primaryKey?: string; operation?: OperationView};
    if (opened.operation?.error) throw new Error(opened.operation.error.message);
    if (!opened.primaryKey) throw new Error('Pi did not open the primary. Your project choice stays unchanged.');
    await this.ctx.reload();
  }
}
