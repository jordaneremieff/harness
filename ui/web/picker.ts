import type { Bootstrap, OperationView, PrimaryView, RecentProjectPage, SavedSession, SavedSessionPage, Snapshot } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
import { button, element, input } from './dom.ts';
import { absoluteTime, relativeTime } from './format.ts';
import type { Modal } from './modal.ts';
import { filterSessions, mergeSessions, mergeSessionTitles, savedPathValid, sessionCoverage, sessionEmptyMessage, sessionOwner, sessionSize, type SessionList } from './picker-state.ts';
import { operation, request } from './transport.ts';

/** A picker field reads as a prompt line: a '›' gutter, the input, and a screen-reader label. */
function promptLine(control: {label: HTMLLabelElement; field: HTMLElement}): HTMLElement {
  const line = element('div', 'palette-input'); const prompt = element('span', 'palette-prompt', '›'); prompt.setAttribute('aria-hidden', 'true');
  control.label.className = 'sr-only'; line.append(prompt, control.label, control.field); return line;
}
function projectPage(previous: RecentProjectPage | undefined, page: RecentProjectPage, append: boolean): RecentProjectPage {
  return {...page, items: append ? [...(previous?.items ?? []), ...page.items] : page.items};
}

type Context = {snapshot(): Snapshot | undefined; primary(): PrimaryView | undefined; modal: Modal;
  selection(change: SelectionChange): Promise<void>; reload(): Promise<void>};

/** Metadata caches belong to the picker, never to execution or writer ownership. */
export class ProjectPicker {
  private ctx: Context;
  private cached = new Map<string, SessionList>();
  private projects?: RecentProjectPage;
  private pending = new AbortController();
  private choosing = 0;
  constructor(ctx: Context) { this.ctx = ctx; }
  private begin(title: string): {body: HTMLElement; token: number; signal: AbortSignal} {
    this.pending.abort(); this.pending = new AbortController();
    const body = this.ctx.modal.open(title, () => { this.pending.abort(); this.ctx.modal.close(); }, () => this.pending.abort());
    this.ctx.modal.node.dataset.variant = 'picker';
    return {body, token: this.ctx.modal.token, signal: this.pending.signal};
  }
  open(): void {
    const {modal} = this.ctx; const {body, token, signal} = this.begin('Open a project');
    const snapshot = this.ctx.snapshot();
    const directory = input('Project directory', this.ctx.primary()?.cwd ?? (snapshot as Bootstrap | undefined)?.launchCwd ?? '');
    directory.field.id = 'picker-project'; directory.label.htmlFor = directory.field.id;
    const error = element('p', 'error'); error.setAttribute('role', 'alert');
    const next = () => {
      const project = directory.field.value; const generation = this.choosing + 1;
      error.textContent = ''; progress.textContent = 'Loading saved sessions';
      void this.sessions(project).catch(cause => {
        if (modal.owns(token) && generation === this.choosing && !this.pending.signal.aborted) { progress.textContent = ''; error.textContent = cause instanceof Error ? cause.message : 'The project is unavailable.'; }
      });
    };
    const progress = element('p', 'secondary'); progress.setAttribute('role', 'status');
    body.append(promptLine(directory), error, progress);
    const launch = (snapshot as Bootstrap | undefined)?.launchCwd;
    modal.actions(button('Cancel', () => modal.cancel()), ...(launch ? [button('Use launch directory', () => { directory.field.value = launch; })] : []), button('Continue', next, 'main-action'));
    directory.field.addEventListener('keydown', event => { if (event instanceof KeyboardEvent && event.key === 'Enter') { event.preventDefault(); next(); } });
    body.append(element('h2', 'picker-heading', 'Recent projects'));
    const rows = element('div', 'options picker-projects'); const status = element('p', 'secondary picker-project-status', 'Loading recent projects');
    const more = button('More recent projects', () => { void load(this.projects?.nextCursor ?? undefined); }); more.hidden = true;
    const paint = () => {
      rows.replaceChildren();
      for (const project of this.projects?.items ?? []) {
        const node = button('', () => { directory.field.value = project.path; next(); }, 'picker-project-row');
        node.title = project.path;
        node.setAttribute('aria-label', `${project.name} · ${project.path}`);
        node.append(element('strong', undefined, project.name)); rows.append(node);
      }
      if (this.projects) {
        const incomplete = !!this.projects.nextCursor || !!this.projects.omitted;
        status.textContent = `${incomplete ? `${this.projects.items.length} of ${this.projects.total} projects shown · ` : ''}Saved list · ${relativeTime(this.projects.observedAt, Date.now())}${this.projects.omitted ? ` · ${this.projects.omitted} file or directory entries unexamined` : ''}`; more.hidden = !this.projects.nextCursor;
      }
    };
    let projectLoading = 0;
    const load = async (cursor?: string) => {
      const generation = ++projectLoading; const current = () => modal.owns(token) && generation === projectLoading;
      more.disabled = true;
      try {
        const page = await request<RecentProjectPage>(`/api/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, signal);
        if (!modal.owns(token)) return;
        if (generation !== projectLoading) return;
        this.projects = projectPage(this.projects, page, !!cursor); paint();
      } catch (cause) { if (!signal.aborted && current()) { status.textContent = 'Recent projects are unavailable.'; modal.error(cause); } }
      finally { if (current()) more.disabled = false; }
    };
    const projectActions = element('div', 'picker-project-actions');
    projectActions.append(status, more, button('Refresh recent projects', () => { void load(); }));
    body.append(rows, projectActions); rows.addEventListener('keydown', event => this.navigate(event, rows));
    if (this.projects) paint(); else void load();
    this.openPrimaries(body, snapshot);
    projectActions.append(button('Open saved session path…', () => this.manual(directory.field.value)));
    directory.field.focus(); directory.field.setSelectionRange(0, 0); directory.field.scrollLeft = 0;
  }
  private openPrimaries(body: HTMLElement, snapshot?: Snapshot): void {
    if (!snapshot?.primaries.length && !snapshot?.primaryIndex?.length) return;
    body.append(element('h2', 'picker-heading', 'Open in this workspace'));
    for (const item of snapshot?.primaries ?? []) body.append(button(`${item.sessionName ?? item.sessionId ?? 'Session'} · ${item.cwd} · ${item.lifecycle}`, () => {
      void this.ctx.modal.run(() => this.ctx.selection({primaryKey: item.key, selectedTarget: null}));
    }));
    for (const index of snapshot?.primaryIndex ?? []) if (!snapshot?.primaries.some(item => item.key === index.key)) body.append(button(`Backend session ${index.key} · ${index.lifecycle}`, () => {
      void this.ctx.modal.run(() => this.ctx.selection({primaryKey: index.key, selectedTarget: null}));
    }));
  }
  private async sessions(project: string): Promise<void> {
    const {modal} = this.ctx;
    const choosing = ++this.choosing;
    this.pending.abort(); this.pending = new AbortController();
    // An uncached invalid directory leaves the first screen and its field intact.
    const existing = this.cached.get(project);
    const initialToken = modal.token;
    let first: SavedSessionPage | undefined;
    if (!existing) {
      first = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}`, 'GET', undefined, undefined, this.pending.signal);
      if (!modal.owns(initialToken) || choosing !== this.choosing) return;
    }
    const {body, token, signal} = this.begin(project.split('/').filter(Boolean).at(-1) ?? project);
    const projectDetails = element('details', 'picker-path');
    projectDetails.append(element('summary', 'secondary', 'Project directory'), element('p', 'identity', project));
    body.append(projectDetails);
    modal.actions(button('Back to projects', () => this.open()), button('Start new session', () => { void modal.run(() => this.start(project)); }, 'main-action'));
    body.append(element('h2', 'picker-heading', 'Resume a saved session'));
    const search = input('Search saved sessions'); search.field.id = 'picker-search'; search.label.htmlFor = search.field.id; search.field.placeholder = 'Search loaded sessions…';
    body.append(promptLine(search));
    const list = element('div', 'picker-sessions'); const coverage = element('p', 'secondary'); coverage.id = 'picker-coverage'; coverage.setAttribute('aria-live', 'polite');
    const error = element('p', 'error'); error.setAttribute('role', 'alert');
    let data = first ? mergeSessions(undefined, first) : existing;
    let render = 0; let loading = 0; const titleRequests = new Set<string>();
    const more = button('More saved sessions', () => { void load(data?.nextCursor ?? undefined); }); more.id = 'picker-more';
    const updateCoverage = (matches: number) => {
      if (!data) return;
      const incomplete = !!data.nextCursor || !!data.omitted || data.items.some(item => item.titleState === 'unavailable');
      coverage.textContent = `${incomplete ? `${sessionCoverage(data, matches, search.field.value)} · ` : ''}Saved list · ${relativeTime(data.observedAt, Date.now())}`;
    };
    const paint = () => {
      const focusedPath = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('picker-select') ? document.activeElement.dataset.sessionPath : undefined;
      const version = ++render; list.replaceChildren();
      if (!data) return;
      const matches = filterSessions(data.items, search.field.value);
      if (focusedPath && !matches.some(item => item.path === focusedPath)) { search.field.focus(); error.textContent = 'The selected session is no longer in this loaded list.'; }
      updateCoverage(matches.length);
      more.hidden = !data.nextCursor;
      let offset = 0;
      const batch = () => {
        if (version !== render || !modal.owns(token)) return;
        const fragment = document.createDocumentFragment();
        const latest = new Map(data?.items.map(item => [item.path, item]));
        const rows = matches.slice(offset, offset + 20).map(item => this.row(latest.get(item.path) ?? item));
        fragment.append(...rows); list.append(fragment); offset += 20;
        if (focusedPath) rows.find(row => row.querySelector<HTMLButtonElement>('.picker-select')?.dataset.sessionPath === focusedPath)?.querySelector<HTMLButtonElement>('.picker-select')?.focus();
        if (offset < matches.length) requestAnimationFrame(batch);
      };
      batch();
      if (!matches.length) list.append(element('p', 'secondary', sessionEmptyMessage(data)));
    };
    const save = () => {
      if (!data) return;
      this.cached.delete(project); this.cached.set(project, data);
      if (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value ?? '');
    };
    const load = async (cursor?: string) => {
      const generation = ++loading; const current = () => modal.owns(token) && generation === loading;
      more.disabled = true; error.textContent = '';
      try {
        const page = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, signal);
        if (!modal.owns(token)) return;
        if (generation !== loading) return;
        data = mergeSessions(data, page, !!cursor); save(); paint(); void fillTitles(page);
      } catch (cause) { if (!signal.aborted && current()) { error.textContent = 'The saved list did not refresh. Use Refresh to reload the first page.'; modal.error(cause); } }
      finally { if (current()) more.disabled = false; }
    };
    const fillTitles = async (page: SavedSessionPage) => {
      if (!page.titleCursor || !page.items.some(item => item.titleState === 'pending') || titleRequests.has(page.titleCursor)) return;
      titleRequests.add(page.titleCursor);
      try {
        const filled = await request<SavedSessionPage>(`/api/sessions?project=${encodeURIComponent(project)}&titles=${encodeURIComponent(page.titleCursor)}`, 'GET', undefined, undefined, signal);
        if (!modal.owns(token) || !data) return;
        data = mergeSessionTitles(data, filled); save();
        if (search.field.value.trim()) paint(); else {
          this.patchTitles(list, data);
          updateCoverage(data.items.length);
        }
      } catch (cause) { if (!signal.aborted && modal.owns(token)) { error.textContent = 'Some session titles did not load. Use Refresh.'; modal.error(cause); } }
    };
    const utilities = element('div', 'picker-project-actions');
    utilities.append(coverage, more, button('Refresh', () => { void load(); }), button('Open saved session path…', () => this.manual(project)));
    body.append(list, error, utilities);
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
    for (const select of list.querySelectorAll<HTMLButtonElement>('.picker-select')) {
      const item = items.get(select.dataset.sessionPath ?? ''); const title = select.querySelector('.picker-session-title');
      if (item && title) title.textContent = item.titleState === 'pending' ? 'Loading title…' : item.title;
    }
  }
  private row(item: SavedSession): HTMLElement {
    const row = element('div', 'picker-session');
    const opened = sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path);
    const select = button('', () => {
      const current = sessionOwner(this.ctx.snapshot()?.primaries ?? [], item.path);
      if (current) { void this.ctx.modal.run(() => this.ctx.selection({primaryKey: current.key, selectedTarget: {kind: 'primary', key: current.key, epoch: current.epoch}})); return; }
      this.confirm(item.project, item.path);
    }, 'picker-select');
    select.dataset.sessionPath = item.path;
    select.append(element('strong', 'picker-session-title', item.titleState === 'pending' ? 'Loading title…' : item.title), element('span', 'secondary identity', `${item.id} · ${sessionSize(item.size)}`));
    if (opened) select.append(element('span', 'info', 'Open in this workspace'));
    let absolute = false;
    const age = button(relativeTime(item.modifiedAt, Date.now()), () => { absolute = !absolute; age.textContent = absolute ? absoluteTime(item.modifiedAt) : relativeTime(item.modifiedAt, Date.now()); age.setAttribute('aria-pressed', String(absolute)); }, 'picker-age quiet');
    age.title = `${item.modifiedAt} · Click to show absolute time`; age.setAttribute('aria-label', `Session time: ${item.modifiedAt}. Toggle absolute time.`);
    row.append(select, age); return row;
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
  private manual(project: string): void {
    const {modal} = this.ctx; const {body} = this.begin('Open saved session path');
    const directory = input('Project directory', project); const session = input('Saved session path'); session.field.id = 'picker-session-path'; session.label.htmlFor = session.field.id;
    body.append(directory.label, directory.field, session.label, session.field);
    modal.actions(button('Back to projects', () => this.open()), button('Resume saved session', () => this.confirm(directory.field.value, session.field.value), 'main-action'));
    session.field.focus();
  }
  private confirm(project: string, path: string): void {
    if (!savedPathValid(path)) { this.ctx.modal.error(new Error('Enter an absolute saved session path.')); return; }
    this.pending.abort();
    this.ctx.modal.confirm('Confirm saved session resume', `${path}\nConfirm that this exact file is not open in a terminal or another Pi writer. Pi exposes no external writer lock query.`, () => this.start(project, path), 'No other writer · Resume');
  }
  private async start(project: string, path?: string): Promise<void> {
    const result = await operation('primary.open', '/api/primaries', {cwd: project, ...(path !== undefined ? {sessionFile: path, writerReleased: true} : {})});
    const opened = result as unknown as {primaryKey?: string; operation?: OperationView};
    if (opened.operation?.error) throw new Error(opened.operation.error.message);
    if (!opened.primaryKey) throw new Error('Pi did not open the primary. Your project choice stays unchanged.');
    await this.ctx.reload();
  }
}
