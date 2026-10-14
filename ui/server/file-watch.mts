import {watch, type FSWatcher} from 'node:fs';
import {dirname} from 'node:path';
import {LIMITS} from '../shared/api.ts';
import {movedFilePath, type FileWatchScope, type FileWatchState, type FileChanges, type FileWatchRootState} from '../shared/files.ts';
import {checkedFilePath, filePath, type RegisteredRoot} from './file-access.mts';
import {ApiError} from './errors.mts';
type Scope = FileWatchScope & {workspace:string};
type RootWatch = {root:RegisteredRoot; handles:Map<string,FSWatcher>; identities:Map<string,{dev:number;ino:number}>; state:FileWatchRootState; dirty:Map<string,Set<string>>; rescan:boolean; timer?:NodeJS.Timeout; flushing?:boolean};
export type WatchFactory = typeof watch;
function parentPath(path:string) {return dirname(path) === '.' ? '' : dirname(path);}
function scopeChange(state:RootWatch,scope:Scope,dirty:Map<string,Set<string>>,rescan:boolean):FileChanges|undefined {
  const directories = new Set<string>(), files = new Set<string>();let bytes = 0,overflow = rescan;
  const add = (set:Set<string>,path:string)=> {
    if (set.has(path)) return;
    const cost = Buffer.byteLength(JSON.stringify(path));
    if (directories.size+files.size >= LIMITS.fileChangePaths || bytes+cost > LIMITS.fileChangeBytes) {overflow = true;return;}
    bytes += cost;set.add(path);
  };
  for (const path of dirty.keys()) if (scope.directories.includes(path)) add(directories,path);
  for (const file of scope.files) {const parent = parentPath(file),names = dirty.get(parent);if (names && (rescan || names.has(file.slice(parent ? parent.length+1 : 0)))) add(files,file);}
  if (!overflow && !directories.size && !files.size) return;
  return {rootId:state.root.id,directories:[...directories],files:[...files],rescan:overflow,watch:state.state.watch,...(state.state.reason ? {reason:state.state.reason} : {})};
}
/** Watches are hints for bounded scoped reads, never a filesystem inventory or a readiness handshake. */
export class FileWatches {
  private scopes = new Map<string,Map<string,FileWatchScope[]>>();
  private roots = new Map<string,RootWatch>();
  private stopped = false;
  private root:(id:string)=>RegisteredRoot;
  private publish:(change:FileChanges,workspace:string)=>void;
  private factory:WatchFactory;
  constructor(root:(id:string)=>RegisteredRoot,publish:(change:FileChanges,workspace:string)=>void,factory:WatchFactory = watch) {this.root = root;this.publish = publish;this.factory = factory;}
  state(workspace:string,clientId:string):FileWatchState {return {roots:(this.scopes.get(workspace)?.get(clientId) ?? []).map(scope=>({...this.roots.get(scope.rootId)?.state ?? {rootId:scope.rootId,watch:'unavailable' as const,reason:'Live files are unavailable. Refresh files explicitly.'}}))};}
  async replace(workspace:string,clientId:string,scopes:FileWatchScope[]):Promise<FileWatchState> {
    if (this.stopped) throw new ApiError('file_unavailable','Live files are unavailable.',503,'read');
    this.validateRequest(workspace,scopes);
    const clients = this.scopes.get(workspace) ?? new Map<string,FileWatchScope[]>();
    if (!clients.has(clientId) && clients.size >= LIMITS.eventClients) throw new ApiError('capacity','The live-file client bound is full.',429,'read');
    this.validate(scopes);if (scopes.length) {clients.set(clientId,structuredClone(scopes));this.scopes.set(workspace,clients);} else {clients.delete(clientId);if (!clients.size) this.scopes.delete(workspace);}await this.reconcile();
    for (const scope of scopes) {const state = this.roots.get(scope.rootId);if (state) this.publish({rootId:scope.rootId,directories:[],files:[],rescan:true,watch:state.state.watch,...(state.state.reason ? {reason:state.state.reason} : {})},workspace);}
    return this.state(workspace,clientId);
  }
  private validateRequest(workspace:string,scopes:FileWatchScope[]) {
    if (scopes.length > LIMITS.fileRoots || new Set(scopes.map(scope=>scope.rootId)).size !== scopes.length) throw new ApiError('invalid_request','The watch roots exceed their bound or repeat.');
    if (Buffer.byteLength(JSON.stringify({roots:scopes})) > LIMITS.requestBytes || !this.scopes.has(workspace) && this.scopes.size >= LIMITS.workspaces) throw new ApiError('capacity','The live-file scope exceeds its byte or workspace bound.',429,'read');
  }
  private validate(scopes:FileWatchScope[]) {
    let files = 0;
    for (const scope of scopes) {
      this.root(scope.rootId);files += scope.files.length;
      if (scope.directories.length > LIMITS.fileWatchDirectories || files > LIMITS.fileWatchFiles) throw new ApiError('capacity','The live-file scope exceeds its bound.',429,'read');
      scope.directories.forEach(path=> {filePath(path);});scope.files.forEach(path=> {filePath(path,false);});
      if (new Set(scope.directories).size !== scope.directories.length || new Set(scope.files).size !== scope.files.length) throw new ApiError('invalid_request','The watch scope repeats a path.');
    }
  }
  async release(workspace:string,clientId:string) {const clients = this.scopes.get(workspace);clients?.delete(clientId);if (!clients?.size) this.scopes.delete(workspace);await this.reconcile();}
  private all():Scope[] {
    return [...this.scopes].flatMap(([workspace,clients])=> {
      const roots = new Map<string,{directories:Set<string>;files:Set<string>}>();
      for (const scopes of clients.values()) for (const scope of scopes) {const paths = roots.get(scope.rootId) ?? {directories:new Set<string>(),files:new Set<string>()};scope.directories.forEach(path=> {paths.directories.add(path);});scope.files.forEach(path=> {paths.files.add(path);});roots.set(scope.rootId,paths);}
      return [...roots].map(([rootId,paths])=>({workspace,rootId,directories:[...paths.directories],files:[...paths.files]}));
    });
  }
  private desired(scopes:Scope[]):Set<string> {return new Set(scopes.flatMap(scope=>[...scope.directories,...scope.files.map(parentPath)]));}
  private async reconcile() {
    const all = this.all(),rootIds = new Set(all.map(scope=>scope.rootId));
    for (const [id,state] of this.roots) if (!rootIds.has(id)) {this.stopRoot(state);this.roots.delete(id);}
    let total = 0;
    for (const id of rootIds) {
      let state = this.roots.get(id);
      if (!state) {state = {root:this.root(id),handles:new Map(),identities:new Map(),state:{rootId:id,watch:'live'},dirty:new Map(),rescan:false};this.roots.set(id,state);}
      const desired = this.desired(all.filter(scope=>scope.rootId === id));
      if (desired.size > LIMITS.fileWatchDirectories || total+desired.size > LIMITS.fileWatchHandles) {this.unavailable(state,'Live files reached the watch bound. Refresh files explicitly.');continue;}
      total += desired.size;await this.reconcileRoot(state,desired);
    }
  }
  private async reconcileRoot(state:RootWatch,desired:Set<string>) {
    for (const [path,handle] of state.handles) if (!desired.has(path)) {state.handles.delete(path);state.identities.delete(path);handle.close();}
    state.state = {rootId:state.root.id,watch:'live'};
    for (const path of desired) {
      if (state.handles.has(path)) continue;
      try {await this.attach(state,path);} catch {this.unavailable(state,'Live files are unavailable. Refresh files explicitly.');break;}
    }
  }
  private async attach(state:RootWatch,path:string) {
    const target = await checkedFilePath(state.root,path);if (!target.info.isDirectory()) throw new Error('Not a directory.');
    const handle = this.factory(target.path,{persistent:false,recursive:false},(_event,name)=>this.hint(state,path,name === null ? undefined : String(name)));
    handle.on('error',()=>this.unavailable(state,'Live files are unavailable. Refresh files explicitly.'));
    handle.on('close',()=> {if (state.handles.get(path) === handle) this.unavailable(state,'Live files stopped. Refresh files explicitly.');});
    state.handles.set(path,handle);state.identities.set(path,{dev:target.info.dev,ino:target.info.ino});
    state.rescan = true;this.schedule(state);
  }
  private schedule(state:RootWatch) {state.timer ??= setTimeout(()=>void this.flush(state),LIMITS.fileWatchCoalesceMs);state.timer.unref();}
  private hint(state:RootWatch,path:string,name?:string) {
    if (this.stopped || state.state.watch !== 'live') return;
    const names = state.dirty.get(path) ?? new Set<string>();
    if (!name || name.includes('/') || name.length > LIMITS.pathChars) state.rescan = true;
    else if (state.dirty.size+[...state.dirty.values()].reduce((count,values)=>count+values.size,0) >= LIMITS.fileChangePaths) state.rescan = true;
    else names.add(name);
    if (state.dirty.size < LIMITS.fileChangePaths) state.dirty.set(path,names);else state.rescan = true;this.schedule(state);
  }
  private async validDirty(state:RootWatch,dirty:Map<string,Set<string>>):Promise<boolean> {
    for (const path of dirty.keys()) {
      if (!state.handles.has(path)) continue;
      try {
        const target = await checkedFilePath(state.root,path),identity = state.identities.get(path);
        if (!state.handles.has(path)) continue;
        if (!identity || target.info.dev !== identity.dev || target.info.ino !== identity.ino) throw new Error('Watch identity changed.');
      } catch {this.unavailable(state,'Live files changed their directory identity. Refresh files explicitly.');return false;}
    }
    return !this.stopped && state.state.watch === 'live';
  }
  private async flush(state:RootWatch) {
    clearTimeout(state.timer);state.timer = undefined;if (state.flushing) return;state.flushing = true;
    try {
      const dirty = state.dirty,rescan = state.rescan;state.dirty = new Map();state.rescan = false;
      if (!await this.validDirty(state,dirty)) return;
      for (const scope of this.all().filter(scope=>scope.rootId === state.root.id)) {const change = scopeChange(state,scope,dirty,rescan);if (change) this.publish(change,scope.workspace);}
    } finally {state.flushing = false;if (!this.stopped && state.state.watch === 'live' && (state.dirty.size || state.rescan)) this.schedule(state);}
  }
  private stopRoot(state:RootWatch) {clearTimeout(state.timer);state.timer = undefined;const handles = [...state.handles.values()];state.handles.clear();state.identities.clear();for (const handle of handles) handle.close();state.dirty.clear();}
  private unavailable(state:RootWatch,reason:string) {
    const changed = state.state.watch !== 'unavailable' || state.state.reason !== reason;this.stopRoot(state);state.state = {rootId:state.root.id,watch:'unavailable',reason};
    if (changed) for (const scope of this.all().filter(scope=>scope.rootId === state.root.id)) this.publish({rootId:state.root.id,directories:[],files:[],rescan:true,watch:'unavailable',reason},scope.workspace);
  }
  assertMove(rootId:string,from:string,to:string):void {
    for (const scope of this.all()) if (scope.rootId === rootId && scope.files.some(path=> !(path === from || path.startsWith(`${from}/`)) && (path === to || path.startsWith(`${to}/`)))) throw new ApiError('file_changed','The destination has an open file identity. Choose another name.',409,'read');
  }
  async moved(rootId:string,from:string,to:string) {
    for (const clients of this.scopes.values()) for (const scopes of clients.values()) for (const scope of scopes) if (scope.rootId === rootId) {scope.directories = scope.directories.map(path=>movedFilePath(path,from,to));scope.files = scope.files.map(path=>movedFilePath(path,from,to));}
    await this.reconcile();
  }
  close() {this.stopped = true;for (const state of this.roots.values()) this.stopRoot(state);this.roots.clear();this.scopes.clear();}
}
