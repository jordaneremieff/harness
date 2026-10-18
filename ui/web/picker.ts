import type { AgentRow, CachedRoster, Bootstrap, OperationView, PrimaryView, RecentProjectPage, SavedSession, SavedSessionPage, Snapshot } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
import { button, details, element, input } from './dom.ts';
import { cardAction, cardDisclosure, controlIcon } from './card-icons.ts';
import { projectIdentity, projectLabels, presentationName, type ConversationPresentation } from './conversation-presentation.ts';
import { contextMenu, type ContextItem } from './context-menu.ts';
import { duplicateIdentityTails } from './tabs.ts';
import { absoluteTime, relativeTime } from './format.ts';
import type { Modal } from './modal.ts';
import { filterSessions, loadedPrimarySession, mergeSessions, mergeSessionTitles, savedPathValid, sessionCoverage, sessionEmptyMessage, sessionOwner, sessionSize, sessionLabel, type SessionList } from './picker-state.ts';
import { operation, request, reserve } from './transport.ts';

function pickerField(control: {label: HTMLLabelElement; field: HTMLElement}, visibleLabel = false): HTMLElement {
  control.field.className = 'picker-input';
  const line = element('div', 'picker-input-row');
  control.label.className = visibleLabel ? 'picker-field-label' : 'sr-only'; line.append(control.label, control.field); return line;
}
function partialSessions(page: SavedSessionPage): boolean {
  return !!page.nextCursor || !!page.omitted || page.items.some(item => item.titleState !== 'ready');
}
function savedListDetails(page: SavedSessionPage, registered = false): string {
  const count = registered ? `${page.items.length} of ${page.total} sessions loaded${page.omitted ? ` · ${page.omitted} discovery records are unavailable or outside the bound.` : ''}` : sessionCoverage(page);
  return [count, page.nextCursor ? 'More records are available.' : '', page.items.some(item => item.titleState !== 'ready') ? 'Some loaded titles are pending or unavailable.' : '', `Saved list · ${relativeTime(page.observedAt, Date.now())}`].filter(Boolean).join('\n');
}
function groupHeading(name: string, qualifier?: string, partialChanged?: (partial: boolean) => void) {
  const node = element('div', 'picker-group-heading'), disclosure = element('details', 'picker-list-details');
  const summary = element('summary'), content = element('p', 'secondary picker-list-facts');
  disclosure.append(summary, content); node.append(element('h2', undefined, name));
  if (qualifier) node.append(element('span', 'secondary', qualifier));
  node.append(disclosure);
  const update = (text: string, partial: boolean) => {
    const label = 'List details'; summary.textContent = label; cardDisclosure(summary); partialChanged?.(partial && !!text);
    summary.setAttribute('aria-label', `${label}: ${name}`); content.textContent = text; disclosure.hidden = !text;
  };
  update('', false); return {node, disclosure, summary, update};
}
function projectCoverage(page: RecentProjectPage): string {
  if (!page.nextCursor && !page.omitted) return '';
  const omitted = page.omitted ? ` · ${page.omitted} ${page.omitted === 1 ? 'entry is' : 'entries are'} not listed.` : '';
  return `${page.items.length} of ${page.total} projects shown${omitted}`;
}
function projectPage(previous: RecentProjectPage | undefined, page: RecentProjectPage, append: boolean): RecentProjectPage {
  return {...page, items: append ? [...(previous?.items ?? []), ...page.items] : page.items};
}

function sessionDisplayTitle(item: SavedSession): string { return item.titleState === 'ready' && item.title === '' ? 'No title' : sessionLabel(item); }
const ORDINARY_RESUME_FULL = 'Before ordinary Resume, stop the terminal session. Each active process keeps its own in-memory branch; this window does not read later writes from another active process.';
/** One short line per dialog; each row keeps the complete text in its Details and accessible description. */
function ordinaryResumeWarning(): HTMLElement {
  const note = element('p', 'secondary picker-safety', 'Stop a terminal session before you resume it here.'); note.title = ORDINARY_RESUME_FULL; note.setAttribute('aria-description', ORDINARY_RESUME_FULL);
  return note;
}
function durableCoverage(roster?: CachedRoster): string {
  const notes: string[] = [];
  if (!roster || roster.scan.state === 'not-started') notes.push('The Durable catalog is not loaded.');
  else if (roster.scan.state === 'running') notes.push('Loading Durable conversations…');
  else if (roster.error || roster.scan.state === 'failed') notes.push('The Durable catalog could not refresh.');
  if (roster?.stale) notes.push('Saved Durable catalog; current coverage is not confirmed.');
  return notes.join(' ');
}
function durableListDetails(roster?: CachedRoster): string {
  if (!roster) return '';
  return [`${roster.rows.length} Durable conversations loaded.`, `${roster.scan.visited} discovery records visited; ${roster.scan.skipped} skipped; ${roster.scan.omitted} omitted.`, roster.observedAt ? `Saved list · ${relativeTime(roster.observedAt, Date.now())}` : '', roster.error?.message ?? ''].filter(Boolean).join('\n');
}

type Context = {snapshot(): Snapshot | undefined; primary(): PrimaryView | undefined; modal: Modal;
  agentPresentation(row: AgentRow): Pick<ConversationPresentation, 'name' | 'identityTail' | 'activity' | 'tone' | 'cwd' | 'hideVisibleState'>;
  selection(change: SelectionChange): Promise<void>; reload(): Promise<void>; selectOpened?(): (key:string)=>Promise<void>; selectConverted?(): (identity:string)=>Promise<void>; project?(): string | undefined; projectsChanged?(): void; titlesChanged?(): void; workingFolder?(path:string):Promise<void>};

const WRITER_ACTIVE = 'A terminal session is writing this file. Resume when it ends.';
const WRITER_HELD = 'Resume here when the terminal exits.';
const WRITER_ENDED = 'The terminal session ended. Resume here.';
function writerRefused(cause: unknown): boolean { return (cause as {view?: {code?: unknown}} | undefined)?.view?.code === 'writer_active'; }
/** Metadata caches belong to the picker, never to execution or writer ownership. */
export class ProjectPicker {
  private ctx: Context;
  private cached = new Map<string, SessionList>();
  private published?: SavedSessionPage;
  /** Saved files a terminal session held when last read, and files whose terminal has since ended. */
  private held = new Set<string>();
  private ended = new Set<string>();
  private reloadWriters?: () => void;
  private reloadPublished?: () => void;
  /** Called when a terminal session may have released a file: the open lists re-read their first page. */
  writersChanged(): void { this.reloadWriters?.(); }
  private noteWriters(items: readonly SavedSession[]): void {
    for (const item of items) {
      if (item.writer === 'live') { this.held.add(item.path); this.ended.delete(item.path); }
      else if (this.held.delete(item.path)) this.ended.add(item.path);
    }
  }
  /** The title of a Pi session whose metadata this picker already holds. It makes no request. */
  sessionTitle(id: string): string | undefined {
    for (const page of [...this.cached.values(), ...(this.published ? [this.published] : [])]) {
      const item = page.items.find(candidate => candidate.id === id);
      if (item && item.titleState !== 'pending' && item.title) return sessionLabel(item);
    }
    return undefined;
  }
  savedSession(primary?: PrimaryView): SavedSession | undefined { return loadedPrimarySession(primary, [...this.cached.values(), ...(this.published ? [this.published] : [])]); }
  private conversions = new Map<string,{id:string;revision:string}>();
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
    if (writerRefused(cause)) message = WRITER_ACTIVE;
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
    this.reloadWriters = undefined; this.reloadPublished = undefined;
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
  private sessionContext(body: HTMLElement, project: string): void {
    const projectDetails = element('details', 'picker-path');
    const folderSummary = element('summary', 'secondary', 'Working folder'); cardDisclosure(folderSummary);
    projectDetails.append(folderSummary, element('p', 'identity', project));
    const buttons = [...(this.inline ? [] : [cardAction('folder', 'Change working folder', () => this.selectProject())]), cardAction('plus', 'New session', () => { void this.run(() => this.start(project)); })];
    if (this.inline) { body.append(projectDetails); this.actions(...buttons); return; }
    const context = element('div', 'picker-context'), actions = element('div', 'picker-context-actions');
    actions.append(...buttons); context.append(projectDetails, actions); body.append(context);
  }
  private show(project?: string): void {
    if (!project) { this.selectProject(); return; }
    const {body, token} = this.begin(`Sessions in ${this.projectName(project)}`); this.shownProject = project;
    this.sessionContext(body, project);
    body.append(element('p', 'secondary', 'Loading sessions…'));
    void this.sessions(project).catch(cause => {
      if (!this.owns(token)) return;
      body.replaceChildren(); this.sessionContext(body, project);
      body.append(element('p', 'error', 'Sessions could not be loaded.'), cardAction('restart', 'Retry saved sessions', () => this.show(project)));
      if (this.inlineError && !this.inline) body.append(this.inlineError);
      this.error(cause, '');
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
      void this.run(()=>this.chooseWorkingFolder(path),cause=> {this.begin('Working folder');this.error(cause,'The working folder is unchanged.');});
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
  private async chooseWorkingFolder(path:string):Promise<void> {
    await this.ctx.workingFolder?.(path);
    if(this.inline) this.show(path);
  }
  private selectFolder(): void {
    const {body, token} = this.begin('Working folder');
    const directory = input('Working folder', this.project() ?? ''); directory.field.id = 'picker-project'; directory.label.htmlFor = directory.field.id;
    const error = element('p', 'error'); error.setAttribute('role', 'alert');
    const next = () => {
      if (!savedPathValid(directory.field.value)) {error.textContent = 'Enter a working folder path that starts with /.'; directory.field.focus(); return;}
      error.textContent = '';
      if (this.ctx.workingFolder) {void this.run(()=>this.chooseWorkingFolder(directory.field.value));return;}
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
      this.noteWriters(first.items);
    }
    const {body, token, signal} = this.begin(`Sessions in ${this.projectName(project)}`); this.shownProject = project;
    this.sessionContext(body, project);
    const safety = ordinaryResumeWarning(); let folderResumable = false, catalogResumable = false, fileFormOpen = false;
    const syncSafety = () => { safety.hidden = fileFormOpen || !(folderResumable || catalogResumable); };
    const partialGroups = new Set<string>(), partialNote = element('p', 'secondary picker-partial', 'Partial list'); partialNote.hidden = true;
    const markPartial = (group: string, partial: boolean) => { if (partial) partialGroups.add(group); else partialGroups.delete(group); partialNote.hidden = !partialGroups.size; };
    const search = input('Search sessions'); search.field.id = 'picker-search'; search.label.htmlFor = search.field.id; search.field.placeholder = 'Search sessions';
    const searchRow = element('div', 'picker-search-row'); searchRow.append(pickerField(search)); body.append(searchRow, safety);
    const results = element('div', 'picker-results'); body.append(results);
    const publishedPaths=new Set<string>();
    const paintCatalog = this.catalog(results,signal,token,()=>search.field.value,()=>search.field.focus(),paths=>{if(paths){publishedPaths.clear();for(const path of paths)publishedPaths.add(path);}paint();},{resumable:flag=>{catalogResumable=flag;syncSafety();},partial:markPartial});
    const ordinary = element('section', 'picker-folder-ordinary'), heading = groupHeading('Ordinary sessions in this folder', undefined, partial => markPartial('folder', partial)); ordinary.append(heading.node);
    const list = element('div', 'picker-sessions'); const coverage = element('p', 'secondary'); coverage.id = 'picker-coverage'; coverage.setAttribute('aria-live', 'polite');
    const error = element('p', 'error'); error.setAttribute('role', 'alert');
    let data = first ? mergeSessions(undefined, first) : existing;
    let render = 0; let loading = 0; const titleRequests = new Set<string>();
    const more = cardAction('next', 'More saved sessions', () => { void load(data?.nextCursor ?? undefined); }); more.id = 'picker-more';
    const moreLabel = more.querySelector('.card-action-label'); if (moreLabel) moreLabel.className = 'card-action-label';
    const updateCoverage = () => {
      const count = results.querySelectorAll('.picker-durable-select, .picker-select').length;
      coverage.textContent = search.field.value.trim() ? `${count} ${count === 1 ? 'match' : 'matches'} in loaded sessions` : `${count} loaded ${count === 1 ? 'session' : 'sessions'}`;
      if (data) heading.update(savedListDetails(data), partialSessions(data));
    };
    const paint = () => {
      const focusedPath = [...list.querySelectorAll<HTMLButtonElement>('.picker-select')].find(row=>row===document.activeElement)?.dataset.sessionPath;
      const version = ++render; paintCatalog(); list.replaceChildren();
      if (!data) { updateCoverage(); return; }
      const matches = filterSessions(data.items, search.field.value).filter(item=>!publishedPaths.has(item.path));
      const tails = duplicateIdentityTails(data.items.map(item => ({name: sessionLabel(item), identity: item.id})));
      if (focusedPath && !matches.some(item => item.path === focusedPath)) { search.field.focus(); error.textContent = 'The selected session is no longer in this loaded list.'; }
      more.hidden = !data.nextCursor; folderResumable = matches.some(item => !sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path)); syncSafety();
      let offset = 0;
      const batch = () => {
        if (version !== render || !this.owns(token)) return;
        const fragment = document.createDocumentFragment();
        const latest = new Map(data?.items.map(item => [item.path, item]));
        const rows = matches.slice(offset, offset + 20).map(item => this.row(latest.get(item.path) ?? item, tails.get(item.id)));
        fragment.append(...rows); list.append(fragment); offset += 20; updateCoverage();
        if (focusedPath) rows.find(row => row.querySelector<HTMLButtonElement>('.picker-select')?.dataset.sessionPath === focusedPath)?.querySelector<HTMLButtonElement>('.picker-select')?.focus();
        if (offset < matches.length) requestAnimationFrame(batch);
      };
      batch();
      if (!matches.length) list.append(element('p', 'secondary', sessionEmptyMessage(search.field.value)));
    };
    const save = () => {
      if (!data) return;
      this.cached.delete(project); this.cached.set(project, data);
      if (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value ?? '');
      this.ctx.titlesChanged?.();
    };
    const load = async (cursor?: string) => {
      const generation = ++loading; const current = () => this.owns(token) && generation === loading;
      more.disabled = true; refresh.disabled = true; error.textContent = '';
      try {
        const page = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, signal);
        if (!this.owns(token)) return;
        if (generation !== loading) return;
        this.noteWriters(page.items);
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
          updateCoverage();
        }
      } catch (cause) { if (!signal.aborted && this.owns(token)) { error.textContent = 'Some session titles did not load. Use Refresh.'; this.error(cause, ''); } }
    };
    const refresh = cardAction('restart', 'Refresh saved sessions', () => { void load(); this.reloadPublished?.(); }); searchRow.append(refresh);
    this.reloadWriters = () => { if (this.owns(token)) { void load(); this.reloadPublished?.(); } };
    const file = this.sessionFile(project, search.field, open => { fileFormOpen = open; syncSafety(); }); file.hidden = true;
    const options = cardAction('more', 'Saved session options', () => {
      const box = options.getBoundingClientRect();
      contextMenu.open(options, {x: box.left, y: box.bottom}, 'Saved session options', [
        {key: 'details', label: 'List details', run: () => { heading.disclosure.hidden = false; heading.disclosure.open = true; heading.summary.focus(); }},
        {key: 'file', label: 'Session file…', run: () => { file.hidden = false; file.open = true; file.querySelector<HTMLInputElement>('#picker-session-path')?.focus(); }},
      ], () => this.owns(token));
    });
    options.setAttribute('aria-haspopup', 'menu'); options.setAttribute('aria-expanded', 'false');
    searchRow.append(options);
    const footer = element('div', 'picker-project-actions picker-footer'); footer.append(coverage, partialNote);
    ordinary.append(list, error, more, file); results.append(ordinary); body.append(footer);
    results.addEventListener('keydown', event => {
      if (event.target instanceof HTMLButtonElement && event.target.matches('.picker-select, .picker-durable-select')) this.navigate(event, results);
    });
    search.field.addEventListener('input', paint); search.field.addEventListener('keydown', event => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') this.navigate(event, results);
      if (event.key === 'Enter') { event.preventDefault(); results.querySelector<HTMLButtonElement>('.picker-durable-select, .picker-select')?.click(); }
    });
    save(); paint(); for (const page of data?.pendingTitles ?? []) void fillTitles(page); search.field.focus();
  }
  private catalog(body:HTMLElement,signal:AbortSignal,token:number,query:()=>string,focusSearch:()=>void,changed:(paths?:string[])=>void,hooks:{resumable:(flag:boolean)=>void;partial:(group:string,flag:boolean)=>void}):()=>void {
    const durable=element('section','picker-durable'), durableHeading=groupHeading('Durable conversations',undefined,partial=>hooks.partial('durable',partial));
    const roster = this.ctx.snapshot()?.roster, list = element('div', 'picker-durable-list');
    const coverage = element('p', 'secondary picker-durable-coverage', durableCoverage(roster)); coverage.hidden = !coverage.textContent;
    durableHeading.update(durableListDetails(roster), !!roster && (!!roster.nextCursor || !roster.scan.complete || !!roster.scan.skipped || !!roster.scan.omitted));
    durable.append(durableHeading.node, coverage, list);
    const ordinary=element('section','picker-ordinary'), registered=element('div','picker-registered-list'), registeredHeading=groupHeading('Registered ordinary sessions', 'All folders', partial=>hooks.partial('registered',partial));
    const status=element('p','secondary'); status.setAttribute('aria-live','polite');
    ordinary.append(registeredHeading.node, status, registered);
    body.append(durable,ordinary);
    let loaded=false,failed=false;
    const selectable=()=>[...list.querySelectorAll<HTMLButtonElement>('.picker-durable-select'),...registered.querySelectorAll<HTMLButtonElement>('.picker-select')];
    const restoreFocus=(focused?:HTMLButtonElement)=> {
      if(!focused)return;
      const replacement=selectable().find(row=>focused.dataset.agentIdentity ? row.dataset.agentIdentity===focused.dataset.agentIdentity : row.dataset.sessionPath===focused.dataset.sessionPath);
      if(replacement)replacement.focus();else focusSearch();
    };
    const updateRegisteredDetails=()=> {
      const published=loaded?this.published:undefined;
      registeredHeading.update(published ? savedListDetails(published, true) : '', !!published && partialSessions(published));
      status.textContent=failed ? 'Registered ordinary sessions are unavailable. Refresh the session picker.' : published ? '' : 'Loading registered ordinary sessions…'; status.hidden=!status.textContent;
    };
    const paint=()=> {
      const focused=selectable().find(row=>row===document.activeElement);
      const needle=query().trim().toLocaleLowerCase();
      const matches=(roster?.rows ?? []).filter(row=> {
        const view=this.ctx.agentPresentation(row);
        return !needle || [presentationName(view),row.identity,view.cwd].some(value=>value?.toLocaleLowerCase().includes(needle));
      });
      list.replaceChildren(...matches.map(row=>this.durableRow(row)));
      if(!matches.length && roster?.scan.state === 'ready' && !roster.error)list.append(element('p','secondary',sessionEmptyMessage(query())));
      const published=loaded?this.published:undefined;
      const items=filterSessions(published?.items ?? [],query());
      const tails=duplicateIdentityTails((published?.items ?? []).map(item=>({name:sessionLabel(item),identity:item.id})));
      registered.replaceChildren(...items.map(item=>this.row(item,tails.get(item.id))));
      hooks.resumable(items.some(item=>!sessionOwner(this.ctx.snapshot()?.primaries ?? [],item.path)));
      if(published && !items.length)registered.append(element('p','secondary',sessionEmptyMessage(query())));
      updateRegisteredDetails();
      restoreFocus(focused);
    };
    const readPublished=()=>void request<SavedSessionPage>('/api/sessions/published','GET',undefined,undefined,signal).then(page=>{
      if(!this.owns(token)||signal.aborted)return;
      this.noteWriters(page.items);this.published=page;loaded=true;failed=false;this.ctx.titlesChanged?.();changed(page.items.map(item=>item.path));
    }).catch(()=>{if(this.owns(token)&&!signal.aborted){failed=true;changed();}});
    this.reloadPublished=readPublished;readPublished();
    return paint;
  }
  private durableRow(row: AgentRow): HTMLElement {
    const view = this.ctx.agentPresentation(row);
    const select = button('', () => {void this.run(async () => {await this.ctx.selection({panelVisible:true,selectedTarget:{kind:'agent',identity:row.identity}});await this.ctx.reload();});}, 'picker-durable-select');
    select.dataset.agentIdentity = row.identity;
    const heading = element('span', 'picker-session-heading'), tail = element('span', 'picker-session-tail', view.identityTail ?? ''); tail.hidden = !tail.textContent;
    heading.append(element('strong', 'picker-session-title', view.name), tail);
    select.append(heading);
    // An unchecked live connection stays in the title and accessible name; it is not repeated as a visible line on every row.
    if (!view.hideVisibleState) {const state = element('span', 'conversation-state picker-durable-state', view.activity); state.dataset.tone = view.tone; select.append(state);}
    if (view.cwd) {const folder = element('span', 'picker-session-meta', `Saved folder: ${this.projectName(view.cwd)}`); folder.title = view.cwd; select.append(folder);}
    const caption = presentationName(view);
    select.title = [caption, row.identity, view.activity, view.cwd].filter(Boolean).join('\n');
    select.setAttribute('aria-label', `${caption} · ${row.identity} · ${view.activity}`);
    return select;
  }
  private patchTitles(list: HTMLElement, data: SessionList): void {
    const items = new Map(data.items.map(item => [item.path, item]));
    const tails = duplicateIdentityTails(data.items.map(item => ({name: sessionLabel(item), identity: item.id})));
    for (const row of list.querySelectorAll<HTMLElement>('.picker-session')) {
      const select = row.querySelector<HTMLButtonElement>('.picker-select'); if (!select) continue;
      const item = items.get(select.dataset.sessionPath ?? ''); const title = select.querySelector('.picker-session-title');
      if (item && title) { title.textContent = sessionDisplayTitle(item); select.title = item.title;
        const full = row.querySelector('.picker-session-full-title'); if (full) full.textContent = item.title;
        const tail = tails.get(item.id);
        const identity = select.querySelector<HTMLElement>('.picker-session-tail'); if (identity) { identity.textContent = tail ?? ''; identity.hidden = !tail; }
      }
    }
  }
  private row(item: SavedSession, tail?: string): HTMLElement {
    const row = element('div', 'picker-session');
    const opened = sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path);
    const writer = !opened && item.writer === 'live', ended = !opened && !writer && this.ended.has(item.path);
    const select = button('', () => this.resume(item.project, item.path), 'picker-select'); select.disabled = writer;
    select.dataset.sessionPath = item.path; select.title = item.title;
    const heading = element('span', 'picker-session-heading'); const identity = element('span', 'picker-session-tail', tail ?? ''); identity.hidden = !tail;
    heading.append(element('strong', 'picker-session-title', sessionDisplayTitle(item)), identity);
    const metadata = element('span', 'picker-session-meta');
    metadata.append(element('span', 'picker-session-folder', this.projectName(item.project)));
    if (opened) metadata.append(element('span', 'info', 'In this window'));
    else if (writer) { metadata.append(element('span', 'info', 'Open in a terminal · Resume when it exits')); select.setAttribute('aria-description', WRITER_HELD); }
    else if (ended) metadata.append(element('span', 'info picker-ended', WRITER_ENDED));
    else select.setAttribute('aria-description', ORDINARY_RESUME_FULL);
    select.append(heading, metadata);
    let absolute = false;
    const formatted = absoluteTime(item.modifiedAt);
    const describeTime = () => age.setAttribute('aria-label', `Session time: ${formatted}. Show ${absolute ? 'relative' : 'absolute'} time.`);
    const age = button(relativeTime(item.modifiedAt, Date.now()), () => { absolute = !absolute; age.textContent = absolute ? formatted : relativeTime(item.modifiedAt, Date.now()); age.setAttribute('aria-pressed', String(absolute)); describeTime(); }, 'picker-age quiet');
    age.title = formatted; describeTime();
    const details = element('details', 'picker-session-details'); const summary = element('summary'); controlIcon(summary, 'info', `Details for ${item.title}`);
    details.append(summary, element('p', 'picker-session-full-title', item.title), element('p', 'identity', item.project), element('p', 'identity', item.id), element('p', 'identity', item.path), element('p', 'secondary', sessionSize(item.size)));
    if (!opened && !writer && !ended) details.append(element('p', 'secondary', ORDINARY_RESUME_FULL));
    const convert=button('Convert to Durable',()=>{void this.run(()=>this.convert(item),cause=>this.error(cause,'The conversion did not return a confirmed conversation.'));},'quiet');
    convert.title='Creates a new Durable conversation from saved context. Leaves the ordinary session unchanged.';
    convert.setAttribute('aria-description', convert.title);
    if (opened) { row.append(select, age, convert, details); return row; }
    const resume = button('Resume', () => this.resume(item.project, item.path), 'quiet picker-resume'); resume.disabled = writer;
    if (writer) { resume.title = WRITER_HELD; resume.setAttribute('aria-description', WRITER_HELD); }
    row.append(select, age, resume, convert, details); return row;
  }
  private navigate(event: KeyboardEvent, list: HTMLElement): void {
    if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && event.target.matches('.picker-select, .picker-project-row, .picker-durable-select')) {
      event.preventDefault(); event.target.click(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>('.picker-select, .picker-project-row, .picker-durable-select')]; if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? (current + 1) % rows.length : (current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length);
    rows[index]?.focus();
  }
  /** The form carries its own caution, so `formToggled` lets the list-level line step aside while the form is open. */
  private sessionFile(project: string, search: HTMLElement, formToggled: (open: boolean) => void = () => {}): HTMLDetailsElement {
    const disclosure = element('details', 'picker-file'); const summary = element('summary', 'secondary', 'Session file…'); cardDisclosure(summary); disclosure.append(summary);
    const session = input('Session file'); session.field.id = 'picker-session-path'; session.label.htmlFor = session.field.id;
    const error = element('p', 'error'); error.id = 'picker-file-error'; error.setAttribute('role', 'alert'); session.field.setAttribute('aria-describedby', error.id);
    const resume = () => {
      error.textContent = '';
      if (!savedPathValid(session.field.value)) { error.textContent = 'Enter a saved session path that starts with /.'; session.field.focus(); return; }
      this.resume(project, session.field.value, cause => { error.textContent = cause instanceof Error ? cause.message : String(cause); session.field.focus(); });
    };
    disclosure.append(ordinaryResumeWarning(), pickerField(session, true), error, button('Resume session', resume, 'main-action'));
    disclosure.addEventListener('toggle', () => { disclosure.hidden = !disclosure.open; formToggled(disclosure.open); if (disclosure.open) session.field.focus(); else search.focus(); });
    session.field.addEventListener('keydown', event => { if (event instanceof KeyboardEvent && event.key === 'Enter') { event.preventDefault(); resume(); } });
    return disclosure;
  }
  resume(project: string, path: string, failed?: (cause: unknown) => void): void {
    void this.run(() => {
      if (!savedPathValid(path)) throw new Error('Enter a saved session path that starts with /.');
      const current = sessionOwner(this.ctx.snapshot()?.primaries ?? [], path);
      return current
        ? this.select({primaryKey: current.key, selectedTarget: {kind: 'primary', key: current.key, epoch: current.epoch}})
        : this.start(project, path).catch(cause => { if (writerRefused(cause)) this.writersChanged(); throw cause; });
    }, failed);
  }
  private async select(change: SelectionChange): Promise<void> {
    const selected = this.ctx.selectOpened?.(),revision = this.revision,inline = !!this.inline;
    if (!selected) await this.ctx.selection(change);
    await this.ctx.reload();
    if (change.primaryKey && (inline || this.owns(revision))) await selected?.(change.primaryKey);
  }
  private async convert(item:SavedSession):Promise<void> {
    const selected=this.ctx.selectConverted?.(),revision=this.revision,workspace=this.ctx.snapshot()?.workspace.id;
    const previous=this.conversions.get(item.path);
    if(previous&&previous.revision!==item.revision)throw new Error(`Inspect the prior conversion before another request. Operation: ${previous.id}.`);
    const key=previous?.id??await reserve('agent.convert');this.conversions.set(item.path,{id:key,revision:item.revision});
    const result=await operation('agent.convert','/api/agents/convert',{path:item.path,project:item.project,id:item.id,revision:item.revision},undefined,key).catch(cause=>{throw new Error(`${cause instanceof Error?cause.message:'The conversion response was lost.'} Operation: ${key}. Inspect this operation before another conversion.`);});
    if(result.state==='rejected')this.conversions.delete(item.path);
    const value=result.receipt?.kind==='rpc'?result.receipt.result?.value:undefined;
    const identity=value&&typeof value==='object'&&!Array.isArray(value)&&'identity' in value&&typeof value.identity==='string'?value.identity:undefined;
    if(result.state!=='completed'||!identity)throw new Error(`${result.error?.message??'The native creation receipt is unavailable.'} Operation: ${result.id}.${identity?` Possible identity: ${identity}.`:''}`);
    if(selected)await selected(identity);
    else if(this.owns(revision)&&this.ctx.snapshot()?.workspace.id===workspace)await this.ctx.selection({panelVisible:true,selectedTarget:{kind:'agent',identity}});
    await this.ctx.reload();this.conversions.delete(item.path);
  }
  private async start(project: string, path?: string): Promise<void> {
    const selected = this.ctx.selectOpened?.(),revision = this.revision,inline = !!this.inline;
    const result = await operation('primary.open', '/api/primaries', {cwd: project, ...(path !== undefined ? {sessionFile: path} : {})});
    const opened = result as unknown as {primaryKey?: string; operation?: OperationView};
    if (opened.operation?.error) throw new Error(opened.operation.error.message);
    if (!opened.primaryKey) throw new Error('Pi did not open the primary. Your project choice stays unchanged.');
    await this.ctx.reload();
    // Refresh removes the first-use chooser when its returned session arrives.
    if (inline || this.owns(revision)) await selected?.(opened.primaryKey);
  }
}
