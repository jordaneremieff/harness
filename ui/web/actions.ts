import type { Bootstrap, CommandView, EntryView, HandoffView, ModelChoice, OperationView, PrimaryControl, PrimaryView, ResourcePage, Snapshot, Target, Workspace } from '../shared/api.ts';
import { button, copy, details, element, input, rawText } from './dom.ts';
import type { Modal } from './modal.ts';
import { operation, request } from './transport.ts';
import type { Composer } from './composer.ts';
import { navigateOptions } from './list-navigation.ts';

export type SelectionChange = Partial<Omit<Workspace, 'selectedTarget'>> & {selectedTarget?: Target | null};
export type ActionContext = {snapshot: () => Snapshot | undefined; primary: () => PrimaryView | undefined; composer: Composer; modal: Modal;
  selection: (change: SelectionChange) => Promise<void>; reload: () => Promise<void>; result: (result: OperationView) => void; rosterRefresh: () => void; find: (query: string) => void; recovery: () => void; primaryEntries: () => EntryView[]};
export class Actions {
  private resources = new Map<string, Promise<ResourcePage>>();
  private commands: CommandView[] = [];
  private displayedHandoffs = new Set<string>();
  private ctx: ActionContext;
  constructor(ctx: ActionContext) { this.ctx = ctx; }
  private target(primary: PrimaryView): Target { return {kind: 'primary', key: primary.key, epoch: primary.epoch}; }
  private path(primary: PrimaryView, suffix: string): string { return `/api/primaries/${encodeURIComponent(primary.key)}/${suffix}`; }
  async load(kind: 'commands' | 'models' | 'thinking'): Promise<ResourcePage> {
    const primary = this.ctx.primary(); if (!primary) return {items: [], nextCursor: null, revision: ''};
    const key = `${primary.key}:${primary.epoch}:${kind}`;
    let cache = this.resources.get(key);
    if (!cache) { cache = request<ResourcePage>(this.path(primary, `resources/${kind}?limit=100`)); this.resources.set(key, cache); cache.catch(() => this.resources.delete(key)); }
    const result = await cache;
    if (kind === 'commands' && this.ctx.primary()?.key === primary.key && this.ctx.primary()?.epoch === primary.epoch) this.commands = result.items as CommandView[];
    return result;
  }
  warm(): void { this.commands = []; void this.load('commands').catch(() => undefined); }
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
    modal.actions(button('Cancel', () => modal.close()), button('Resume saved session', () => { modal.confirm('Confirm saved session resume', `${session.field.value}\nConfirm that this exact file is not open in a terminal or another Pi writer. Pi exposes no external writer lock query.`, () => start(true), 'No other writer · Resume'); }), button('Start new session', () => { void modal.run(() => start(false)); }, 'accent'));
    if (snapshot?.primaries.length) {
      body.append(element('h2', undefined, 'Open in this workspace'));
      for (const item of snapshot.primaries) body.append(button(`${item.sessionName ?? item.sessionId ?? 'Session'} · ${item.cwd} · ${item.lifecycle}`, () => { void modal.run(() => this.ctx.selection({primaryKey: item.key, selectedTarget: null})); }));
    }
    for (const index of snapshot?.primaryIndex ?? []) if (!snapshot?.primaries.some(item => item.key === index.key)) body.append(button(`Backend session ${index.key} · ${index.lifecycle}`, () => { void modal.run(() => this.ctx.selection({primaryKey: index.key, selectedTarget: null})); }));
    body.append(element('p', 'secondary', 'Enter an exact saved session path. Browsing this picker does not start Pi.'));
    directory.field.focus();
  }
  sessionMenu(): void {
    const modal = this.ctx.modal; const primary = this.ctx.primary();
    modal.open('Session actions');
    const actions: [string, () => void][] = [['New session', () => this.newSession()], ['Resume saved session', () => this.projectPicker()], ['Fork from message…', () => this.forkPicker()], ['Compact…', () => this.compact()], ['Automatic retry…', () => this.automaticSettings('autoRetry')], ['Automatic compaction…', () => this.automaticSettings('autoCompaction')], ['Continue in terminal…', () => this.handoff()], ['Session details', () => this.sessionDetails()], ['Saved drafts and input copies', () => this.ctx.recovery()], ['Appearance', () => this.appearance()], ['Help', () => this.help()]];
    const rows = element('div', 'options');
    for (const [name, action] of actions) { const node = button(name, action); node.disabled = !primary && !['Resume saved session', 'Saved drafts and input copies', 'Appearance', 'Help'].includes(name); rows.append(node); } modal.body.append(rows);
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
    modal.actions(button('Cancel', () => modal.close()), button('Compact', () => { void modal.run(() => this.control({action: 'compact', customInstructions: instructions.field.value} as PrimaryControl, primary)); }, 'accent'));
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
  palette(): void {
    const modal = this.ctx.modal; modal.open('Commands'); const token = modal.token;
    const search = input('Search actions and resources'); const list = element('div', 'options'); modal.body.append(search.label, search.field, list);
    const builtins: [string, () => void][] = [['New session', () => this.newSession()], ['Resume saved session', () => this.projectPicker()], ['Fork', () => this.forkPicker()], ['Compact', () => this.compact()], ['Review retry prompt', () => this.retryOutput()], ['Automatic retry', () => this.automaticSettings('autoRetry')], ['Automatic compaction', () => this.automaticSettings('autoCompaction')], ['Model', () => this.modelPicker()], ['Thinking', () => this.thinkingPicker()], ['Agents', () => { modal.close(); void this.ctx.selection({panelVisible: true}); }], ['Appearance', () => this.appearance()], ['Saved drafts and input copies', () => this.ctx.recovery()], ['Continue in terminal', () => this.handoff()], ['Find in loaded messages', () => this.find()], ['Help', () => this.help()]];
    const paint = () => {
      const query = search.field.value.toLocaleLowerCase(); list.replaceChildren();
      for (const [name, action] of builtins) if (name.toLocaleLowerCase().includes(query)) list.append(button(`${name} · Action`, action));
      for (const command of this.commands) if (`${command.name} ${command.description}`.toLocaleLowerCase().includes(query)) {
        const node = button(`/${command.name}`, () => { modal.close(); this.prepareText(`/${command.name}`); }); node.append(element('span', 'secondary', `${command.description} · ${command.source}`)); list.append(node);
      }
    };
    search.field.addEventListener('input', paint); search.field.addEventListener('keydown', raw => { const event = raw as KeyboardEvent; if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector<HTMLButtonElement>('button')?.focus(); } });
    list.addEventListener('keydown', event => navigateOptions(event, list));
    paint(); search.field.focus(); void this.load('commands').then(page => {
      if (!modal.owns(token)) return;
      paint(); if (page.nextCursor) {
        const more = button('More discovered commands', () => { more.disabled = true; void modal.run(async () => {
          try {
            const primary = this.ctx.primary(); if (!primary) return;
            const next = await request<ResourcePage>(this.path(primary, `resources/commands?limit=100&cursor=${encodeURIComponent(page.nextCursor ?? '')}`));
            this.commands = [...this.commands, ...next.items as CommandView[]]; page.nextCursor = next.nextCursor; more.hidden = !next.nextCursor; paint();
          } finally { more.disabled = false; }
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
    if (!composer.editor.value) { composer.setText(text); composer.editor.focus(); return; }
    this.ctx.modal.confirm('Use primary text action', 'Your current primary draft will be replaced. Copy it first if you need both texts.', async () => { composer.setText(text); composer.editor.focus(); }, 'Replace draft');
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
