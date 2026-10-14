import {workspaceTabKey, type FileTab, type Workspace} from '../shared/api.ts';
import {paneLeaves} from './pane-layout.ts';
import {FileOwner, type FileRead, type FileIO} from './file-owner.ts';
import {FileView} from './file-view.ts';
import type {StableViews} from './stable-views.ts';
import type {DevFileCheckpoint} from './dev-reload.ts';
/** Document owners and stable source/preview views have separate identities. */
export class FilesViews {
  private owners = new Map<string,FileOwner>();private views = new Map<string,FileView>();
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
      owner = new FileOwner(workspace.id,tab,this.read,()=> {for (const view of this.views.values()) if (view.owner === this.owners.get(document)) view.paint();this.changed();},this.io);this.owners.set(document,owner);
    }
    view = new FileView(owner,workspace.filePositions?.[workspaceTabKey(tab)],position=> {
      const old = this.saves.get(key);clearTimeout(old?.timer);
      this.saves.set(key,{workspace:workspace.id,key:workspaceTabKey(tab),position,timer:setTimeout(()=>this.flush(key),120)});
    },tab.view === 'preview');
    this.views.set(key,view);this.host().mount(view.root);void owner.load(reopening);return view;
  }
  private flush(key:string):void {
    const pending = this.saves.get(key);if (!pending) return;clearTimeout(pending.timer);this.saves.delete(key);
    const workspace = this.current();
    if (workspace?.id === pending.workspace && workspace.conversationLayout && paneLeaves(workspace.conversationLayout.root).some(pane=>pane.tabs.some(tab=>workspaceTabKey(tab) === pending.key))) this.save(pending.workspace,pending.key,{...pending.position});
  }
  get canDispose():boolean {return [...this.owners.values()].every(owner=>owner.canDispose);}
  async drain():Promise<void> {for (const key of this.saves.keys()) this.flush(key);await Promise.all([...this.owners.values()].map(owner=>owner.drain()));}
  reconcile(workspace:Workspace,tabs:FileTab[],active:FileTab[]):void {
    const open = new Set(tabs.map(tab=>this.key(workspace.id,tab))), shown = new Set(active.map(tab=>this.key(workspace.id,tab)));
    for (const [key,view] of this.views) {
      if (open.has(key)) {if (!shown.has(key)) this.host().place(view.root);continue;}
      this.flush(key);void view.owner.drain().catch(()=>{});this.host().forget(view.root);view.destroy();this.views.delete(key);
    }
  }
  attached():void {for (const view of this.views.values()) view.restore();}
  checkpoint(workspace:Workspace):DevFileCheckpoint[] {
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
    const result = {...workspace.filePositions};for (const view of this.views.values()) if (view.owner.workspace === workspace.id) result[workspaceTabKey({...view.owner.tab,...(view.preview ? {view:'preview'} : {})})] = view.capture();return result;
  }
}
