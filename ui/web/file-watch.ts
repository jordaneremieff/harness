import type {FileChanges, FileWatchScope, FileWatchState} from '../shared/files.ts';
type WatchHooks = {put(workspace:string,roots:FileWatchScope[]):Promise<FileWatchState>;changed():void};
/** Scope writes coalesce; disk events carry changes without browser polling. */
export class FileWatch {
  private hooks:WatchHooks;private latest?:{workspace:string;roots:FileWatchScope[];signature:string};private running?:Promise<void>;private signature = '';private workspace = '';private state = new Map<string,string>();
  constructor(hooks:WatchHooks) {this.hooks = hooks;}
  get status():string {return [...this.state.values()].filter(Boolean).join(' ');}
  scope(workspace:string,roots:FileWatchScope[],force = false):Promise<void> {
    if (this.workspace !== workspace) {this.workspace = workspace;this.state.clear();}
    const signature = JSON.stringify([workspace,roots]);if (!force && (signature === this.latest?.signature || signature === this.signature)) return this.running ?? Promise.resolve();
    this.latest = {workspace,roots,signature};if (this.running) return this.running;
    const running = this.flush().finally(()=> {this.running = undefined;});this.running = running;return running;
  }
  private async flush():Promise<void> {
    while (this.latest) {const current = this.latest;this.latest = undefined;
      try {const state = await this.hooks.put(current.workspace,current.roots);this.signature = current.signature;if (current.workspace !== this.workspace) continue;this.receive(state);}
      catch(error) {this.signature = current.signature;if (current.workspace !== this.workspace) continue;this.state.clear();this.state.set('',`Live files unavailable. ${error instanceof Error ? error.message : 'Use Refresh files.'}`);}
      this.hooks.changed();
    }
  }
  private receive(state:FileWatchState):void {this.state.clear();for (const root of state.roots) this.state.set(root.rootId,root.watch === 'unavailable' ? `Live files unavailable. ${root.reason ?? 'Use Refresh files.'}` : '');}
  change(change:FileChanges):void {this.state.set(change.rootId,change.watch === 'unavailable' ? `Live files unavailable. ${change.reason ?? 'Use Refresh files.'}` : '');this.hooks.changed();}
}
