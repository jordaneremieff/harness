import type { AgentRow, Bootstrap, CommandView, EntryView, HandoffView, ModelChoice, OperationView, PrimaryControl, PrimaryView, ResourcePage, Snapshot, Target, Workspace } from '../shared/api.ts';
import { button, copy, details, element, input, rawText } from './dom.ts';
import type { Modal } from './modal.ts';
import { operation, request } from './transport.ts';
import type { Composer } from './composer.ts';
import { rankCommands } from './command-menu-state.ts';
import { relativeTime } from './format.ts';
import type { CommandInventory, CommandOption, CommandMatch } from './command-menu-state.ts';
export const COMMAND_INVENTORY_PAGE_LIMIT = 8;
type ResourceKind = 'commands' | 'models' | 'thinking';
const appCommands: CommandOption[] = [
  {name: 'new', description: 'Start a new session', source: 'app'},
  {name: 'resume', description: 'Open a saved session', source: 'app'},
  {name: 'fork', description: 'Start a branch from a user message', source: 'app'},
  {name: 'compact', description: 'Summarize the session context', source: 'app'},
  {name: 'model', description: 'Choose a model for the primary', source: 'app'},
  {name: 'thinking', description: 'Choose the thinking level', source: 'app'},
];

export type PaletteEntry = CommandOption & {enabled: boolean; run: () => void; search?: string[]; title?: string; tail?: string};
function compactAge(value: number, now: number): string {
  const full = relativeTime(value, now); if (!full) return '';
  const seconds = (now - value) / 1000;
  if (seconds < -60 || seconds >= 30 * 86400) return new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(new Date(value));
  return full.replace(/hr ago$/, 'h').replace(/ ago$/, '');
}
function agentName(row: AgentRow): string { return row.name ?? row.handle ?? row.identity; }
function agentTail(identity: string, counts: Map<string, number>[]): string {
  const colon = identity.lastIndexOf(':');
  if (colon >= 0 && colon < identity.length - 1) return identity.slice(colon + 1);
  const index = counts.findIndex((values, index) => values.get(identity.slice(-(index + 4))) === 1);
  return index < 0 ? identity : identity.slice(-(index + 4));
}
function duplicateAgentTails(rows: AgentRow[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const row of rows) { const name = agentName(row); const group = groups.get(name) ?? []; group.push(row.identity); groups.set(name, group); }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const counts = Array.from({length: 5}, (_, index) => {
      const values = new Map<string, number>();
      for (const identity of group) { const tail = identity.slice(-(index + 4)); values.set(tail, (values.get(tail) ?? 0) + 1); }
      return values;
    });
    for (const identity of group) labels.set(identity, agentTail(identity, counts));
  }
  return labels;
}
function paletteSourceOrder(item: CommandOption): number { return item.source === 'app' ? 0 : item.source === 'agent' ? 2 : 1; }
function agentOrder(row: AgentRow): number { return row.availability === 'live' || row.state === 'working' ? 0 : 1; }
export function rankPalette(entries: PaletteEntry[], query: string): CommandMatch[] {
  if (!query.trim()) return entries.map(item => ({item, rank: 1, marks: []})).sort((a, b) => paletteSourceOrder(a.item) - paletteSourceOrder(b.item));
  const matches = new Map<CommandOption, CommandMatch>(rankCommands(entries, query).map(match => [match.item, match]));
  for (const item of entries) {
    const alias = rankCommands((item.search ?? []).map(name => ({name, description: '', source: item.source})), query)[0];
    const visible = matches.get(item);
    if (alias && (!visible || alias.rank < visible.rank)) matches.set(item, {item, rank: alias.rank, marks: visible?.marks ?? []});
  }
  return [...matches.values()].sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
}
export type SelectionChange = Partial<Omit<Workspace, 'selectedTarget'>> & {selectedTarget?: Target | null};
export type ActionContext = {snapshot: () => Snapshot | undefined; primary: () => PrimaryView | undefined; composer: Composer; modal: Modal;
  selection: (change: SelectionChange) => Promise<void>; reload: () => Promise<void>; result: (result: OperationView) => void; rosterRefresh: () => void; find: (query: string) => void; recovery: () => void; primaryEntries: () => EntryView[]; agents: () => AgentRow[]; selectedAgent: () => Pick<AgentRow, 'identity' | 'capabilities'> | undefined; selectAgent: (row: AgentRow) => void; notices: () => void; sidebar: (visible: boolean) => void; view: (tools: boolean, expand: boolean) => void; copyAgent: () => void; inspectAgent: () => void};
export class Actions {
  private resources = new Map<string, Promise<ResourcePage>>();
  private commands: CommandView[] = [];
  private resourceTarget = '';
  private resourceVersion = 0;
  private commandsLoaded = false;
  private commandsIncomplete = false;
  private commandPaint?: () => void;
  private displayedHandoffs = new Set<string>();
  private ctx: ActionContext;
  constructor(ctx: ActionContext) { this.ctx = ctx; }
  private target(primary: PrimaryView): Target { return {kind: 'primary', key: primary.key, epoch: primary.epoch}; }
  private path(primary: PrimaryView, suffix: string): string { return `/api/primaries/${encodeURIComponent(primary.key)}/${suffix}`; }
  private observeResources(primary?: PrimaryView): boolean {
    const target = primary ? `${primary.key}:${primary.epoch}:${primary.lifecycle}` : '';
    if (this.resourceTarget === target) return false;
    this.resourceTarget = target; this.resourceVersion++; this.resources.clear(); this.commands = []; this.commandsLoaded = false; this.commandsIncomplete = false; this.commandsChanged(); return true;
  }
  private commandsChanged(): void { this.commandPaint?.(); this.ctx.composer.commandsChanged(); }
  commandOptions(): CommandInventory {
    const primary = this.ctx.primary();
    if (primary?.lifecycle !== 'ready') return {items: [], state: 'unavailable'};
    if (this.resourceTarget !== `${primary.key}:${primary.epoch}:${primary.lifecycle}` || !this.commandsLoaded) return {items: [], state: 'loading'};
    const items = new Map<string, CommandOption>(this.commands.map(item => [item.name, {...item}]));
    for (const item of appCommands) items.set(item.name, {...item});
    return {items: [...items.values()], state: 'ready', ...(this.commandsIncomplete ? {incomplete: true} : {})};
  }
  private currentResources(primary: PrimaryView, version: number): boolean {
    const current = this.ctx.primary();
    return this.resourceVersion === version && current?.lifecycle === 'ready' && current.key === primary.key && current.epoch === primary.epoch;
  }
  private resourcePage(primary: PrimaryView, kind: ResourceKind, cursor?: string): Promise<ResourcePage> {
    const key = `${primary.key}:${primary.epoch}:${kind}:page:${cursor ?? ''}`;
    let cache = this.resources.get(key);
    if (!cache) {
      cache = request<ResourcePage>(this.path(primary, `resources/${kind}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      this.resources.set(key, cache); const pending = cache;
      void cache.catch(() => { if (this.resources.get(key) === pending) this.resources.delete(key); });
    }
    return cache;
  }
  private async loadCommandInventory(primary: PrimaryView, version: number): Promise<ResourcePage> {
    const result = {items: [] as CommandView[], nextCursor: null as string | null, revision: ''};
    for (let pageIndex = 0; pageIndex < COMMAND_INVENTORY_PAGE_LIMIT; pageIndex++) {
      if (!this.currentResources(primary, version)) return {items: [], nextCursor: null, revision: ''};
      const page = await this.resourcePage(primary, 'commands', result.nextCursor ?? undefined);
      if (!this.currentResources(primary, version)) return {items: [], nextCursor: null, revision: ''};
      result.items = [...result.items, ...page.items as CommandView[]]; result.nextCursor = page.nextCursor; result.revision = page.revision;
      this.commands = result.items; this.commandPaint?.();
      if (!result.nextCursor) break;
    }
    return result;
  }
  async load(kind: ResourceKind): Promise<ResourcePage> {
    const primary = this.ctx.primary(); this.observeResources(primary);
    if (primary?.lifecycle !== 'ready') return {items: [], nextCursor: null, revision: ''};
    const version = this.resourceVersion; const key = `${primary.key}:${primary.epoch}:${kind}`;
    let cache = this.resources.get(key);
    if (!cache) {
      if (kind === 'commands' && this.commandsLoaded) { this.commandsLoaded = false; this.commandsChanged(); }
      cache = kind === 'commands' ? this.loadCommandInventory(primary, version) : this.resourcePage(primary, kind);
      this.resources.set(key, cache); const pending = cache;
      void cache.catch(() => { if (this.resources.get(key) === pending) this.resources.delete(key); });
    }
    try {
      const result = await cache;
      if (kind === 'commands' && this.resources.get(key) === cache && this.currentResources(primary, version)) {
        this.commands = result.items as CommandView[]; this.commandsLoaded = true; this.commandsIncomplete = !!result.nextCursor; this.commandsChanged();
      }
      return result;
    } catch (error) {
      if (kind === 'commands' && this.currentResources(primary, version)) { this.commandsLoaded = true; this.commandsIncomplete = true; this.commandsChanged(); }
      throw error;
    }
  }
  private async moreCommands(primary: PrimaryView | undefined, version: number, page: ResourcePage): Promise<void> {
    if (!primary || !page.nextCursor || !this.currentResources(primary, version)) return;
    const next = await this.resourcePage(primary, 'commands', page.nextCursor);
    if (!this.currentResources(primary, version)) return;
    this.commands = [...page.items as CommandView[], ...next.items as CommandView[]]; page.items = this.commands; page.nextCursor = next.nextCursor;
    this.commandsIncomplete = !!next.nextCursor; this.commandsChanged();
  }
  warm(): void {
    if (this.observeResources(this.ctx.primary())) void this.load('commands').catch(() => undefined);
  }
  async control(control: Omit<PrimaryControl, 'epoch'>, captured?: PrimaryView): Promise<void> {
    const primary = captured ?? this.ctx.primary(); if (!primary) return;
    const result = await operation('primary.control', this.path(primary, 'control'), {...control, epoch: primary.epoch}, this.target(primary)); this.ctx.result(result);
    if (result.error) throw new Error(result.error.message);
  }
  projectPicker(): void {
    const {modal} = this.ctx; const snapshot = this.ctx.snapshot(); const primary = this.ctx.primary();
    const body = modal.open('Open a project');
    const directory = input('Project directory', primary?.cwd ?? (snapshot as Bootstrap | undefined)?.launchCwd ?? '');
    const session = input('Saved session path (optional)'); body.append(directory.label, directory.field, session.label, session.field);
    const start = async (resume: boolean) => {
      const result = await operation('primary.open', '/api/primaries', {cwd: directory.field.value, ...(resume ? {sessionFile: session.field.value, writerReleased: true} : {})});
      const opened = result as unknown as {primaryKey?: string; operation?: OperationView};
      if (opened.operation?.error) throw new Error(opened.operation.error.message);
      if (!opened.primaryKey) throw new Error('Pi did not open the primary. Your project choice stays unchanged.');
      await this.ctx.reload();
    };
    const launch = (snapshot as Bootstrap | undefined)?.launchCwd;
    if (launch) body.append(button('Use launch directory', () => { directory.field.value = launch; }));
    modal.actions(button('Cancel', () => modal.close()), button('Resume saved session', () => { modal.confirm('Confirm saved session resume', `${session.field.value}\nConfirm that this exact file is not open in a terminal or another Pi writer. Pi exposes no external writer lock query.`, () => start(true), 'No other writer · Resume'); }), button('Start new session', () => { void modal.run(() => start(false)); }, 'main-action'));
    if (snapshot?.primaries.length) {
      body.append(element('h2', undefined, 'Open in this workspace'));
      for (const item of snapshot.primaries) body.append(button(`${item.sessionName ?? item.sessionId ?? 'Session'} · ${item.cwd} · ${item.lifecycle}`, () => { void modal.run(() => this.ctx.selection({primaryKey: item.key, selectedTarget: null})); }));
    }
    for (const index of snapshot?.primaryIndex ?? []) if (!snapshot?.primaries.some(item => item.key === index.key)) body.append(button(`Backend session ${index.key} · ${index.lifecycle}`, () => { void modal.run(() => this.ctx.selection({primaryKey: index.key, selectedTarget: null})); }));
    body.append(element('p', 'secondary', 'Enter an exact saved session path. Browsing this picker does not start Pi.'));
    directory.field.focus();
  }
  newSession(): void {
    const primary = this.ctx.primary(); if (!primary) return;
    this.ctx.modal.confirm('New session', 'Your current draft stays with this session. Pi changes the session only after its response.', async () => {
      const result = await operation('primary.session', this.path(primary, 'session'), {epoch: primary.epoch, action: 'new'}, this.target(primary)); this.ctx.result(result); await this.ctx.reload();
    }, 'Start new session');
  }
  fork(entryId: string, excerpt: string): void {
    const primary = this.ctx.primary(); if (!primary) return;
    this.ctx.modal.confirm('Fork from message', excerpt, async () => {
      const result = await operation('primary.session', this.path(primary, 'session'), {epoch: primary.epoch, action: 'fork', entryId}, this.target(primary)); this.ctx.result(result); await this.ctx.reload();
    }, 'Fork');
  }
  forkPicker(): void {
    const modal = this.ctx.modal; modal.open('Fork from a user message');
    const entries = this.ctx.primaryEntries().filter(entry => entry.kind === 'message' && !/^(message:|live:)/.test(entry.id));
    for (const entry of entries) for (const message of entry.messages ?? []) if (message.role === 'user' && message.state === 'final') {
      const excerpt = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'); modal.body.append(button(excerpt.slice(0, 200), () => this.fork(entry.id, excerpt)));
    }
    modal.body.append(element('p', 'secondary', 'Only loaded user messages appear here. Pi validates the selected fork point.'));
  }
  compact(): void {
    const primary = this.ctx.primary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open(`Compact · ${primary.sessionName ?? primary.sessionId ?? 'Primary'}`);
    const instructions = input('Optional instructions', '', true); modal.body.append(instructions.label, instructions.field);
    modal.actions(button('Cancel', () => modal.close()), button('Compact', () => { void modal.run(() => this.control({action: 'compact', customInstructions: instructions.field.value} as PrimaryControl, primary)); }, 'main-action'));
  }
  automaticSettings(action: 'autoRetry' | 'autoCompaction'): void {
    const primary = this.ctx.primary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open(action === 'autoRetry' ? 'Automatic retry' : 'Automatic compaction');
    modal.body.append(element('p', 'secondary', 'These actions set Pi’s behavior. No current setting is inferred.'));
    modal.actions(button('Enable', () => { void modal.run(() => this.control({action, enabled: true} as PrimaryControl, primary)); }), button('Disable', () => { void modal.run(() => this.control({action, enabled: false} as PrimaryControl, primary)); }));
    if (action === 'autoRetry' && primary.activity === 'retrying') modal.actions(button('Stop current retry', () => { void modal.run(() => this.control({action: 'abortRetry'} as PrimaryControl, primary)); }));
  }
  sessionDetails(): void {
    const primary = this.ctx.primary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open('Session details'); const token = modal.token;
    modal.body.append(element('p', 'identity', primary.sessionId ?? primary.key), button('Copy identity', () => { void copy(primary.sessionId ?? primary.key, modal.body); }), details('Reported session state', rawText(primary)));
    modal.body.append(button('Diagnostics', () => { void modal.run(async () => { const data = await request(this.path(primary, 'diagnostics')); if (modal.owns(token)) modal.body.append(details('Diagnostics', rawText(data))); }, false); }));
  }
  modelPicker(): void {
    const primary = this.ctx.primary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open('Choose model for Primary'); const token = modal.token; modal.body.append(element('p', 'secondary', 'Loading cached models'));
    void modal.run(async () => {
      const page = await this.load('models'); if (!modal.owns(token)) return;
      modal.body.replaceChildren(); const search = input('Search cached models'); const list = element('div', 'options'); modal.body.append(search.label, search.field, list);
      const paint = () => {
        list.replaceChildren();
        for (const model of page.items as ModelChoice[]) if (`${model.provider}/${model.id}`.toLocaleLowerCase().includes(search.field.value.toLocaleLowerCase())) {
          const label = `${primary.model?.provider === model.provider && primary.model.id === model.id ? '✓ ' : ''}${model.provider}/${model.id}`;
          const node = button(label, () => {
            node.disabled = true; node.textContent = 'Applying…';
            void modal.run(async () => { try { await this.control({action: 'model', provider: model.provider, modelId: model.id} as PrimaryControl, primary); this.resources.delete(`${primary.key}:${primary.epoch}:thinking`); } finally {node.disabled = false; node.textContent = label;} });
          }); list.append(node);
        }
      };
      search.field.addEventListener('input', paint); paint(); search.field.focus();
      if (page.nextCursor) {
        const more = button('More cached models', () => { more.disabled = true; void modal.run(async () => {
          try { const next = await request<ResourcePage>(this.path(primary, `resources/models?limit=100&cursor=${encodeURIComponent(page.nextCursor ?? '')}`)); page.items = [...page.items as ModelChoice[], ...next.items as ModelChoice[]]; page.nextCursor = next.nextCursor; more.hidden = !next.nextCursor; paint(); }
          finally { more.disabled = false; }
        }, false); }); modal.body.append(more);
      }
    }, false);
  }
  thinkingPicker(): void {
    const primary = this.ctx.primary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open('Thinking level for Primary'); const token = modal.token;
    void modal.run(async () => {
      const page = await this.load('thinking'); if (!modal.owns(token)) return;
      const list = element('div', 'options'); for (const level of page.items as string[]) list.append(button(level, () => { void modal.run(() => this.control({action: 'thinking', level} as PrimaryControl, primary)); })); modal.body.append(list);
    }, false);
  }
  paletteEntries(): PaletteEntry[] {
    const primary = this.ctx.primary(); const agent = this.ctx.selectedAgent();
    const entry = (name: string, description: string, run: () => void, enabled = true, alias?: string): PaletteEntry => ({name, description, source: 'app', enabled, run, ...(alias ? {search: [alias, `/${alias}`]} : {})});
    const entries = [
      entry('New session', 'Start a new primary session', () => this.newSession(), !!primary, 'new'),
      entry('Resume saved session', 'Open an exact saved session path', () => this.projectPicker(), true, 'resume'),
      entry('Fork from message…', 'Branch from a loaded user message', () => this.forkPicker(), !!primary, 'fork'),
      entry('Compact…', 'Summarize primary context', () => this.compact(), !!primary, 'compact'),
      entry('Automatic retry…', 'Enable or disable Pi retry', () => this.automaticSettings('autoRetry'), !!primary),
      entry('Automatic compaction…', 'Enable or disable Pi compaction', () => this.automaticSettings('autoCompaction'), !!primary),
      entry('Continue in terminal…', 'Release the browser writer', () => this.handoff(), !!primary),
      entry('Session details', 'Identity, state and diagnostics', () => this.sessionDetails(), !!primary),
      entry('Saved drafts and input copies', 'Review retained input', () => this.ctx.recovery()),
      entry('Appearance', 'Choose dark, light or system', () => this.appearance()),
      entry('Help', 'Browser controls and terminal fallback', () => this.help()),
      entry('Expand loaded tools', 'Expand loaded tool output', () => this.ctx.view(true, true), !!primary),
      entry('Collapse loaded tools', 'Collapse loaded tool output', () => this.ctx.view(true, false), !!primary),
      entry('Show thinking', 'Show loaded thinking text', () => this.ctx.view(false, true), !!primary),
      entry('Hide thinking', 'Hide loaded thinking text', () => this.ctx.view(false, false), !!primary),
      entry('Find in loaded messages', 'Find text in the primary transcript', () => this.find(), !!primary),
      entry('Notifications', 'Read and dismiss notices', () => this.ctx.notices()),
      entry('Refresh agent roster', 'Request a fresh agent scan', () => this.ctx.rosterRefresh()),
      entry('New agent through primary', 'Prepare /agent new in the primary', () => this.prepareText('/agent new')),
      entry('Hide sidebar', 'Hide the conversation sidebar', () => this.ctx.sidebar(false)),
      entry('Show sidebar', 'Show the conversation sidebar', () => this.ctx.sidebar(true)),
      entry('Open project or session', 'Choose a project or primary', () => this.projectPicker()),
      entry('Model', 'Choose the primary model', () => this.modelPicker(), primary?.lifecycle === 'ready', 'model'),
      entry('Thinking', 'Choose the primary thinking level', () => this.thinkingPicker(), primary?.lifecycle === 'ready', 'thinking'),
    ];
    if (primary?.lastError) entries.push(entry('Review retry prompt', 'Restore the last loaded user prompt for review', () => this.retryOutput()));
    if (agent) {
      entries.push(entry('Copy agent identity', agent.identity, () => this.ctx.copyAgent()));
      if (agent.capabilities?.inspect) entries.push(entry('Inspect agent activity', agent.identity, () => this.ctx.inspectAgent()));
    }
    if (primary?.lifecycle === 'ready' && this.resourceTarget === `${primary.key}:${primary.epoch}:${primary.lifecycle}`) {
      for (const command of this.commands) entries.push({...command, name: `/${command.name}`, enabled: true, run: () => this.prepareText(`/${command.name}`)});
    }
    const now = Date.now(); const agents = this.ctx.agents(); const tails = duplicateAgentTails(agents);
    for (const row of agents.slice().sort((a, b) => agentOrder(a) - agentOrder(b))) entries.push({name: agentName(row), tail: tails.get(row.identity), description: [row.availability === 'live' ? row.state : row.availability, compactAge(row.modifiedAt, now)].filter(Boolean).join(' · '), search: [row.identity, ...row.handle ? [row.handle] : []], title: row.identity, source: 'agent', enabled: true, run: () => this.ctx.selectAgent(row)});
    return entries;
  }
  palette(): void {
    const modal = this.ctx.modal; modal.open('Commands'); const token = modal.token;
    modal.node.dataset.variant = 'palette';
    const search = input('Search commands and agents'); search.label.className = 'sr-only';
    search.field.setAttribute('role', 'combobox'); search.field.setAttribute('aria-autocomplete', 'list'); search.field.setAttribute('aria-expanded', 'true'); search.field.setAttribute('aria-controls', 'palette-list');
    const prompt = element('span', 'palette-prompt', '›'); prompt.setAttribute('aria-hidden', 'true');
    const line = element('div', 'palette-input'); line.append(prompt, search.label, search.field);
    const list = element('div', 'palette-list'); list.id = 'palette-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Commands and agents'); modal.body.append(line, list);
    let active = 0; let matches: ReturnType<typeof rankCommands> = [];
    const run = (index: number) => {
      if (!modal.owns(token)) return;
      const selected = matches[index]?.item as PaletteEntry | undefined; if (!selected?.enabled) return;
      modal.close(); selected.run();
    };
    const select = () => {
      const rows = [...list.children] as HTMLElement[];
      rows.forEach((row, index) => { row.setAttribute('aria-selected', String(index === active)); });
      const selected = rows[active];
      if (selected) { search.field.setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView({block: 'nearest'}); }
      else search.field.removeAttribute('aria-activedescendant');
    };
    const paint = () => {
      const previous = matches[active]?.item as PaletteEntry | undefined; const entries = this.paletteEntries();
      matches = rankPalette(entries, search.field.value.trim());
      active = Math.max(0, matches.findIndex(match => match.item.name === previous?.name && match.item.source === previous?.source && (match.item as PaletteEntry).title === previous?.title)); list.replaceChildren();
      matches.forEach((match, index) => {
        const item = match.item as PaletteEntry; const row = button('', () => run(index), 'palette-row'); row.id = `palette-option-${index}`; row.tabIndex = -1;
        if (item.title) row.title = item.title;
        row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(!item.enabled)); row.disabled = !item.enabled;
        const name = element('span', 'palette-name');
        const marks = new Set(match.marks);
        for (let offset = 0; offset < item.name.length; offset++) name.append(element(marks.has(offset) ? 'mark' : 'span', undefined, item.name[offset]));
        if (item.tail) name.append(element('span', 'palette-tail', ` ${item.tail}`));
        row.append(name, element('span', 'palette-desc', item.description), element('span', 'palette-source', item.source.toLowerCase()));
        list.append(row);
      });
      select();
    };
    search.field.addEventListener('input', () => { active = 0; matches = []; paint(); });
    search.field.addEventListener('keydown', raw => {
      const event = raw as KeyboardEvent; if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); select(); }
      else if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) run(active); }
    });
    this.commandPaint = () => { if (modal.owns(token)) paint(); };
    paint(); search.field.focus(); void this.load('commands').then(page => {
      if (!modal.owns(token)) return;
      paint(); if (page.nextCursor) {
        const primary = this.ctx.primary(); const version = this.resourceVersion;
        const more = button('More discovered commands', () => { more.disabled = true; void modal.run(async () => {
          try { await this.moreCommands(primary, version, page); more.hidden = !page.nextCursor; }
          finally { more.disabled = false; }
        }, false); }); modal.body.append(more);
      }
    }).catch(error => { if (modal.owns(token)) modal.error(error); });
  }
  unknown(text: string, sendLiteral: () => void): boolean {
    const name = /^\/([^\s]+)/.exec(text)?.[1]; if (!name) return false;
    const builtin: Record<string, () => void> = {new: () => this.newSession(), resume: () => this.projectPicker(), fork: () => this.forkPicker(), compact: () => this.compact(), model: () => this.modelPicker(), thinking: () => this.thinkingPicker()};
    if (builtin[name]) { builtin[name](); return true; }
    if (['agent', 'stash'].includes(name) && !text.includes(' ')) { this.terminalOnly(name); return true; }
    if (this.commands.some(command => command.name === name)) return false;
    const modal = this.ctx.modal; modal.open('Unknown slash command'); modal.body.append(element('p', undefined, `/${name} is not a discovered command. Your draft stays unchanged.`));
    modal.actions(button('Correct draft', () => modal.close()), button('Send literal text', () => { modal.close(); sendLiteral(); })); return true;
  }
  prepareText(text: string): void {
    const composer = this.ctx.composer;
    if (!composer.target || this.ctx.primary()?.lifecycle !== 'ready') {
      this.projectPicker(); this.ctx.modal.body.append(element('p', 'secondary', 'Open a primary, then use this text action. Your agent draft stays unchanged.'), element('pre', undefined, text)); return;
    }
    const target = {...composer.target}; const previousText = composer.editor.value;
    const apply = async () => {
      await this.ctx.selection({selectedTarget: target});
      if (JSON.stringify(composer.target) !== JSON.stringify(target) || this.ctx.primary()?.lifecycle !== 'ready' || composer.editor.value !== previousText) return;
      composer.setText(text); composer.editor.focus();
    };
    if (!composer.editor.value) { void this.ctx.modal.run(apply, false); return; }
    this.ctx.modal.confirm('Use primary text action', 'Your current primary draft will be replaced. Copy it first if you need both texts.', apply, 'Replace draft');
    this.ctx.modal.body.append(element('pre', undefined, composer.editor.value), button('Copy draft', () => { void copy(composer.editor.value, this.ctx.modal.body); }));
  }
  private terminalOnly(name: string): void {
    const modal = this.ctx.modal; modal.open('Terminal-only panel'); modal.body.append(element('p', undefined, `The bare /${name} panel requires the terminal. Text actions remain available through the primary.`));
    modal.actions(button('Cancel', () => modal.close()), button('Continue in terminal…', () => this.handoff()));
    if (name === 'agent') modal.body.append(button('New agent through primary…', () => { modal.close(); this.prepareText('/agent new'); }));
  }
  appearance(): void {
    const modal = this.ctx.modal; modal.open('Appearance'); const rows = element('div', 'options');
    for (const appearance of ['dark', 'light', 'system'] as const) rows.append(button(appearance[0]?.toUpperCase() + appearance.slice(1), () => { void modal.run(() => this.ctx.selection({appearance})); })); modal.body.append(rows);
  }
  find(): void {
    const modal = this.ctx.modal; modal.open('Find in loaded messages'); const query = input('Text'); modal.body.append(query.label, query.field);
    modal.actions(button('Find', () => { this.ctx.find(query.field.value); modal.close(); }));
  }
  help(): void {
    const modal = this.ctx.modal; modal.open('Help');
    modal.body.append(element('p', undefined, 'Local browser access only. Pi owns primary work. Durable hosts own agent work. Closing this tab does not stop either.'), element('p', undefined, 'Agent configure is unavailable in this browser. Use the existing primary text command.'), element('p', undefined, 'Enter sends; Shift+Enter inserts a newline. Cmd+K opens Commands. Escape closes a dialog and never stops work.'), element('p', undefined, 'Browser drafts stay in memory until the Mac confirms a save. A browser crash cannot restore text that the Mac did not receive.'));
  }
  retryOutput(): void {
    const items = this.ctx.primaryEntries();
    const user = items.flatMap(entry => entry.messages ?? []).findLast(message => message.role === 'user');
    const text = user?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    if (!text) { this.ctx.modal.open('Retry output').append(element('p', undefined, 'No loaded user prompt is available. Enter an explicit new prompt in the primary.')); return; }
    this.ctx.modal.confirm('Review retry prompt', 'A new send repeats this prompt and its possible tool effects. This action only restores text for your review.', async () => this.prepareText(text), 'Restore prompt');
  }
  handoff(): void {
    const primary = this.ctx.primary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open('Continue in terminal');
    modal.body.append(element('p', 'identity', primary.sessionFile ?? 'No saved session yet'), element('p', undefined, 'This releases the browser’s Pi writer before terminal resume. Other Durable agents continue.'));
    const release = async (mode: 'settle' | 'abort') => {
      const result = await operation('primary.handoff', this.path(primary, 'handoff'), {epoch: primary.epoch, mode, clearQueue: mode === 'abort'}, this.target(primary));
      this.ctx.result(result);
    };
    modal.actions(button('Cancel', () => modal.close()), button(primary.activity === 'idle' ? 'Release for terminal' : 'Wait for this work', () => { void modal.run(() => release('settle'), false); }));
    if (primary.activity !== 'idle') modal.actions(button('Stop work and hand off…', () => modal.confirm('Stop work and hand off', 'Pi clears queued input and aborts current work. The backend retains cleared text copies.', () => release('abort'), 'Stop and release')));
  }
  handoffResult(result: OperationView): void {
    if (result.kind !== 'primary.handoff' || result.state !== 'completed' || result.receipt?.kind !== 'rpc') return;
    const data = result.receipt.result?.value as HandoffView | undefined; if (!data?.command || this.displayedHandoffs.has(result.id)) return;
    this.displayedHandoffs.add(result.id); if (this.displayedHandoffs.size > 64) this.displayedHandoffs.delete(this.displayedHandoffs.values().next().value as string);
    const modal = this.ctx.modal; modal.open('Ready for terminal');
    modal.body.append(element('pre', undefined, data.command), button('Copy command', () => { void copy(data.command, modal.body); }), element('p', undefined, 'Browser control is stopped. Other Durable agents continue.'), element('p', 'warning', 'Exit the terminal writer before explicit browser resume. This Pi version exposes no external writer lock query.'), button('Resume saved session…', () => this.projectPicker()));
  }
}
