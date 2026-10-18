import type {FileChanges, FileWatchScope, FileWatchState} from '../shared/files.ts';
import {ApiError} from './transport.ts';
const PAUSED = 'Live file updates paused. Use Refresh files.';
type WatchHooks = {put(workspace:string,roots:FileWatchScope[],clientId:string):Promise<FileWatchState>;changed():void};
/** Scope writes coalesce; disk events carry changes without browser polling. */
export class FileWatch {
  readonly clientId = crypto.randomUUID();
  private hooks:WatchHooks;private latest?:{workspace:string;roots:FileWatchScope[];signature:string;force:boolean};private running?:Promise<void>;private signature = '';private workspace = '';private state = new Map<string,string>();private raw = '';
  constructor(hooks:WatchHooks) {this.hooks = hooks;}
  get status():string {return [...this.state.values()].filter(Boolean).join(' ');}
  /** The browser's own error text for a failed watch write. It belongs in a title or Details, never in the shown sentence. */
  get detail():string {return this.raw;}
  scope(workspace:string,roots:FileWatchScope[],force = false):Promise<void> {
    if (this.workspace !== workspace) {this.workspace = workspace;this.state.clear();this.raw = '';}
    const signature = JSON.stringify([workspace,roots]);if (!force && (signature === this.latest?.signature || (!this.running && signature === this.signature))) return this.running ?? Promise.resolve();
    this.latest = {workspace,roots,signature,force};if (this.running) return this.running;
    const running = this.flush().finally(()=> {this.running = undefined;});this.running = running;return running;
  }
  private async flush():Promise<void> {
    while (this.latest) {const current = this.latest;this.latest = undefined;if (!current.force && current.signature === this.signature) continue;
      try {const state = await this.hooks.put(current.workspace,current.roots,this.clientId);this.signature = current.signature;if (current.workspace !== this.workspace) continue;this.receive(state);}
      catch(error) {this.signature = current.signature;if (current.workspace !== this.workspace) continue;this.state.clear();this.failed(error);}
      this.hooks.changed();
    }
  }
  /** A server reason is operator-facing text and stays; any other failure is a transport detail behind a fixed sentence. */
  private failed(error:unknown):void {
    if (error instanceof ApiError) {this.raw = '';this.state.set('',`Live files unavailable. ${error.message}`);return;}
    this.raw = error instanceof Error ? error.message : '';this.state.set('',PAUSED);
  }
  private receive(state:FileWatchState):void {this.raw = '';this.state.clear();for (const root of state.roots) this.state.set(root.rootId,root.watch === 'unavailable' ? `Live files unavailable. ${root.reason ?? 'Use Refresh files.'}` : '');}
  change(change:FileChanges):void {this.state.set(change.rootId,change.watch === 'unavailable' ? `Live files unavailable. ${change.reason ?? 'Use Refresh files.'}` : '');this.hooks.changed();}
}
