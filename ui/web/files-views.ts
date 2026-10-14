import {workspaceTabKey, type FileTab, type Workspace} from '../shared/api.ts';
import {paneLeaves} from './pane-layout.ts';
import {FileOwner, type FileRead} from './file-owner.ts';
import {FileView} from './file-view.ts';
import type {StableViews} from './stable-views.ts';
import type {DevFileCheckpoint} from './dev-reload.ts';
/** File owners and views have separate lifetimes and identities. Pane moves change neither. */
export class FilesViews {
  private owners = new Map<string,FileOwner>();
  private views = new Map<string,FileView>();
  private saves = new Map<string,{workspace:string;key:string;position:FileView['position'];timer:ReturnType<typeof setTimeout>}>();
  private host:()=>StableViews;private read:FileRead;private current:()=>Workspace|undefined;
  private save:(workspace:string,key:string,position:FileView['position'])=>void;private changed:()=>void;
  constructor(host:()=>StableViews,read:FileRead,current:()=>Workspace|undefined,save:(workspace:string,key:string,position:FileView['position'])=>void,changed:()=>void) {this.host = host;this.read = read;this.current = current;this.save = save;this.changed = changed;}
  private key(workspace:string,tab:FileTab):string {return JSON.stringify([workspace,tab.rootId,tab.path]);}
  view(workspace:Workspace,tab:FileTab):FileView {
    const key = this.key(workspace.id,tab);let view = this.views.get(key);if (view) return view;
    const owner = new FileOwner(workspace.id,tab,this.read,()=> {if (this.owners.get(key) !== owner) return;this.views.get(key)?.paint();this.changed();});
    this.owners.set(key,owner);
    view = new FileView(owner,workspace.filePositions?.[workspaceTabKey(tab)],position=> {
      const old = this.saves.get(key);clearTimeout(old?.timer);
      this.saves.set(key,{workspace:workspace.id,key:workspaceTabKey(tab),position,timer:setTimeout(()=>this.flush(key),120)});
    });
    this.views.set(key,view);this.host().mount(view.root);void owner.load();return view;
  }
  private flush(key:string):void {
    const pending = this.saves.get(key);if (!pending) return;clearTimeout(pending.timer);this.saves.delete(key);
    const workspace = this.current();
    if (workspace?.id === pending.workspace && workspace.conversationLayout && paneLeaves(workspace.conversationLayout.root).some(pane=>pane.tabs.some(tab=>workspaceTabKey(tab) === pending.key))) this.save(pending.workspace,pending.key,{...pending.position});
  }
  drain():void {for (const key of this.saves.keys()) this.flush(key);}
  reconcile(workspace:Workspace, tabs:FileTab[],active:FileTab[]):void {
    const open = new Set(tabs.map(tab=>this.key(workspace.id,tab))), shown = new Set(active.map(tab=>this.key(workspace.id,tab)));
    for (const [key,view] of this.views) {
      if (open.has(key)) {if (!shown.has(key)) this.host().place(view.root);continue;}
      this.flush(key);view.owner.dispose();this.host().forget(view.root);view.destroy();this.views.delete(key);this.owners.delete(key);
    }
  }
  attached():void {for (const view of this.views.values()) view.restore();}
  checkpoint(workspace:Workspace):DevFileCheckpoint[] {
    return [...this.views.values()].filter(view=>view.owner.workspace === workspace.id).map(view=> {
      if (!view.owner.source || view.owner.loading || view.owner.error) throw new Error('File content is not ready for an update.');
      return {tab:{...view.owner.tab},position:view.capture(),digest:view.owner.source.revision.digest,focused:document.activeElement === view.scroller};
    });
  }
  private restorePositions(workspace:Workspace,files:DevFileCheckpoint[]):boolean {
    for (const file of files) {
      const view = this.views.get(this.key(workspace.id,file.tab));if (!view) return false;
      view.setPosition(file.position);if (file.focused) view.focus();
    }
    return true;
  }
  async restore(workspace:Workspace,files:DevFileCheckpoint[],current:()=>boolean):Promise<boolean> {
    for (const file of files) {
      if (!workspace.conversationLayout || !paneLeaves(workspace.conversationLayout.root).some(pane=>pane.tabs.some(tab=>workspaceTabKey(tab) === workspaceTabKey(file.tab)))) return false;
      const view = this.view(workspace,file.tab);await view.owner.load();
      if (!current() || view.owner.source?.revision.digest !== file.digest || view.owner.error) return false;
      if (file.focused && (view.root.hidden || view.root.inert)) return false;
    }
    if (!current()) return false;
    return this.restorePositions(workspace,files) && current();
  }
  positions(workspace:Workspace):NonNullable<Workspace['filePositions']> {
    const result = {...workspace.filePositions};
    for (const view of this.views.values()) if (view.owner.workspace === workspace.id) result[workspaceTabKey(view.owner.tab)] = view.capture();
    return result;
  }
}
