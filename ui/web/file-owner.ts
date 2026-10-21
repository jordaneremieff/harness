import type {FileTab} from '../shared/api.ts';
import {fileSource, sameFileRevision, type FileText, type FileDraft, type FileDraftState, type FileRevision, type FileSave, type FileEncoding} from '../shared/files.ts';
export type FileRead = (workspace:string,tab:FileTab,signal:AbortSignal)=>Promise<FileText>;
export type FileIO = {draft(workspace:string,tab:FileTab,signal:AbortSignal):Promise<FileDraftState>;put(workspace:string,tab:FileTab,revision:number,base:FileRevision,text:string,encoding:FileEncoding):Promise<FileDraft>;save(workspace:string,tab:FileTab,revision:number):Promise<FileSave>};
function frozenSource(source:FileText):Readonly<FileText> {return Object.freeze({...source,revision:Object.freeze({...source.revision})});}
function failureText(error:unknown,fallback:string):string {return error instanceof Error ? error.message : fallback;}
function changedFile(error:unknown):boolean {return (error as {view?:{code?:string}}|undefined)?.view?.code === 'file_changed';}
function missingFile(error:unknown):boolean {return (error as {view?:{code?:string}}|undefined)?.view?.code === 'file_missing' || /missing|not found|does not exist|ENOENT/i.test(failureText(error,''));}
/** One document owns the draft; native source views own their selection and undo. */
export class FileOwner {
  private documentTab:Readonly<FileTab>;readonly workspace:string;
  get tab():Readonly<FileTab> {return this.documentTab;}
  source?:Readonly<FileText>;draft?:FileDraft;encoding?:FileEncoding;
  private editBase?:Readonly<FileRevision>;
  text?:string;acknowledged?:string;loading = false;saving = false;persisting = false;conflict = false;error?:string;draftError?:string;
  replacement = 0;missing = false;moving = false;
  private retainedState = false;
  get retained():boolean {return this.retainedState;}
  private diskGeneration = 0;private diskPending?:Promise<void>;private diskAgain = false;
  private generation = 0;private abort?:AbortController;private pending?:Promise<void>;private disposed = false;
  private revision = 0;private queued = 0;private saveFailed = false;private timer?:ReturnType<typeof setTimeout>;private tail:Promise<void> = Promise.resolve();
  private read:FileRead;private changed:()=>void;private io?:FileIO;
  constructor(workspace:string,tab:FileTab,read:FileRead,changed:()=>void,io?:FileIO) {this.workspace = workspace;this.read = read;this.changed = changed;this.io = io;this.documentTab = Object.freeze({kind:'file',rootId:tab.rootId,path:tab.path});}
  get modified():boolean {return this.text !== undefined && (this.conflict || !this.source || this.text !== fileSource(this.source.text).text);}
  get unsaved():boolean {return this.text !== this.acknowledged || !!this.draftError;}
  get canDispose():boolean {return !this.retained && !this.unsaved && !this.timer && !this.queued && !this.persisting && !this.saving && !this.moving && !this.saveFailed;}
  get status():string {
    if (this.saving) return 'Saving file';if (this.persisting) return 'Saving draft';
    const unsaved = `${this.conflict ? 'Local edits' : 'Draft'} not saved.${this.draftError ? ` ${this.draftError}` : ''}`;
    if (this.moving) return 'Moving file';
    if (this.missing) return `${this.error ?? 'The file is missing.'}${this.text !== undefined ? this.modified ? ' Draft retained.' : ' Source retained.' : ''}`;
    if (this.conflict) return `File changed on disk. ${this.unsaved ? unsaved : 'Draft retained.'}`;
    if (this.unsaved) return unsaved;if (this.error) return this.error;
    if (this.encoding?.writable === false) return 'Mixed line endings or lone carriage returns prevent exact writes.';
    return this.modified ? 'Modified' : '';
  }
  private current(generation:number):boolean {return !this.disposed && generation === this.generation;}
  private identity(source:FileText):void {if (source.rootId !== this.tab.rootId || source.path !== this.tab.path) throw new Error('The file response identity changed.');}
  load(refresh = false):Promise<void> {
    if (this.disposed || this.retained) return Promise.resolve();if (!refresh && this.pending) return this.pending;if (!refresh && (this.text !== undefined || this.error)) return Promise.resolve();
    let generation = refresh ? this.generation : ++this.generation;this.abort?.abort();const abort = new AbortController();this.abort = abort;
    this.loading = true;this.error = undefined;this.changed();const current = () => this.current(generation) && !abort.signal.aborted;
    const reading = refresh ? this.drain().then(()=> {if (!current()) return;generation = ++this.generation;return this.readDocument(abort.signal);}) : this.readDocument(abort.signal);
    const pending = reading.then(result=> {if (current() && result) this.receiveDocument(result[0],result[1],refresh);})
      .catch(error=> {if (current()) this.error = failureText(error,'The file is unavailable.');})
      .finally(()=> {if (current()) {this.loading = false;this.pending = undefined;this.changed();}});
    this.pending = pending;return pending;
  }
  private readDocument(signal:AbortSignal):Promise<[PromiseSettledResult<FileText>,PromiseSettledResult<FileDraftState>]> {
    return Promise.allSettled([this.read(this.workspace,this.tab,signal),this.io?.draft(this.workspace,this.tab,signal) ?? Promise.resolve({revision:0,draft:null})]);
  }
  private receiveDisk(disk:PromiseSettledResult<FileText>,draft:FileDraft|null):void {
    if (disk.status === 'fulfilled') {
      this.missing = false;this.identity(disk.value);if (!this.source || !sameFileRevision(this.source.revision,disk.value.revision)) this.source = frozenSource(disk.value);return;
    }
    this.missing = missingFile(disk.reason);this.error = failureText(disk.reason,'The file is unavailable.');if (!draft) throw disk.reason;
  }
  /** The text base advances only with adopted text or an authoritative acknowledgment. */
  private rememberBase(base:FileRevision|undefined):void {this.editBase = base ? Object.freeze({...base}) : undefined;}
  private receiveDocument(disk:PromiseSettledResult<FileText>,stored:PromiseSettledResult<FileDraftState>,refresh:boolean):void {
    if (stored.status === 'rejected') throw stored.reason;
    const draft = stored.value.draft;this.receiveDisk(disk,draft);this.revision = stored.value.revision;this.draft = draft ?? undefined;this.rememberBase(draft?.base ?? this.source?.revision);
    this.conflict = !!draft && (!this.source || disk.status === 'rejected' || !sameFileRevision(draft.base,this.source.revision));
    const loaded = this.source ? fileSource(this.source.text) : undefined, previous = this.text;
    this.text = draft?.text ?? loaded?.text;if (refresh && previous !== this.text) this.replacement++;
    this.encoding = draft?.encoding ?? loaded?.encoding;this.acknowledged = this.text;this.draftError = undefined;
    if (disk.status === 'fulfilled') this.saveFailed = false;
  }
  edit(text:string):void {
    if (this.disposed || this.retained || this.loading || this.moving || this.text === undefined || text === this.text) return;this.text = text;this.changed();clearTimeout(this.timer);
    this.timer = setTimeout(()=> {this.timer = undefined;void this.enqueue(()=>this.persist(this.text ?? '')).catch(()=>{});},120);
  }
  private enqueue(task:()=>Promise<void>):Promise<void> {this.queued++;const work = this.tail.then(task).finally(()=> {this.queued--;});this.tail = work.catch(()=>{});return work;}
  private acknowledge(draft:FileDraft,text:string,base:FileRevision):void {
    if (draft.text !== text || draft.revision <= this.revision || !sameFileRevision(draft.base,base)) throw new Error('The file draft acknowledgment changed.');
    this.draft = draft;this.revision = draft.revision;this.acknowledged = draft.text;this.rememberBase(draft.base);
  }
  private async persist(text:string,force = false):Promise<void> {
    const base = this.editBase;if (!this.io || !base || !this.encoding || this.disposed || this.retained) return;
    if (text === this.acknowledged && (!force || this.draft)) return;
    const generation = this.generation;this.persisting = true;this.draftError = undefined;this.changed();
    try {const draft = await this.io.put(this.workspace,this.tab,this.revision,base,text,this.encoding);if (this.current(generation)) this.acknowledge(draft,text,base);}
    catch(error) {if (this.current(generation)) {this.draftError = failureText(error,'The file draft is unavailable.');if (changedFile(error)) this.conflict = true;}throw error;}
    finally {if (this.current(generation)) {this.persisting = false;this.changed();}}
  }
  drain():Promise<void> {if (this.retained) return Promise.resolve();clearTimeout(this.timer);this.timer = undefined;return this.enqueue(()=>this.persist(this.text ?? ''));}
  save():Promise<void> {
    if (!this.io || this.text === undefined || this.disposed || this.retained || this.loading || this.saving) return Promise.resolve();
    const captured = this.text;clearTimeout(this.timer);this.timer = undefined;return this.enqueue(()=>this.saveCaptured(captured));
  }
  private supersedeDiskRead():void {this.diskGeneration++;if (this.diskPending) this.diskAgain = true;}
  private receiveSave(saved:FileSave,captured:string):void {
    this.identity(saved.source);this.acknowledge(saved.draft,captured,saved.source.revision);
    this.supersedeDiskRead();this.source = frozenSource(saved.source);this.encoding = saved.draft.encoding;this.conflict = false;this.missing = false;this.saveFailed = false;
  }
  private async saveCaptured(captured:string):Promise<void> {
    await this.persist(captured,true);if (!this.io || !this.draft || this.disposed || this.retained) return;
    const generation = this.generation;this.saving = true;this.error = undefined;this.changed();
    try {const saved = await this.io.save(this.workspace,this.tab,this.revision);if (this.current(generation)) this.receiveSave(saved,captured);}
    catch(error) {if (this.current(generation)) {this.saveFailed = true;this.error = failureText(error,'The file was not saved.');this.conflict = /changed|conflict/i.test(this.error);}throw error;}
    finally {if (this.current(generation)) {this.saving = false;this.changed();}}
    if (this.current(generation) && this.text !== captured) await this.persist(this.text ?? '');
  }
  reread():Promise<void> {
    if (this.disposed || this.retained || this.loading) return Promise.resolve();this.loading = true;this.changed();clearTimeout(this.timer);this.timer = undefined;
    return this.enqueue(()=>this.replaceFromDisk()).catch(error=> {if (!this.disposed) this.error = failureText(error,'The file is unavailable.');}).finally(()=> {if (!this.disposed) {this.loading = false;this.changed();}});
  }
  private async replaceFromDisk():Promise<void> {
    if (this.disposed || this.retained) return;
    const generation = this.generation, source = await this.read(this.workspace,this.tab,new AbortController().signal);
    if (!this.current(generation)) return;this.identity(source);const loaded = fileSource(source.text);
    if (this.io) {const draft = await this.io.put(this.workspace,this.tab,this.revision,source.revision,loaded.text,loaded.encoding);if (!this.current(generation)) return;this.acknowledge(draft,loaded.text,source.revision);}
    this.supersedeDiskRead();this.source = frozenSource(source);this.text = loaded.text;this.acknowledged = loaded.text;this.encoding = loaded.encoding;this.rememberBase(source.revision);this.conflict = false;this.missing = false;this.error = undefined;this.draftError = undefined;this.saveFailed = false;this.replacement++;this.changed();
  }
  /** Disk notifications never pause typing or replace a local draft. */
  refreshDisk():Promise<void> {
    if (this.disposed || this.retained) return Promise.resolve();
    if (this.diskPending) {this.diskAgain = true;return this.diskPending;}
    const pending = this.observeDiskChain().finally(()=> {this.diskPending = undefined;});
    this.diskPending = pending;return pending;
  }
  private async observeDiskChain():Promise<void> {
    do {this.diskAgain = false;await this.observeDisk();} while (this.diskAgain && !this.disposed && !this.retained);
  }
  private async observeDisk():Promise<void> {
    await this.pending;await this.tail;if (this.disposed || this.retained) return;const generation = this.generation, diskGeneration = ++this.diskGeneration;
    try {
      const source = await this.read(this.workspace,this.tab,new AbortController().signal);
      if (!this.current(generation) || diskGeneration !== this.diskGeneration) return;
      this.receiveObservedDisk(source);
    } catch(error) {
      if (!this.current(generation) || diskGeneration !== this.diskGeneration) return;
      this.error = failureText(error,'The file is unavailable.');this.missing = missingFile(error);
      if (this.modified || this.unsaved) this.conflict = true;this.changed();
    }
  }
  private receiveObservedDisk(source:FileText):void {
    this.identity(source);const changed = !this.source || !sameFileRevision(this.source.revision,source.revision);
    const local = this.modified || this.unsaved;this.missing = false;this.error = undefined;
    if (changed) {
      this.source = frozenSource(source);
      if (local) this.conflict = true;
      else {const loaded = fileSource(source.text);this.text = loaded.text;this.acknowledged = loaded.text;this.encoding = loaded.encoding;this.draft = undefined;this.rememberBase(source.revision);this.conflict = false;this.replacement++;}
    }
    this.changed();
  }
  /** A displaced local document stays readable but never writes to its replacement. */
  retain():void {
    this.retainedState = true;clearTimeout(this.timer);this.timer = undefined;this.generation++;this.diskGeneration++;this.abort?.abort();
    this.loading = false;this.pending = undefined;this.saving = false;this.persisting = false;this.moving = false;this.changed();
  }
  private clearMovedMissing():void {
    if (!this.missing) return;this.missing = false;this.error = undefined;
    if (!this.draftError && !this.saveFailed && this.source && this.editBase && sameFileRevision(this.editBase,this.source.revision)) this.conflict = false;
  }
  remap(path:string):void {
    this.generation++;this.diskGeneration++;this.abort?.abort();this.loading = false;this.pending = undefined;
    if (this.saving) this.saveFailed = true;this.saving = false;this.persisting = false;
    this.clearMovedMissing();this.documentTab = Object.freeze({...this.tab,path});if (this.source) this.source = frozenSource({...this.source,path});this.changed();
  }
  dispose():void {clearTimeout(this.timer);this.disposed = true;this.generation++;this.diskGeneration++;this.abort?.abort();}
}
