import type { EventData, TargetPreparation, Workspace } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
export function navigationState(workspace: Workspace | undefined, narrow: boolean, drawerOpen = false): {sidebarVisible: boolean; agentSelected: boolean; editor: 'primary-editor' | 'agent-editor'} {
  const agentSelected = workspace?.selectedTarget?.kind === 'agent';
  return {sidebarVisible: narrow ? drawerOpen : workspace?.sidebarVisible !== false, agentSelected, editor: agentSelected ? 'agent-editor' : 'primary-editor'};
}
export function visibleReceipt(workspace?: Workspace): 'primary-receipt' | 'agent-receipt' {
  return workspace?.selectedTarget?.kind === 'agent' ? 'agent-receipt' : 'primary-receipt';
}
export type MessageCapture = {workspaceId: string; identity: string; generation: number; prepared?: TargetPreparation; invalidated?: boolean; error?: string};
type MessageHooks = {workspace: () => Workspace | undefined; prepare: (workspaceId: string, target: {kind: 'agent'; identity: string}) => Promise<TargetPreparation>; paint: () => void};
export class MessageTarget {
  private generation = 0;
  current?: MessageCapture;
  private hooks: MessageHooks;
  constructor(hooks: MessageHooks) { this.hooks = hooks; }
  close(): void { this.generation++; this.current = undefined; }
  valid(captured: MessageCapture): boolean {
    const workspace = this.hooks.workspace();
    return this.current === captured && captured.generation === this.generation && workspace?.id === captured.workspaceId && workspace.selectedTarget?.kind !== 'agent';
  }
  rosterChanged(data: EventData['agent.roster']): void {
    const current = this.current; if (!current) return;
    const changed = data.changed.find(row => row.identity === current.identity);
    if (data.removed.includes(current.identity) || (changed && changed.availability !== 'live')) this.invalidate();
  }
  availabilityChanged(data: EventData['agent.availability']): void {
    if (data.identity === this.current?.identity && (data.state !== 'live' || !data.capabilities.input)) this.invalidate();
  }
  private invalidate(): void {
    const current = this.current; if (!current) return;
    current.invalidated = true; current.error = 'Agent availability changed. Reopen Message to prepare again. Your draft stays here.';
  }
  async open(identity: string): Promise<void> {
    const workspace = this.hooks.workspace(); if (!workspace || workspace.selectedTarget?.kind === 'agent') return;
    const captured: MessageCapture = {workspaceId: workspace.id, identity, generation: ++this.generation};
    this.current = captured; this.hooks.paint();
    try {
      const prepared = await this.hooks.prepare(captured.workspaceId, {kind: 'agent', identity: captured.identity});
      if (!this.valid(captured)) return;
      if (prepared.targetState.target.kind !== 'agent' || prepared.targetState.target.identity !== captured.identity) throw new Error('Prepared message target did not match.');
      captured.prepared = prepared;
    } catch (error) {
      if (!this.valid(captured)) return;
      captured.error = error instanceof Error ? error.message : String(error);
    }
    this.hooks.paint();
  }
  get ready(): boolean { const current = this.current; return !!current && this.valid(current) && !current.invalidated && current.prepared?.availability === 'live' && current.prepared.capabilities.input; }
}
export type SelectionHooks = {current: () => Workspace | undefined; save: (workspace: Workspace, change: SelectionChange) => Promise<Workspace>; reload: () => Promise<void>; paint: (workspace: Workspace, pending: boolean) => void};
/** Cached selection appears immediately; backend revisions advance in one ordered lane. */
export class SelectionQueue {
  private committed?: Workspace;
  private pending = new Map<number, SelectionChange>();
  private serial = 0;
  private tail = Promise.resolve();
  private hooks: SelectionHooks;
  constructor(hooks: SelectionHooks) {this.hooks = hooks;}
  private overlay(): Workspace | undefined {
    let workspace = this.committed;
    if (!workspace) return undefined;
    for (const change of this.pending.values()) workspace = {...workspace, ...change, selectedTarget: change.selectedTarget === null ? undefined : change.selectedTarget ?? workspace.selectedTarget};
    return workspace;
  }
  private paint(): void {const workspace = this.overlay(); if (workspace) this.hooks.paint(workspace, this.pending.size > 0);}
  observe(workspace: Workspace): Workspace {
    if (!this.committed || workspace.revision >= this.committed.revision) this.committed = workspace;
    return this.overlay() ?? workspace;
  }
  select(change: SelectionChange): Promise<void> {
    this.committed ??= this.hooks.current(); if (!this.committed) return Promise.resolve();
    const id = ++this.serial; this.pending.set(id, change); this.paint();
    const task = this.tail.then(async () => {
      try {this.observe(await this.hooks.save(this.committed as Workspace, change));}
      catch (error) {
        this.pending.delete(id); this.paint();
        if (!this.pending.size) await this.hooks.reload();
        throw error;
      }
      this.pending.delete(id); this.paint();
      if (!this.pending.size) {
        await this.hooks.reload();
        const current = this.hooks.current(); if (current) this.observe(current); this.paint();
      }
    });
    this.tail = task.catch(() => undefined); return task;
  }
}
