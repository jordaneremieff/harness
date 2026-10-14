import {workspaceTabKey, type FileTab, type Workspace} from '../shared/api.ts';
import {paneLeaves} from './pane-layout.ts';
import {FileOwner, type FileRead, type FileIO} from './file-owner.ts';
import {FileView} from './file-view.ts';
import type {StableViews} from './stable-views.ts';
import type {DevFileCheckpoint} from './dev-reload.ts';
import {movedFilePath, movedFileKey, type FileMove} from './file-identity.ts';
/** Document owners and stable source/preview views have separate identities. */
export class FilesViews {
  private retainedSequence = 0;
  private owners = new Map<string,FileOwner>();private views = new Map<string,FileView>();
  private refreshQueue = new Set<FileOwner>();private refreshWork?:Promise<void>;
  private saves = new Map<string,{workspace:string;key:string;position:FileView['position'];timer:ReturnType<typeof setTimeout>}>();
  private host:()=>StableViews;private read:FileRead;private current:()=>Workspace|undefined;private io?:FileIO;
  private save:(workspace:string,key:string,position:FileView['position'])=>void;private changed:()=>void;
  constructor(host:()=>StableViews,read:FileRead,current:()=>Workspace|undefined,save:(workspace:string,key:string,position:FileView['position'])=>void,changed:()=>void,io?:FileIO) {this.host = host;this.read = read;this.current = current;this.save = save;this.changed = changed;this.io = io;}
  private key(workspace:string,tab:FileTab):string {return JSON.stringify([workspace,workspaceTabKey(tab)]);}
  private ownerKey(workspace:string,tab:FileTab):string {return JSON.stringify([workspace,tab.rootId,tab.path]);}
  owner(workspace:string,tab:FileTab):FileOwner|undefined {return this.owners.get(this.ownerKey(workspace,tab));}
  view(workspace:Workspace,tab:FileTab):FileView {
    const key = this.key(workspace.id,tab);let view = this.views.get(key);if (view) return view;
    const document = this.ownerKey(workspace.id,tab);let owner = this.owners.get(document);const reopening = !!owner && ![...this.views.values()].some(view=>view.owner === owner);
    if (!owner) {
      owner = new FileOwner(workspace.id,tab,this.read,()=> {for (const view of this.views.values()) if (view.owner === owner) view.paint();this.changed();},this.io);this.owners.set(document,owner);
    }
    const documentOwner = owner;
    view = new FileView(owner,workspace.filePositions?.[workspaceTabKey(tab)],position=> {
      const currentTab = {...documentOwner.tab,...(tab.view === 'preview' ? {view:'preview' as const} : {})}, currentKey = this.key(workspace.id,currentTab);
      const old = this.saves.get(currentKey);clearTimeout(old?.timer);
      this.saves.set(currentKey,{workspace:workspace.id,key:workspaceTabKey(currentTab),position,timer:setTimeout(()=>this.flush(currentKey),120)});
    },tab.view === 'preview');
    this.views.set(key,view);this.host().mount(view.root);void owner.load(reopening);return view;
  }
  private flush(key:string):void {
    const pending = this.saves.get(key);if (!pending) return;clearTimeout(pending.timer);this.saves.delete(key);
    const workspace = this.current();
    if (workspace?.id === pending.workspace && workspace.conversationLayout && paneLeaves(workspace.conversationLayout.root).some(pane=>pane.tabs.some(tab=>workspaceTabKey(tab) === pending.key))) this.save(pending.workspace,pending.key,{...pending.position});
  }
  scopes(workspace:string):{rootId:string;files:string[]}[] {
    const roots = new Map<string,Set<string>>();for (const view of this.views.values()) if (view.owner.workspace === workspace && !view.owner.retained) {const tab = view.owner.tab,files = roots.get(tab.rootId) ?? new Set();files.add(tab.path);roots.set(tab.rootId,files);}
    return [...roots].map(([rootId,files])=>({rootId,files:[...files]}));
  }
  refresh(workspace:string,rootId:string,paths:string[],rescan = false):Promise<void> {
    const files = new Set(paths),open = new Set([...this.views.values()].map(view=>view.owner));
    for (const owner of open) if (owner.workspace === workspace && !owner.retained && owner.tab.rootId === rootId && (rescan || files.has(owner.tab.path))) this.refreshQueue.add(owner);
    if (!this.refreshWork) this.refreshWork = this.flushRefresh().finally(()=> {this.refreshWork = undefined;});return this.refreshWork;
  }
  private async flushRefresh():Promise<void> {
    while (this.refreshQueue.size) {const owners = [...this.refreshQueue].slice(0,2);for (const owner of owners) this.refreshQueue.delete(owner);await Promise.all(owners.map(owner=>owner.refreshDisk()));}
  }
  async prepareMove(workspace:string,move:FileMove):Promise<()=>void> {
    const owners = [...this.owners.values()].filter(owner=>owner.workspace === workspace && !owner.retained && owner.tab.rootId === move.rootId && movedFilePath(owner.tab.path,move) !== owner.tab.path);
    for (const owner of owners) {owner.moving = true;for (const view of this.views.values()) if (view.owner === owner) view.paint();}
    const release = ()=> {for (const owner of owners) {owner.moving = false;for (const view of this.views.values()) if (view.owner === owner) view.paint();}this.changed();};
    try {for (const owner of owners) await owner.drain();return release;} catch(error) {release();throw error;}
  }
  remap(workspace:string,move:FileMove):void {this.remapOwners(workspace,move);this.remapViews(workspace);this.remapPositions(workspace,move);this.changed();}
  retained(workspace?:string):FileOwner[] {return [...this.owners.values()].filter(owner=>owner.retained && (!workspace || owner.workspace === workspace));}
  discardRetained(owner:FileOwner):void {
    if (!owner.retained) return;
    for (const [key,current] of this.owners) if (current === owner) this.owners.delete(key);
    this.refreshQueue.delete(owner);owner.dispose();
    for (const [key,view] of this.views) if (view.owner === owner) {this.host().forget(view.root);view.destroy();this.views.delete(key);}
    this.changed();
  }
  private remapOwners(workspace:string,move:FileMove):void {
    const moved = [...this.owners].filter(([,owner])=>owner.workspace === workspace && !owner.retained && owner.tab.rootId === move.rootId && movedFilePath(owner.tab.path,move) !== owner.tab.path);
    for (const [key] of moved) this.owners.delete(key);
    for (const [,owner] of moved) {
      const path = movedFilePath(owner.tab.path,move),key = this.ownerKey(workspace,{...owner.tab,path}),destination = this.owners.get(key);
      if (destination) this.retainOwner(key,destination);
      owner.remap(path);this.owners.set(key,owner);
    }
  }
  private retainOwner(key:string,owner:FileOwner):void {
    this.owners.delete(key);this.owners.set(JSON.stringify([key,'retained',++this.retainedSequence]),owner);this.refreshQueue.delete(owner);
    for (const tab of [owner.tab,{...owner.tab,view:'preview' as const}]) {const positionKey = this.key(owner.workspace,tab);clearTimeout(this.saves.get(positionKey)?.timer);this.saves.delete(positionKey);}
    owner.retain();
  }
  private remapViews(workspace:string):void {
    const views = [...this.views];this.views.clear();
    for (const [key,view] of views) {
      const retainedKey = view.owner.retained ? [...this.owners].find(([,owner])=>owner === view.owner)?.[0] : undefined;
      const next = retainedKey ? JSON.stringify([retainedKey,view.preview]) : view.owner.workspace === workspace ? this.key(workspace,{...view.owner.tab,...(view.preview ? {view:'preview'} : {})}) : key;
      this.views.set(next,view);if (view.owner.retained) this.host().place(view.root);view.paint();
    }
  }
  private remapPositions(workspace:string,move:FileMove):void {
    for (const [key,pending] of [...this.saves]) if (pending.workspace === workspace) {const next = movedFileKey(pending.key,move);if (next === pending.key) continue;clearTimeout(pending.timer);this.saves.delete(key);pending.key = next;const nextKey = JSON.stringify([workspace,next]);clearTimeout(this.saves.get(nextKey)?.timer);pending.timer = setTimeout(()=>this.flush(nextKey),120);this.saves.set(nextKey,pending);}
  }
  get canDispose():boolean {return [...this.owners.values()].every(owner=>owner.canDispose);}
  async drain():Promise<void> {for (const key of this.saves.keys()) this.flush(key);for (const owner of this.owners.values()) await owner.drain();}
  reconcile(workspace:Workspace,tabs:FileTab[],active:FileTab[]):void {
    const open = new Set(tabs.map(tab=>this.key(workspace.id,tab))), shown = new Set(active.map(tab=>this.key(workspace.id,tab)));
    for (const [key,view] of this.views) {
      if (view.owner.retained) {this.host().place(view.root);continue;}
      if (open.has(key)) {if (!shown.has(key)) this.host().place(view.root);continue;}
      this.flush(key);void view.owner.drain().catch(()=>{});this.host().forget(view.root);view.destroy();this.views.delete(key);
    }
  }
  attached():void {for (const view of this.views.values()) view.restore();}
  checkpoint(workspace:Workspace):DevFileCheckpoint[] {
    if (this.retained().length) throw new Error('A retained draft needs review before an update.');
    return [...this.views.values()].filter(view=>view.owner.workspace === workspace.id).map(view=> {
      const owner = view.owner;if (!owner.source || owner.loading || owner.error || owner.unsaved || owner.saving) throw new Error('File content is not ready for an update.');
      const tab:FileTab = {...owner.tab,...(view.preview ? {view:'preview'} : {})};
      return {tab,position:view.capture(),digest:owner.source.revision.digest,focused:document.activeElement === view.scroller};
    });
  }
  private restorePositions(workspace:Workspace,files:DevFileCheckpoint[]):boolean {
    for (const file of files) {const view = this.views.get(this.key(workspace.id,file.tab));if (!view) return false;view.setPosition(file.position);if (file.focused) view.focus();}return true;
  }
  async restore(workspace:Workspace,files:DevFileCheckpoint[],current:()=>boolean):Promise<boolean> {
    for (const file of files) {
      if (!workspace.conversationLayout || !paneLeaves(workspace.conversationLayout.root).some(pane=>pane.tabs.some(tab=>workspaceTabKey(tab) === workspaceTabKey(file.tab)))) return false;
      const view = this.view(workspace,file.tab);await view.owner.load();if (!current() || view.owner.source?.revision.digest !== file.digest || view.owner.error) return false;
      if (file.focused && (view.root.hidden || view.root.inert)) return false;
    }
    return current() && this.restorePositions(workspace,files) && current();
  }
  positions(workspace:Workspace):NonNullable<Workspace['filePositions']> {
    const result = {...workspace.filePositions};for (const view of this.views.values()) if (view.owner.workspace === workspace.id && !view.owner.retained) result[workspaceTabKey({...view.owner.tab,...(view.preview ? {view:'preview'} : {})})] = view.capture();return result;
  }
}
