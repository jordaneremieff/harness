import type {FileTab} from '../shared/api.ts';
import type {FileText} from '../shared/files.ts';
export type FileRead = (workspace:string,tab:FileTab,signal:AbortSignal)=>Promise<FileText>;
/** Source ownership is independent of presentation, pane geometry and reading position. */
export class FileOwner {
  readonly tab:Readonly<FileTab>;
  source?:Readonly<FileText>;
  loading = false;
  error?:string;
  private generation = 0;
  private abort?:AbortController;
  private pending?:Promise<void>;
  private disposed = false;
  readonly workspace:string;
  private read:FileRead;private changed:()=>void;
  constructor(workspace:string,tab:FileTab,read:FileRead,changed:()=>void) {this.workspace = workspace;this.read = read;this.changed = changed;this.tab = Object.freeze({...tab});}
  load(refresh = false):Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!refresh && this.pending) return this.pending;
    if (!refresh && (this.source || this.error)) return Promise.resolve();
    const generation = ++this.generation;this.abort?.abort();const abort = new AbortController();this.abort = abort;
    this.loading = true;this.error = undefined;this.changed();
    const current = () => !this.disposed && generation === this.generation && !abort.signal.aborted;
    const pending = this.read(this.workspace,this.tab,abort.signal).then(source=> {
      if (!current()) return;
      if (source.rootId !== this.tab.rootId || source.path !== this.tab.path) throw new Error('The file response identity changed.');
      if (this.source?.revision.digest !== source.revision.digest) this.source = Object.freeze({...source,revision:Object.freeze({...source.revision})});
    }).catch(error=> {if (current()) this.error = error instanceof Error ? error.message : 'The file is unavailable.';})
      .finally(()=> {if (current()) {this.loading = false;this.pending = undefined;this.changed();}});
    this.pending = pending;return pending;
  }
  dispose():void {this.disposed = true;this.generation++;this.abort?.abort();}
}
