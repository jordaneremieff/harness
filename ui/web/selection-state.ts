import type { Workspace } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
export function navigationState(workspace: Workspace | undefined, narrow: boolean, drawerOpen = false): {sidebarVisible: boolean; agentSelected: boolean; editor: 'primary-editor' | 'agent-editor'} {
  const agentSelected = workspace?.selectedTarget?.kind === 'agent';
  return {sidebarVisible: narrow ? drawerOpen : workspace?.sidebarVisible !== false, agentSelected, editor: agentSelected ? 'agent-editor' : 'primary-editor'};
}
export function visibleReceipt(workspace?: Workspace): 'primary-receipt' | 'agent-receipt' {
  return workspace?.selectedTarget?.kind === 'agent' ? 'agent-receipt' : 'primary-receipt';
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
