import {cardAction, cardIcon} from './card-icons.ts';
import { ProjectPicker } from './picker.ts';
import { savedPathValid } from './picker-state.ts';
import { renderFacts, type ReportedFact } from './facts.ts';
import { resolveAppearance } from '../shared/api.ts';
import type { AgentRow, Appearance, CommandView, ConversationLayout, EntryView, HandoffView, ModelChoice, OperationView, PrimaryControl, PrimaryView, ResourcePage, Snapshot, Target, Workspace, WorkspacePage, WorkspaceSummary } from '../shared/api.ts';
import { button, copy, details, element, input, rawText } from './dom.ts';
import type { Modal } from './modal.ts';
import type { FindSession, FindStatus } from './render.ts';
import { ApiError, operation, request, reserve } from './transport.ts';
import type { Composer } from './composer.ts';
import { rankCommands } from './command-menu-state.ts';
import { DECORATION_BYTES, DECORATION_LINES, DECORATION_SPANS } from './composer-syntax.ts';
import { ConversationCaptions, type ConversationCaption } from './tabs.ts';
import { absoluteTime, compactAge, relativeTime } from './format.ts';
import { navigateOptions } from './list-navigation.ts';
import { responseOutcome } from './conversation-presentation.ts';
import type { CommandInventory, CommandOption, CommandMatch } from './command-menu-state.ts';
export const COMMAND_INVENTORY_PAGE_LIMIT = 8;
/** Pages of the Primary model list read for display names; a model beyond them shows its id. */
export const MODEL_NAME_PAGE_LIMIT = 10;
const appearanceChoices: readonly [Appearance, string][] = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];
/** The server links the user stylesheet into the page only when the file is usable, so the link is the applied state. */
export function userStylesheetApplied(): boolean {
  return typeof document !== 'undefined' && document.querySelector?.('link[data-user-stylesheet]') != null;
}
type ResourceKind = 'commands' | 'models' | 'thinking';
const appCommands: CommandOption[] = [
  {name: 'new', description: 'Start a new session', source: 'app'},
  {name: 'resume', description: 'Resume a saved session', source: 'app'},
  {name: 'fork', description: 'Start a branch from a user message', source: 'app'},
  {name: 'compact', description: 'Summarize the session context', source: 'app'},
  {name: 'model', description: 'Choose Primary model', source: 'app'},
  {name: 'thinking', description: 'Choose the thinking level for Primary', source: 'app'},
];

export type PaletteEntry = CommandOption & {shortcut?: {text: string; keys: string}; enabled: boolean; run: () => void; search?: string[]; title?: string; tail?: string; checked?: boolean; priority?: number; disabledReason?: string};
function choice(label: string, selected: boolean, run: () => void): HTMLButtonElement {
  const node = button('', run, 'option-choice');
  const check = cardIcon('success'); check.classList.add('choice-check'); check.style.visibility = selected ? 'visible' : 'hidden';
  node.append(check, element('span', 'choice-value', label));
  node.setAttribute('role', 'menuitemradio'); node.setAttribute('aria-checked', String(selected)); node.setAttribute('aria-label', label); return node;
}
function commandSource(source: string): string { return ({app: 'App', primary: 'Primary', agent: 'Agent'} as Record<string, string>)[source] ?? source; }
function paletteName(item: PaletteEntry, marks: number[], conversation: boolean): HTMLElement {
  const name = element('span', 'palette-name');
  const title = conversation ? element('span', 'palette-title') : name; if (conversation) name.append(title);
  const selected = new Set(marks);
  for (let offset = 0; offset < item.name.length; offset++) title.append(element(selected.has(offset) ? 'mark' : 'span', undefined, item.name[offset]));
  if (item.tail) name.append(element('span', conversation ? 'palette-identity' : 'palette-tail', ` ${item.tail}`));
  return name;
}
function paletteDescription(row: HTMLElement, item: PaletteEntry): string {
  const reason = item.enabled ? undefined : item.disabledReason;
  row.title = reason ?? item.title ?? '';
  if (reason) row.setAttribute('aria-description', reason);
  row.setAttribute('aria-label', [item.name, item.tail, item.description, reason].filter(Boolean).join(', '));
  return reason ?? item.description;
}
function paletteRow(item: PaletteEntry, marks: number[], conversation: boolean, run: () => void): HTMLButtonElement {
  const row = button('', run, 'palette-row'); row.tabIndex = -1; row.dataset.source = item.source;
  row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(!item.enabled)); row.disabled = !item.enabled;
  if (conversation) row.dataset.kind = 'conversation';
  row.append(paletteName(item, marks, conversation), element('span', 'palette-desc', paletteDescription(row, item)));
  if (item.source !== 'app') row.append(element('span', 'palette-source', commandSource(item.source)));
  if (item.shortcut) { row.append(element('kbd', 'palette-shortcut', item.shortcut.text)); row.setAttribute('aria-keyshortcuts', item.shortcut.keys); }
  if (item.checked !== undefined) {
    row.setAttribute('aria-checked', String(item.checked));
    const check = cardIcon('success'); check.classList.add('palette-check'); check.style.visibility = item.checked ? 'visible' : 'hidden'; row.append(check);
  }
  return row;
}
function rosterIncomplete(snapshot?: Snapshot): boolean {
  const roster = snapshot?.roster;
  return !!roster?.nextCursor || !!roster && (!roster.scan.complete || roster.scan.omitted > 0) || !!snapshot?.omitted?.includes('roster');
}
function paletteEmpty(query: string, incomplete: boolean): HTMLElement {
  const message = element('p', 'secondary', `No results${query.trim() ? ` for “${query.trim()}”` : ''}.${incomplete ? ' The list is incomplete.' : ''}`);
  message.setAttribute('role', 'status'); return message;
}
function revealPaletteRow(container: HTMLElement, row: HTMLElement): void {
  if (container.clientHeight <= 0 || container.scrollHeight <= container.clientHeight) return;
  const top = container.getBoundingClientRect().top + container.clientTop;
  const box = row.getBoundingClientRect(); const bottom = top + container.clientHeight;
  const delta = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
  const next = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + delta));
  if (next !== container.scrollTop) container.scrollTop = next;
}
function palettePriority(item: PaletteEntry): number { return item.enabled ? item.priority ?? 2 : 3; }
function agentOrder(row: AgentRow): number { return row.availability === 'live' || row.state === 'working' ? 0 : 1; }
export function rankPalette(entries: PaletteEntry[], query: string): CommandMatch[] {
  if (!query.trim()) return entries.map(item => ({item, rank: 1, marks: []})).sort((a, b) => palettePriority(a.item) - palettePriority(b.item));
  const matches = new Map<CommandOption, CommandMatch>(rankCommands(entries, query).map(match => [match.item, match]));
  for (const item of entries) {
    const alias = rankCommands((item.search ?? []).map(name => ({name, description: '', source: item.source})), query)[0];
    const visible = matches.get(item);
    if (alias && (!visible || alias.rank < visible.rank)) matches.set(item, {item, rank: alias.rank, marks: visible?.marks ?? []});
  }
  return [...matches.values()].sort((a, b) => a.rank - b.rank || palettePriority(a.item as PaletteEntry) - palettePriority(b.item as PaletteEntry) || a.item.name.localeCompare(b.item.name));
}
function findStatusText(result: FindStatus | undefined, query: string): string {
  if (!result || result.end === 'unavailable') return 'Captured conversation is unavailable.';
  if (!query.trim()) return 'Enter text to find.';
  if (!result.total) return 'No loaded matches.';
  const boundary = result.end === 'first' ? ' First loaded match.' : result.end === 'last' ? ' Last loaded match.' : '';
  return `Match ${result.position} of ${result.total} in loaded messages.${boundary}`;
}
export type SettingsSelection = {target: Target; model?: {provider: string; modelId: string}; thinking?: string; levels?: string[]; primary?: PrimaryView; closed?: () => void; guard: () => string | undefined};
export type SelectionChange = Partial<Omit<Workspace, 'selectedTarget'>> & {selectedTarget?: Target | null};
export type ActionContext = {handover?: () => void; agentPresentation: ConstructorParameters<typeof ProjectPicker>[0]['agentPresentation']; snapshot: () => Snapshot | undefined; primary: () => PrimaryView | undefined; /** The Primary whose model list names models: the selected Primary when it is ready, else any ready Primary. */ namingPrimary?: () => PrimaryView | undefined; composer: Composer; commandsChanged: () => void; modelChanged?: () => void; modelNamesChanged?: () => void; modal: Modal;
  selection: (change: SelectionChange) => Promise<void>; reload: () => Promise<void>; result: (result: OperationView) => void; rosterRefresh: () => void; filesRefresh: () => void; hasTranscript: () => boolean; find: () => FindSession | undefined; recovery: () => void; primaryEntries: () => EntryView[]; agents: () => AgentRow[]; selectedAgent: () => Pick<AgentRow, 'identity' | 'capabilities'> | undefined; selectAgent: (row: AgentRow) => void; selectPrimary: () => void; notices: () => void; sidebar: (visible: boolean) => void; sidebarShown: () => boolean; view: (tools: boolean, expand: boolean) => void; copyAgent: () => void; inspectAgent: () => void; resultLookup?: () => void; agentCaption?: (identity: string) => ConversationCaption; agentStatus: (row: AgentRow) => string; conversationFacts?: (identity: string) => readonly ReportedFact[]; tabs?: {close: () => void; switch: (direction: number) => void; layout: () => ConversationLayout}};
export class Actions {
  private captions = new ConversationCaptions();
  private resources = new Map<string, Promise<ResourcePage>>();
  private commands: CommandView[] = [];
  private resourceTarget = '';
  private resourceVersion = 0;
  private commandsLoaded = false;
  private commandsIncomplete = false;
  private commandPaint?: () => void;
  private displayedHandoffs = new Set<string>();
  private picker?: ProjectPicker;
  private changingSession = false;
  private modelChanges = new Map<string, Set<{operationId?: string}>>();
  private modelNames = new Map<string, Map<string, string>>();
  private modelChoices = new Map<string, ModelChoice>();
  private modelCatalogs = new Set<string>();
  private namedPrimaries = new Set<string>();
  private ctx: ActionContext;
  constructor(ctx: ActionContext) { this.ctx = ctx; }
  private target(primary: PrimaryView): Target { return {kind: 'primary', key: primary.key, epoch: primary.epoch}; }
  private path(primary: PrimaryView, suffix: string): string { return `/api/primaries/${encodeURIComponent(primary.key)}/${suffix}`; }
  /** The display name for a reported provider and id: the exact provider match first, otherwise the one name every provider gives that id; undefined when the names differ or none is known. */
  modelName(provider: string, id: string): string | undefined {
    const byProvider = this.modelNames.get(id); if (!byProvider) return undefined;
    const exact = byProvider.get(provider); if (exact !== undefined) return exact;
    const names = new Set(byProvider.values());
    return names.size === 1 ? [...names][0] : undefined;
  }
  private learnModels(items: readonly ModelChoice[], keepExisting = false): void {
    let changed = false;
    for (const model of items) {
      this.modelChoices.set(`${model.provider}/${model.id}`, model);
      if (typeof model.name !== 'string' || !model.name.trim()) continue;
      const byProvider = this.modelNames.get(model.id) ?? new Map<string, string>(); this.modelNames.set(model.id, byProvider);
      const known = byProvider.get(model.provider);
      if (known === model.name || keepExisting && known !== undefined) continue;
      byProvider.set(model.provider, model.name); changed = true;
    }
    if (changed) this.ctx.modelNamesChanged?.();
  }
  /** Learns the ready Primary's own model on every call, then reads its model list once for each Primary session, page by page up to the page bound, so conversation settings can show readable names. */
  readModelNames(): void {
    const primary = (this.ctx.namingPrimary ?? this.ctx.primary)(); if (primary?.lifecycle !== 'ready') return;
    if (primary.model) this.learnModels([primary.model], true);
    const key = `${primary.key}:${primary.epoch}`; if (this.namedPrimaries.has(key)) return;
    this.namedPrimaries.add(key);
    void this.walkModelNames(primary);
  }
  private async walkModelNames(primary: PrimaryView): Promise<void> {
    let cursor: string | undefined;
    for (let index = 0; index < MODEL_NAME_PAGE_LIMIT; index++) {
      const page = await this.resourcePage(primary, 'models', cursor).catch(() => undefined); if (!page) return;
      if(page.items.length){this.modelCatalogs.add(`${primary.key}:${primary.epoch}`);this.ctx.modelNamesChanged?.();}
      this.learnModels(page.items as ModelChoice[]);
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }
  modelChoice(provider: string, id: string): ModelChoice | undefined { return this.modelChoices.get(`${provider}/${id}`); }
  hasModelCatalog(): boolean { const primary=(this.ctx.namingPrimary??this.ctx.primary)();return primary?.lifecycle==='ready'&&this.modelCatalogs.has(`${primary.key}:${primary.epoch}`); }
  private observeResources(primary?: PrimaryView): boolean {
    const target = primary ? `${primary.key}:${primary.epoch}:${primary.lifecycle}` : '';
    if (this.resourceTarget === target) return false;
    this.resourceTarget = target; this.resourceVersion++; this.resources.clear(); this.commands = []; this.commandsLoaded = false; this.commandsIncomplete = false; this.commandsChanged(); return true;
  }
  private commandsChanged(): void { this.commandPaint?.(); this.ctx.commandsChanged(); }
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
  async continueCommands(target: Target): Promise<void> {
    const primary = this.ctx.primary();
    if (target.kind !== 'primary' || primary?.lifecycle !== 'ready' || primary.key !== target.key || primary.epoch !== target.epoch) throw new Error('This conversation changed. Choose the action again.');
    this.observeResources(primary); const version = this.resourceVersion;
    const page = await this.load('commands');
    if (!this.currentResources(primary, version)) throw new Error('This conversation changed. Choose the action again.');
    await this.moreCommands(primary, version, page);
    if (!this.currentResources(primary, version)) throw new Error('This conversation changed. Choose the action again.');
  }
  private async moreCommands(primary: PrimaryView | undefined, version: number, page: ResourcePage): Promise<void> {
    if (!primary || !page.nextCursor || !this.currentResources(primary, version)) return;
    const cursor = page.nextCursor; const next = await this.resourcePage(primary, 'commands', cursor);
    if (!this.currentResources(primary, version) || page.nextCursor !== cursor) return;
    this.commands = [...page.items as CommandView[], ...next.items as CommandView[]]; page.items = this.commands; page.nextCursor = next.nextCursor;
    this.commandsIncomplete = !!next.nextCursor; this.commandsChanged();
  }
  warm(): void {
    if (this.observeResources(this.ctx.primary())) void this.load('commands').catch(() => undefined);
  }
  modelChanging(target: Target, operations: Iterable<OperationView> = []): boolean {
    const key = JSON.stringify(target), changes = this.modelChanges.get(key); if (!changes) return false;
    for (const operation of operations) {
      if (JSON.stringify(operation.target) !== key || !['accepted', 'completed', 'rejected'].includes(operation.state)) continue;
      for (const change of changes) if (change.operationId === operation.id) changes.delete(change);
    }
    if (!changes.size) this.modelChanges.delete(key);
    return changes.size > 0;
  }
  private async performControl(primary: PrimaryView, control: Omit<PrimaryControl, 'epoch'>, operationId?: string): Promise<OperationView> {
    const result = await operation('primary.control', this.path(primary, 'control'), {...control, epoch: primary.epoch}, this.target(primary), operationId);
    this.ctx.result(result); return result;
  }
  private readyPrimary(primary = this.ctx.primary(), capability = 'control'): PrimaryView | undefined {
    const current = primary && this.ctx.snapshot()?.primaries.find(item => item.key === primary.key && item.epoch === primary.epoch);
    return current?.lifecycle === 'ready' && current.capabilities[capability] === true ? current : undefined;
  }
  async control(control: Omit<PrimaryControl, 'epoch'>, captured?: PrimaryView): Promise<void> {
    const primary = this.readyPrimary(captured ?? this.ctx.primary());
    if (!primary) throw new Error('Resume Primary from Sessions before this action.');
    const result = control.action === 'model' || control.action === 'thinking' ? await this.modelControl(primary, control) : await this.performControl(primary, control);
    if (result.error) throw new Error(result.error.message);
  }
  private async modelControl(primary: PrimaryView, control: Omit<PrimaryControl, 'epoch'>): Promise<OperationView> {
    const target = this.target(primary), key = JSON.stringify(target), changes = this.modelChanges.get(key) ?? new Set<{operationId?: string}>();
    const change: {operationId?: string} = {}; changes.add(change); this.modelChanges.set(key, changes); this.ctx.modelChanged?.();
    let settled = false;
    try {
      change.operationId = await reserve('primary.control', target);
      const result = await this.performControl(primary, control, change.operationId);
      settled = ['accepted', 'completed', 'rejected'].includes(result.state); return result;
    } catch (error) {
      settled = !change.operationId || error instanceof ApiError && !['delivery_uncertain', 'internal'].includes(error.view.code);
      throw error;
    } finally {
      if (settled) changes.delete(change);
      if (!changes.size) this.modelChanges.delete(key);
      this.ctx.modelChanged?.();
    }
  }
  private sessionPicker(): ProjectPicker { this.picker ??= new ProjectPicker(this.ctx); return this.picker; }
  projectPicker(): void { this.sessionPicker().open(); }
  openProject(): void { this.sessionPicker().openProject(); }
  newSession(project?: string): void {
    const primary = this.ctx.primary(); if (!primary) { this.sessionPicker().newSession(project); return; }
    if (this.changingSession) return;
    this.changingSession = true;
    void this.replaceSession(primary).catch(cause => {
      this.ctx.modal.open('The session did not open.').append(details('Details', cause instanceof Error ? cause.message : String(cause)));
    }).finally(() => { this.changingSession = false; });
  }
  private async replaceSession(primary: PrimaryView): Promise<void> {
    const result = await operation('primary.session', this.path(primary, 'session'), {epoch: primary.epoch, action: 'new'}, this.target(primary));
    this.ctx.result(result); if (result.error) throw new Error(result.error.message); await this.ctx.reload();
  }
  fork(entryId: string, excerpt: string): void {
    const primary = this.readyPrimary(); if (!primary) return;
    this.ctx.modal.confirm('Fork from message', excerpt, async () => {
      if (!this.readyPrimary(primary)) throw new Error('Resume Primary from Sessions before this action.');
      const result = await operation('primary.session', this.path(primary, 'session'), {epoch: primary.epoch, action: 'fork', entryId}, this.target(primary)); this.ctx.result(result); await this.ctx.reload();
    }, 'Fork');
  }
  forkPicker(): void {
    if (!this.readyPrimary()) return;
    const modal = this.ctx.modal; modal.open('Fork from a user message');
    const entries = this.ctx.primaryEntries().filter(entry => entry.kind === 'message' && !/^(message:|live:)/.test(entry.id));
    const list = element('div', 'options message-choices');
    for (const entry of entries) for (const message of entry.messages ?? []) if (message.role === 'user' && message.state === 'final') {
      const excerpt = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'); list.append(button(excerpt.slice(0, 200), () => this.fork(entry.id, excerpt), 'message-choice'));
    }
    list.addEventListener('keydown', event => navigateOptions(event, list)); modal.body.append(list);
    modal.body.append(element('p', 'secondary', 'Only loaded messages appear here.'));
  }
  compact(): void {
    const primary = this.readyPrimary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open(`Compact · ${primary.sessionName ?? primary.sessionId ?? 'Primary'}`);
    const instructions = input('Optional instructions', '', true); modal.body.append(instructions.label, instructions.field);
    modal.actions(button('Cancel', () => modal.close()), button('Compact', () => { void modal.run(() => this.control({action: 'compact', customInstructions: instructions.field.value} as PrimaryControl, primary)); }, 'main-action'));
  }
  automaticSettings(action: 'autoRetry' | 'autoCompaction'): void {
    const primary = this.readyPrimary(); if (!primary) return;
    const modal = this.ctx.modal; modal.open(action === 'autoRetry' ? 'Automatic retry' : 'Automatic compaction');
    modal.body.append(element('p', 'secondary', 'The current setting is not reported.'));
    modal.actions(button('Enable', () => { void modal.run(() => this.control({action, enabled: true} as PrimaryControl, primary)); }), button('Disable', () => { void modal.run(() => this.control({action, enabled: false} as PrimaryControl, primary)); }));
    if (action === 'autoRetry' && primary.activity === 'retrying') modal.actions(button('Stop current retry', () => { void modal.run(() => this.control({action: 'abortRetry'} as PrimaryControl, primary)); }));
  }
  sessionDetails(primary = this.ctx.primary()): void {
    if (!primary) return;
    const modal = this.ctx.modal; modal.open('Conversation details'); const token = modal.token;
    modal.body.append(element('p', 'identity', primary.sessionId ?? primary.key), cardAction('copy', 'Copy session ID', () => { void copy(primary.sessionId ?? primary.key, modal.body); }), details('Reported session state', rawText(primary)));
    modal.body.append(button('Diagnostics', () => { void modal.run(async () => { const data = await request(this.path(primary, 'diagnostics')); if (modal.owns(token)) modal.body.append(details('Diagnostics', rawText(data))); }, false); }));
  }
  conversationDetails(identity?: string): void {
    const captured = identity ?? this.ctx.selectedAgent()?.identity;
    if (!captured) { this.sessionDetails(); return; }
    const row = this.ctx.agents().find(item => item.identity === captured);
    const body = this.ctx.modal.open('Conversation details');
    body.append(element('p', 'identity', captured), cardAction('copy', 'Copy agent ID', () => { void copy(captured, body); }));
    const child = /:([1-9]\d*)$/.exec(captured)?.[1];
    body.append(element('p', 'secondary', child ? `Conversation ${child}` : 'Main conversation'));
    if (row) {
      this.captions.update(this.ctx.agents());
      if ((this.ctx.agentCaption?.(captured) ?? this.captions.get(captured)).source === 'first-message') body.append(element('p', 'secondary', 'The conversation title is an excerpt from its first message.'));
      body.append(details('Reported agent metadata', rawText(row)));
    }
    const facts = element('div', 'conversation-facts'); renderFacts(facts, this.ctx.conversationFacts?.(captured) ?? []); body.append(facts);
  }
  async configure(selection: SettingsSelection, patch: {model?: {provider: string; modelId: string}; thinkingLevel?: string}): Promise<void> {
    const reason=selection.guard(); if(reason)throw new Error(reason);
    const target=selection.target;
    if(target.kind==='primary') {
      if(!selection.primary)throw new Error('This Primary is unavailable.');
      await this.control((patch.model?{action:'model',provider:patch.model.provider,modelId:patch.model.modelId}:{action:'thinking',level:patch.thinkingLevel ?? ''}) as PrimaryControl,selection.primary);return;
    }
    const key=JSON.stringify(target),changes=this.modelChanges.get(key)??new Set<{operationId?:string}>(),change:{operationId?:string}={};
    changes.add(change);this.modelChanges.set(key,changes);this.ctx.modelChanged?.();
    try {
      change.operationId=await reserve('agent.configure',target);
      const current=selection.guard();if(current)throw new Error(current);
      const result=await operation('agent.configure',`/api/agents/${encodeURIComponent(target.identity)}/configure`,patch,target,change.operationId);
      this.ctx.result(result);
      if(result.error)throw new Error(result.error.message);
      if(result.state!=='completed')throw new Error('Settings update was not confirmed. Check the agent before another change.');
    } finally {changes.delete(change);if(!changes.size)this.modelChanges.delete(key);this.ctx.modelChanged?.();}
  }
  modelPicker(selection?: SettingsSelection): void {
    const primary = selection?.primary ?? (selection ? (this.ctx.namingPrimary ?? this.ctx.primary)() : this.ctx.primary()); if (!primary) return;
    const selected=selection?.model ?? (primary.model?{provider:primary.model.provider,modelId:primary.model.id}:undefined);
    const modal = this.ctx.modal; modal.open(selection?.target.kind==='agent'?'Choose model for agent':'Choose model for Primary',undefined,selection?.closed); const token = modal.token; modal.body.append(element('p', 'secondary', 'Loading models…'));
    void modal.run(async () => {
      const page = await this.resourcePage(primary,'models'); this.learnModels(page.items as ModelChoice[]); if (!modal.owns(token)) return;
      modal.body.replaceChildren(); const search = input('Search models'); const list = element('div', 'options'); list.setAttribute('role', 'menu'); list.setAttribute('aria-label', 'Models'); modal.body.append(search.label, search.field, list);
      const paint = () => {
        list.replaceChildren();
        for (const model of page.items as ModelChoice[]) if (`${model.name} ${model.provider}/${model.id}`.toLocaleLowerCase().includes(search.field.value.toLocaleLowerCase())) {
          const label = `${model.name} · ${model.provider}/${model.id}`;
          const node = choice(label, selected?.provider === model.provider && selected.modelId === model.id, () => {
            node.disabled = true; node.setAttribute('aria-busy', 'true');
            void modal.run(async () => { try { if(selection)await this.configure(selection,{model:{provider:model.provider,modelId:model.id}});else await this.control({action: 'model', provider: model.provider, modelId: model.id} as PrimaryControl, primary); this.resources.delete(`${primary.key}:${primary.epoch}:thinking`);this.resources.delete(`${primary.key}:${primary.epoch}:thinking:page:`); } finally {node.disabled = false; node.removeAttribute('aria-busy');} });
          }); list.append(node);
        }
      };
      list.addEventListener('keydown', event => navigateOptions(event, list));
      search.field.addEventListener('input', paint); paint(); search.field.focus();
      if (page.nextCursor) {
        const more = button('More models', () => { more.disabled = true; void modal.run(async () => {
          try { const next = await request<ResourcePage>(this.path(primary, `resources/models?limit=100&cursor=${encodeURIComponent(page.nextCursor ?? '')}`)); page.items = [...page.items as ModelChoice[], ...next.items as ModelChoice[]]; page.nextCursor = next.nextCursor; more.hidden = !next.nextCursor; this.learnModels(next.items as ModelChoice[]); paint(); }
          finally { more.disabled = false; }
        }, false, 'Models could not be loaded.'); }); modal.body.append(more);
      }
    }, false, 'Models could not be loaded.');
  }
  thinkingPicker(selection?: SettingsSelection): void {
    const primary = selection?.primary ?? this.ctx.primary(); if (!selection && !primary) return;
    const modal = this.ctx.modal; modal.open(selection?.target.kind==='agent'?'Thinking level for agent':'Thinking level for Primary',undefined,selection?.closed); const token = modal.token;
    void modal.run(async () => {
      const page = selection?.target.kind==='agent'?{items:selection.levels ?? []}:await this.resourcePage(primary as PrimaryView,'thinking'); if (!modal.owns(token)) return;
      const list = element('div', 'options'); list.setAttribute('role', 'menu'); list.setAttribute('aria-label', 'Thinking levels');
      for (const level of page.items as string[]) list.append(choice(level, (selection?.thinking ?? primary?.thinkingLevel) === level, () => { void modal.run(() => selection?this.configure(selection,{thinkingLevel:level}):this.control({action: 'thinking', level} as PrimaryControl, primary)); }));
      list.addEventListener('keydown', event => navigateOptions(event, list)); modal.body.append(list); list.querySelector<HTMLButtonElement>('button')?.focus();
    }, false, 'Thinking levels could not be loaded.');
  }
  messageInput(): void {
    if (!this.ctx.snapshot()?.workspace) return;
    const modal = this.ctx.modal; modal.open('Message input'); const token = modal.token;
    const label = element('label', 'message-input-setting'), field = element('input'), progress=element('span','secondary','Saving preference'); field.type = 'checkbox'; field.checked = this.ctx.snapshot()?.workspace.enterSendsMessages === true;progress.hidden=true;
    label.append(field, element('span', undefined, 'Enter sends messages'), progress);
    this.preferencePaint=()=>{if(!modal.owns(token)){this.preferencePaint=undefined;return;}if(!field.disabled)field.checked=this.ctx.snapshot()?.workspace.enterSendsMessages === true;};
    modal.body.append(element('p', 'secondary', 'Applies to this workspace.'), label, element('p', 'secondary', 'When off, Enter adds a new line. When on, Enter sends. Shift+Enter adds a new line. Ctrl+Enter or Command+Enter sends.'));
    field.addEventListener('change', () => {
      if (!modal.owns(token) || field.disabled || !this.ctx.snapshot()?.workspace) return;
      const previous = this.ctx.snapshot()?.workspace.enterSendsMessages === true; field.disabled = true;progress.hidden=false;
      modal.node.querySelector('#modal-error')?.replaceChildren();
      void this.ctx.selection({enterSendsMessages: field.checked}).catch(error => {
        if (modal.owns(token)) {field.checked = previous; modal.error(error, 'The preference was not saved.');}
      }).finally(() => {if (modal.owns(token)) {field.disabled = false;progress.hidden=true;this.refreshPreferences();}});
    });
    field.focus();
  }
  paletteEntries(): PaletteEntry[] {
    const primary = this.ctx.primary(); const agent = this.ctx.selectedAgent(); const transcript = this.ctx.hasTranscript(); const sidebarShown = this.ctx.sidebarShown();
    const ready = !!this.readyPrimary(primary), workspaceReady = !!this.ctx.snapshot()?.workspace;
    const entry = (name: string, description: string, run: () => void, enabled = true, alias?: string, disabledReason = 'Requires a Primary session'): PaletteEntry => ({name, description, source: 'app', enabled, run, ...(!enabled ? {disabledReason} : {}), ...(alias ? {search: [alias, `/${alias}`]} : {})});
    const entries = [
      entry('New session', 'Start a new session', () => this.newSession(), true, 'new'),
      entry('Sessions', 'Resume a saved session', () => this.projectPicker(), true, 'resume'),
      ...this.ctx.handover ? [entry('Continue a handover…', 'Pick up a handover in a browser session', this.ctx.handover)] : [],
      entry('Fork from message…', 'Branch from a loaded user message', () => this.forkPicker(), ready, 'fork'),
      entry('Compact…', 'Summarize primary context', () => this.compact(), ready, 'compact'),
      entry('Automatic retry…', 'Enable or disable Pi retry', () => this.automaticSettings('autoRetry'), ready),
      entry('Automatic compaction…', 'Enable or disable Pi compaction', () => this.automaticSettings('autoCompaction'), ready),
      entry('Continue in terminal…', 'Continue this session in the terminal', () => this.handoff(), !!this.readyPrimary(primary,'handoff')),
      entry('Conversation details', 'Identity, reported facts and diagnostics', () => agent ? this.conversationDetails(agent.identity) : this.sessionDetails(primary), !!primary || !!agent, undefined, 'Requires a selected conversation'),
      entry('Saved drafts and messages', 'Review saved text', () => this.ctx.recovery()),
      {...entry('Appearance', 'Choose a theme', () => this.appearance()), search: ['theme', 'stylesheet', 'css', ...appearanceChoices.flat()]},
      {...entry('Message input…', 'Set the message box Enter action', () => this.messageInput()), search: ['Enter sends messages', 'Enter', 'newline', 'Shift+Enter', 'Ctrl+Enter', 'Command+Enter']},
      {...entry('Agent presentation control', 'Allow agents to arrange this workspace and show notices', () => {
        void this.ctx.selection({agentControl:this.ctx.snapshot()?.workspace.agentControl === false}).catch(error=> {
          this.ctx.modal.open('Agent presentation control');this.ctx.modal.error(error,'The preference was not saved.');
        });
      }),checked:this.ctx.snapshot()?.workspace.agentControl !== false},
      entry('Help', 'Browser controls and terminal fallback', () => this.help()),
      entry('Expand loaded tools', 'Expand loaded tool output', () => this.ctx.view(true, true), transcript, undefined, 'Requires a conversation transcript'),
      entry('Collapse loaded tools', 'Collapse loaded tool output', () => this.ctx.view(true, false), transcript, undefined, 'Requires a conversation transcript'),
      entry('Show thinking', 'Show loaded thinking text', () => this.ctx.view(false, true), transcript, undefined, 'Requires a conversation transcript'),
      entry('Hide thinking', 'Hide loaded thinking text', () => this.ctx.view(false, false), transcript, undefined, 'Requires a conversation transcript'),
      entry('Find text', 'Find text in this session', () => this.find(), transcript, undefined, 'Requires a conversation transcript'),
      entry('Notifications', 'Read and dismiss notices', () => this.ctx.notices()),
      entry('Refresh agents', 'Refresh the agent list', () => this.ctx.rosterRefresh()),
      entry('Refresh files', 'Refresh the file listing', () => this.ctx.filesRefresh()),
      entry('Insert /agent new', 'Insert the command into the Primary draft', () => this.prepareText('/agent new')),
      sidebarShown
        ? {...entry('Hide sidebar', 'Hide the conversation sidebar', () => this.ctx.sidebar(false)), search: ['sidebar', 'hide', 'show', 'Show sidebar']}
        : {...entry('Show sidebar', 'Show the conversation sidebar', () => this.ctx.sidebar(true)), search: ['sidebar', 'hide', 'show', 'Hide sidebar']},
      entry('Projects', 'Choose a project', () => this.openProject()),
      entry('Workspaces…','Open a saved workspace',()=>this.workspaces(),workspaceReady),
      entry('Archived workspaces…','Restore a saved workspace',()=>this.workspaces(true),workspaceReady),
      entry('Model', 'Choose Primary model', () => this.modelPicker(), primary?.lifecycle === 'ready', 'model', 'Requires a ready Primary'),
      entry('Thinking', 'Choose the thinking level for Primary', () => this.thinkingPicker(), primary?.lifecycle === 'ready', 'thinking', 'Requires a ready Primary'),
    ];
    if (this.ctx.tabs) {
      const tabs = this.ctx.tabs;
      entries.push(entry('Close conversation tab', 'Keep its session and draft', tabs.close),
        {...entry('Next conversation tab', 'Select the next conversation', () => tabs.switch(1)), shortcut: {text: '⌥⇟', keys: 'Alt+PageDown'}},
        {...entry('Previous conversation tab', 'Select the previous conversation', () => tabs.switch(-1)), shortcut: {text: '⌥⇞', keys: 'Alt+PageUp'}});
    }
    if (primary?.lifecycle === 'ready' && (primary.lastError || primary.responseOutcome === 'failed' || responseOutcome(this.ctx.primaryEntries()) === 'failed')) entries.push(entry('Review message', 'Restore the last loaded Primary user prompt for review', () => this.retryOutput()));
    if (agent) {
      entries.push(entry('Copy agent ID', agent.identity, () => this.ctx.copyAgent()));

    }
    entries.push(entry('Sent and received tasks…','Recorded asks and available answers',this.ctx.resultLookup??(()=>this.ctx.inspectAgent()),!!(agent||primary), undefined, 'Requires a selected conversation'));
    if (primary?.lifecycle === 'ready' && this.resourceTarget === `${primary.key}:${primary.epoch}:${primary.lifecycle}`) {
      for (const command of this.commands.filter(item => item.name !== 'resume')) {
        entries.push({...command, name: `Insert /${command.name}`, search: [`/${command.name}`], enabled: true, run: () => this.prepareText(`/${command.name}`)});
      }
    }
    const conversation = new Set(['Conversation details', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text', 'Copy agent ID', 'Sent and received tasks…', 'Close conversation tab']);
    const primaryActions = new Set(['Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Model', 'Thinking', 'Review message', 'Insert /agent new']);
    const workspace = new Set(['New session', 'Sessions', 'Continue a handover…', 'Saved drafts and messages', 'Appearance', 'Message input…', 'Agent presentation control', 'Help', 'Notifications', 'Refresh agents', 'Refresh files', 'Hide sidebar', 'Show sidebar', 'Projects', 'Next conversation tab', 'Previous conversation tab']);
    const preferences = new Set(['Appearance','Message input…','Agent presentation control','Hide sidebar','Show sidebar']);
    return [...entries.filter(item => item.enabled && (workspaceReady || !preferences.has(item.name))).map(item => {
      let priority = 2;
      if (item.source === 'app') {
        if (conversation.has(item.name) || !agent && primaryActions.has(item.name)) priority = 0;
        else if (workspace.has(item.name)) priority = 1;
      }
      return {...item, priority};
    }), ...this.agentEntries()];
  }
  private agentEntries(chooseTarget?: (target: Target) => void): PaletteEntry[] {
    const now = Date.now(); const agents = this.ctx.agents().filter(row => !chooseTarget || !!row.identity);
    this.captions.update(agents);
    return agents.slice().sort((a, b) => agentOrder(a) - agentOrder(b)).map(row => ({...(this.ctx.agentCaption?.(row.identity) ?? this.captions.get(row.identity)), description: [this.ctx.agentStatus(row), compactAge(row.modifiedAt, now)].filter(Boolean).join(' · '), search: [row.identity, ...row.handle ? [row.handle] : []], title: row.identity, source: 'agent', enabled: true, run: () => chooseTarget ? chooseTarget({kind: 'agent', identity: row.identity}) : this.ctx.selectAgent(row)}));
  }
  sessionMenuEntries(agent = false): PaletteEntry[] {
    const names = new Set(agent ? ['Conversation details', 'Copy agent ID', 'Sent and received tasks…', 'Saved drafts and messages', 'Message input…', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text', 'Appearance', 'Help'] : ['New session', 'Sessions', 'Continue a handover…', 'Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Conversation details', 'Sent and received tasks…', 'Saved drafts and messages', 'Message input…', 'Appearance', 'Help', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text', 'Model', 'Thinking', 'Review message']);
    return this.paletteEntries().filter(item => item.source === 'app' && names.has(item.name));
  }
  sessionMenu(agent = false): void {
    const modal = this.ctx.modal; modal.open(agent ? 'Agent actions' : 'Session actions');
    const list = element('div', 'options session-menu');
    for (const item of this.sessionMenuEntries(agent)) {
      const row = button(item.name, () => { if (!item.enabled) return; modal.close(); item.run(); }); row.disabled = !item.enabled; row.title = item.disabledReason ?? item.description; list.append(row);
    }
    list.append(button('Commands…', () => this.palette()));
    list.addEventListener('keydown', event => navigateOptions(event, list)); modal.body.append(list);
    list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  gotoEntries(chooseTarget?: (target: Target) => void): PaletteEntry[] {
    const entries = chooseTarget ? this.agentEntries(chooseTarget) : this.paletteEntries().filter(item => item.source === 'agent'); const primary = this.ctx.primary();
    if (primary && (!chooseTarget || primary.key)) {
      const target = this.target(primary);
      entries.unshift({name: primary.extension?.title ?? primary.sessionName ?? 'Primary', description: 'Primary', source: 'primary', enabled: true, title: `primary:${primary.key}:${primary.epoch}`, search: ['primary', primary.key, primary.cwd, ...(primary.sessionId ? [primary.sessionId] : [])], run: () => chooseTarget ? chooseTarget(target) : this.ctx.selectPrimary()});
    }
    return entries;
  }
  palette(mode: 'commands' | 'goto' = 'commands', chooseTarget?: (target: Target) => void): void {
    let dispose = () => {};
    const modal = this.ctx.modal; modal.open(mode === 'goto' ? 'Go to conversation' : 'Commands', undefined, () => dispose()); const token = modal.token;
    modal.node.dataset.variant = 'palette'; modal.node.dataset.mode = mode;
    const search = input(mode === 'goto' ? 'Search conversations' : 'Search commands and agents'); search.label.className = 'sr-only';
    search.field.setAttribute('role', 'combobox'); search.field.setAttribute('aria-autocomplete', 'list'); search.field.setAttribute('aria-expanded', 'true'); search.field.setAttribute('aria-controls', 'palette-list');
    const prompt = element('span', 'palette-prompt'); prompt.append(cardIcon('search')); prompt.setAttribute('aria-hidden', 'true');
    search.field.className = 'palette-input'; search.field.placeholder = mode === 'goto' ? 'Search conversations' : 'Search commands and agents';
    const line = element('div', 'palette-input-row'); line.append(prompt, search.label, search.field);
    const list = element('div', 'palette-list'); list.id = 'palette-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', mode === 'goto' ? 'Conversations' : 'Commands and agents'); modal.body.append(line, list);
    let active = 0; let matches: ReturnType<typeof rankCommands> = [];
    const reveal = () => {
      const selected = list.children[active] as HTMLElement | undefined; if (!selected) return;
      revealPaletteRow(list, selected); revealPaletteRow(modal.node, selected);
    };
    const view = list.ownerDocument.defaultView;
    if (!view) { modal.error(new Error('The palette requires a document view.'), 'Commands are unavailable.'); return; }
    const sizePalette = () => {
      if (!modal.owns(token)) { dispose(); return; }
      const limit = Number.parseFloat(view.getComputedStyle(modal.node).maxHeight);
      const row = Number.parseFloat(view.getComputedStyle(list).getPropertyValue('--palette-row-size'));
      const border = list.offsetHeight - list.clientHeight;
      // Scroll height includes the input, optional footer, and errors, but excludes dialog borders.
      const chrome = modal.node.scrollHeight - list.offsetHeight + modal.node.offsetHeight - modal.node.clientHeight;
      const budget = `${Math.max(row + border, limit - chrome)}px`;
      if (list.style.getPropertyValue('--palette-available-height') !== budget) list.style.setProperty('--palette-available-height', budget);
      reveal();
    };
    const observer = new ResizeObserver(sizePalette);
    dispose = () => { observer.disconnect(); view.removeEventListener('resize', sizePalette); };
    observer.observe(line); observer.observe(modal.body);
    const error = modal.node.querySelector('#modal-error'); if (error) observer.observe(error);
    view.addEventListener('resize', sizePalette);
    const run = (index: number) => {
      if (!modal.owns(token)) return;
      const selected = matches[index]?.item as PaletteEntry | undefined; if (!selected?.enabled) return;
      modal.close(); selected.run();
    };
    const select = () => {
      const rows = [...list.children].slice(0, matches.length) as HTMLElement[];
      rows.forEach((row, index) => { row.setAttribute('aria-selected', String(index === active)); });
      const selected = rows[active];
      if (selected) { search.field.setAttribute('aria-activedescendant', selected.id); reveal(); }
      else search.field.removeAttribute('aria-activedescendant');
    };
    const paint = () => {
      const previous = matches[active]?.item as PaletteEntry | undefined; const entries = mode === 'goto' ? this.gotoEntries(chooseTarget) : this.paletteEntries();
      matches = rankPalette(entries, search.field.value.trim());
      active = Math.max(0, matches.findIndex(match => match.item.name === previous?.name && match.item.source === previous?.source && (match.item as PaletteEntry).title === previous?.title)); list.replaceChildren();
      matches.forEach((match, index) => {
        const item = match.item as PaletteEntry;
        const row = paletteRow(item, match.marks, mode === 'goto' || item.source === 'agent', () => run(index)); row.id = `palette-option-${index}`;
        list.append(row);
      });
      if (!matches.length) list.append(paletteEmpty(search.field.value, mode === 'commands' && (!this.commandsLoaded || this.commandsIncomplete) || rosterIncomplete(this.ctx.snapshot())));
      sizePalette(); select();
    };
    search.field.addEventListener('input', () => { active = 0; matches = []; paint(); });
    search.field.addEventListener('keydown', raw => {
      const event = raw as KeyboardEvent; if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); select(); }
      else if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) run(active); }
    });
    this.commandPaint = () => { if (modal.owns(token)) paint(); };
    paint(); search.field.focus(); if (mode === 'goto') return;
    void this.load('commands').then(page => {
      if (!modal.owns(token)) return;
      paint(); if (page.nextCursor) {
        const primary = this.ctx.primary(); const version = this.resourceVersion;
        const more = button('More commands', () => { more.disabled = true; void modal.run(async () => {
          try { await this.moreCommands(primary, version, page); more.hidden = !page.nextCursor; }
          finally { more.disabled = false; }
        }, false, 'Commands could not be loaded.'); }); modal.body.append(more); sizePalette();
      }
    }).catch(error => { if (modal.owns(token)) modal.error(error, 'Commands could not be loaded.'); });
  }
  unknown(text: string, sendLiteral: () => void): boolean {
    const name = /^\/([^\s]+)/.exec(text)?.[1]; if (!name) return false;
    const builtin: Record<string, () => void> = {new: () => this.newSession(), resume: () => this.projectPicker(), fork: () => this.forkPicker(), compact: () => this.compact(), model: () => this.modelPicker(), thinking: () => this.thinkingPicker()};
    if (builtin[name]) { builtin[name](); return true; }
    if (['agent', 'stash'].includes(name) && !text.includes(' ')) { this.terminalOnly(name); return true; }
    if (this.commands.some(command => command.name === name)) return false;
    const modal = this.ctx.modal; modal.open('Unknown slash command'); modal.body.append(element('p', undefined, `/${name} is not in the command list. Your draft is unchanged.`));
    modal.actions(button('Edit draft', () => modal.close()), button('Send literal text', () => { modal.close(); sendLiteral(); })); return true;
  }
  prepareText(text: string): void {
    const composer = this.ctx.composer;
    if (composer.target?.kind !== 'primary' || this.ctx.primary()?.lifecycle !== 'ready') {
      const modal = this.ctx.modal;
      modal.open('Primary session required');
      modal.body.append(element('p', 'secondary', 'Select a session for Primary to insert this command. Your drafts are unchanged.'), element('pre', undefined, text));
      modal.actions(button('Sessions', () => this.projectPicker()), cardAction('copy', 'Copy command', () => { void copy(text, modal.body); })); return;
    }
    const target = {...composer.target}; const previousText = composer.editor.value;
    const apply = async () => {
      await this.ctx.selection({selectedTarget: target});
      if (JSON.stringify(composer.target) !== JSON.stringify(target) || this.ctx.primary()?.lifecycle !== 'ready' || composer.editor.value !== previousText) return;
      composer.setText(text); composer.editor.focus();
    };
    if (!composer.editor.value) { void this.ctx.modal.run(apply, false); return; }
    this.ctx.modal.confirm('Replace Primary draft?', 'This replaces your Primary draft. Copy it first to keep both texts.', apply, 'Replace draft');
    this.ctx.modal.body.append(element('pre', undefined, composer.editor.value), cardAction('copy', 'Copy draft', () => { void copy(composer.editor.value, this.ctx.modal.body); }));
  }
  private terminalOnly(name: string): void {
    const modal = this.ctx.modal; modal.open('Terminal-only panel'); modal.body.append(element('p', undefined, `The bare /${name} panel requires the terminal. Text actions remain available through the primary.`));
    modal.actions(button('Cancel', () => modal.close()),...(this.readyPrimary(this.ctx.primary(),'handoff') ? [button('Continue in terminal…', () => this.handoff())] : []));
    if (name === 'agent') modal.body.append(button('Insert /agent new…', () => { modal.close(); this.prepareText('/agent new'); }));
  }
  workspaces(archived = false): void {
    if(!this.ctx.snapshot()?.workspace)return;
    const modal=this.ctx.modal;modal.open(archived ? 'Archived workspaces' : 'Workspaces');const token=modal.token;
    const list=element('div','options workspace-choices');list.addEventListener('keydown',event=>navigateOptions(event,list));modal.body.append(list);
    let cursor:string|null=null;
    const load=async()=> {
      const page=await request<WorkspacePage>(`/api/workspaces?archived=${archived}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if(!modal.owns(token))return;cursor=page.nextCursor;
      for(const item of page.items)list.append(this.workspaceChoice(item,archived,token));
      if(!list.children.length)list.append(element('p','secondary',archived ? 'No archived workspaces.' : 'No saved workspaces.'));
      modal.actions(button('Projects…',()=>this.openProject()),button(archived ? 'Workspaces' : 'Archived workspaces…',()=>this.workspaces(!archived)),...(cursor ? [button('More',()=>{void modal.run(load,false);})] : []));
    };
    void modal.run(load,false,'Workspaces could not be loaded.');
  }
  private workspaceChoice(item: WorkspaceSummary, archived: boolean, token: Modal['token']): HTMLButtonElement {
    const modal=this.ctx.modal, row=button('',()=>{void modal.run(async()=> {
      if(!modal.owns(token))return;
      await request(`/api/workspaces/${encodeURIComponent(item.id)}/restore`,'POST',{});
      const url=new URL('/',location.href);url.searchParams.set('workspace',item.id);url.searchParams.set('restore','workspace');location.assign(url);
    },false,'The workspace did not open.');},'workspace-choice');
    row.title=item.id;row.append(element('span','workspace-name',item.name),element('span','workspace-action',archived ? 'Restore' : 'Open'),element('span','workspace-meta',`${item.lastUsedAt ? `Last used ${relativeTime(item.lastUsedAt,Date.now())}` : 'Last use not recorded'} · ${item.tabCount} tabs`));
    const meta=row.querySelector<HTMLElement>('.workspace-meta');if(meta && item.lastUsedAt)meta.title=absoluteTime(item.lastUsedAt);
    return row;
  }
  private preferencePaint?: () => void;
  refreshPreferences(): void { this.preferencePaint?.(); }
  appearance(): void {
    if (!this.ctx.snapshot()?.workspace) return;
    const modal = this.ctx.modal; modal.open('Appearance'); const token = modal.token; const rows = element('div', 'options');
    const current = resolveAppearance(this.ctx.snapshot()?.workspace.appearance); let selected: HTMLButtonElement | undefined;
    rows.setAttribute('role', 'menu'); rows.setAttribute('aria-label', 'Appearance');
    for (const [appearance, label] of appearanceChoices) {
      const row = choice(label, appearance === current, () => { if (this.ctx.snapshot()?.workspace) void modal.run(() => this.ctx.selection({appearance})); }); row.dataset.appearance = appearance; rows.append(row);
      if (appearance === current) selected = row;
    }
    this.preferencePaint = () => {
      if (!modal.owns(token)) { this.preferencePaint = undefined; return; }
      const appearance = resolveAppearance(this.ctx.snapshot()?.workspace.appearance);
      for (const row of rows.querySelectorAll<HTMLButtonElement>('button')) {
        const checked = row.dataset.appearance === appearance; row.setAttribute('aria-checked',String(checked));
        const check = row.querySelector<HTMLElement>('.choice-check'); if (check) check.style.visibility = checked ? 'visible' : 'hidden';
      }
    };
    rows.addEventListener('keydown', event => navigateOptions(event, rows)); modal.body.append(rows, element('p', 'appearance-note', userStylesheetApplied() ? 'Your stylesheet is applied.' : 'Add your own stylesheet with ui.userStylesheet in harness.json.')); selected?.focus();
  }
  find(findTarget: () => FindSession | undefined = this.ctx.find): void {
    const session = findTarget(); const modal = this.ctx.modal;
    modal.open('Find text', undefined, () => session?.close(), 'find'); const token = modal.token;
    const query = input('Text'); query.label.className = 'sr-only'; query.field.setAttribute('aria-label', 'Text'); query.field.setAttribute('type', 'search');
    const status = element('p', 'find-status', 'Enter text to find.'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const step = (previous = false) => {
      if (!modal.owns(token)) return;
      const result = previous ? session?.previous(query.field.value) : session?.next(query.field.value);
      status.textContent = findStatusText(result, query.field.value);
    };
    query.field.addEventListener('input', () => {if (modal.owns(token)) {session?.reset(); status.textContent = 'Find the first loaded match.';}});
    query.field.addEventListener('keydown', raw => {const event = raw as KeyboardEvent; if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); step(event.shiftKey);}});
    modal.body.append(query.label, query.field, status, element('p', 'find-coverage secondary', 'Searches loaded messages only.'));
    modal.actions(cardAction('previous', 'Previous', () => step(true)), cardAction('next', 'Next', () => step())); query.field.focus();
  }
  help(): void {
    const modal = this.ctx.modal; modal.open('Help');
    modal.body.append(element('p', undefined, 'Closing this tab does not stop your sessions or agents.'), element('p', undefined, 'Choose the model and thinking level below the message box. Agent settings require an idle agent.'), element('p', undefined, 'Use Commands to find actions. Closing a dialog never stops work.'), element('p', undefined, 'Unsaved drafts are lost if the browser closes unexpectedly.'));
    modal.body.append(details('Display limits', `Message box syntax uses plain text above ${DECORATION_BYTES / 1024} KiB, ${DECORATION_LINES} lines, or ${DECORATION_SPANS} color marks. Composition and forced colors use native text.`));
  }
  retryOutput(): void {
    const primary = this.ctx.primary(); if (primary?.lifecycle !== 'ready') return;
    const composer = this.ctx.composer, selected = composer.target;
    if (selected?.kind !== 'primary' || selected.key !== primary.key || selected.epoch !== primary.epoch) return;
    const target = {...selected}, workspace = this.ctx.snapshot()?.workspace.id, draft = composer.editor.value;
    const items = this.ctx.primaryEntries();
    const user = items.flatMap(entry => entry.messages ?? []).findLast(message => message.role === 'user');
    const text = user?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
    if (!text) { this.ctx.modal.open('Review message').append(element('p', undefined, 'No loaded message is available. Write a new message to Primary.')); return; }
    const guard = () => {
      const current = this.ctx.primary();
      if (this.ctx.snapshot()?.workspace.id !== workspace || current?.key !== primary.key || current.epoch !== primary.epoch || current.lifecycle !== 'ready' || this.ctx.composer !== composer || JSON.stringify(composer.target) !== JSON.stringify(target) || composer.editor.value !== draft) throw new Error('The Primary or its draft changed. Review the current message again.');
    };
    this.ctx.modal.confirm('Review message', `${draft ? 'This replaces your current Primary draft. ' : ''}This restores the message for review. Sending it again risks duplicate work.`, async () => {
      guard(); await this.ctx.selection({selectedTarget: target}); guard(); composer.setText(text); composer.editor.focus();
    }, 'Restore message');
    this.ctx.modal.body.append(element('p', undefined, 'Message to restore'), element('pre', undefined, text));
    if (draft) this.ctx.modal.body.append(element('p', undefined, 'Current draft'), element('pre', undefined, draft));
  }
  handoff(): void {
    const primary = this.readyPrimary(this.ctx.primary(),'handoff'); if (!primary) return;
    const modal = this.ctx.modal; modal.open('Continue in terminal');
    modal.body.append(element('p', 'identity', primary.sessionFile ?? 'No saved session yet'), element('p', undefined, 'Browser control stops before you continue in the terminal. Other agents continue.'));
    const release = async (mode: 'settle' | 'abort') => {
      if (!this.readyPrimary(primary,'handoff')) throw new Error('Resume Primary from Sessions before this action.');
      const result = await operation('primary.handoff', this.path(primary, 'handoff'), {epoch: primary.epoch, mode, clearQueue: mode === 'abort'}, this.target(primary));
      this.ctx.result(result);
    };
    modal.actions(button('Cancel', () => modal.close()), button(primary.activity === 'idle' ? 'Continue in terminal' : 'Finish work, then continue', () => { void modal.run(() => release('settle'), false); }));
    if (primary.activity !== 'idle') modal.actions(button('Stop and continue in terminal…', () => modal.confirm('Stop and continue in terminal', 'Pi clears queued input and aborts current work. The backend retains cleared text copies.', () => release('abort'), 'Stop and continue')));
  }
  handoffResult(result: OperationView): void {
    if (result.kind !== 'primary.handoff' || result.state !== 'completed' || result.receipt?.kind !== 'rpc') return;
    const data = result.receipt.result?.value as HandoffView | undefined; if (!data?.command || this.displayedHandoffs.has(result.id)) return;
    this.displayedHandoffs.add(result.id); if (this.displayedHandoffs.size > 64) this.displayedHandoffs.delete(this.displayedHandoffs.values().next().value as string);
    const {cwd, sessionFile} = data; const modal = this.ctx.modal; modal.open('Ready for terminal');
    modal.body.append(element('pre', undefined, data.command), cardAction('copy', 'Copy command', () => { void copy(data.command, modal.body); }), element('p', undefined, 'Browser control is stopped. Other Durable agents continue.'), element('p', 'secondary', 'Exit Pi in the terminal before you resume here. The browser does not detect other writers.'));
    const resumable = typeof cwd === 'string' && savedPathValid(cwd) && typeof sessionFile === 'string' && savedPathValid(sessionFile);
    modal.actions(...(resumable ? [button('Resume here', () => this.sessionPicker().resume(cwd, sessionFile), 'main-action')] : []), button('Open session…', () => this.projectPicker()));
  }
}
