import type {AgentRow, ConversationLayout, Workspace, WorkspaceTab, Target} from '../shared/api.ts';
import {workspaceLayout, tabKey, activeTab} from './tabs.ts';
import {paneLeaves} from './pane-layout.ts';
import type {SelectionChange} from './actions.ts';

type SavedTab = {tab: WorkspaceTab; pane: string; index: number};
/** Fresh-load defaults belong to this page, not the workspace shared with other clients. */
export class WorkspaceEntry {
  private workspaceId?: string;
  private hidden = new Map<string,SavedTab>();
  private primaryFirst = false;
  begin(workspace: Workspace, rows: readonly AgentRow[]): void {
    this.workspaceId=workspace.id;this.hidden.clear();this.primaryFirst=true;
    const agents=new Map(rows.map(row=>[row.identity,row]));
    for(const pane of paneLeaves(workspaceLayout(structuredClone(workspace)).root))pane.tabs.forEach((tab,index)=> {
      if(tab.kind !== 'agent')return;
      const row=agents.get(tab.identity);
      if(row?.availability === 'live' && row.state === 'working')return;
      this.hidden.set(tabKey(tab),{tab:structuredClone(tab),pane:pane.id,index});
    });
  }
  captureReload(workspace:Workspace): {workspaceId:string;hidden:SavedTab[];primaryFirst:boolean} {
    if(workspace.id!==this.workspaceId)return {workspaceId:workspace.id,hidden:[],primaryFirst:false};
    return {workspaceId:workspace.id,hidden:structuredClone([...this.hidden.values()]),primaryFirst:this.primaryFirst};
  }
  restoreReload(value:ReturnType<WorkspaceEntry['captureReload']>):void {
    this.workspaceId=value.workspaceId;this.hidden=new Map(value.hidden.map(saved=>[tabKey(saved.tab),structuredClone(saved)]));this.primaryFirst=value.primaryFirst;
  }
  get count(): number {return this.hidden.size;}
  hiddenAgent(identity:string):boolean {return this.hidden.has(tabKey({kind:'agent',identity}));}
  layout(workspace?: Workspace, primary?: Target): ConversationLayout {
    if(!workspace || workspace.id !== this.workspaceId)return workspaceLayout(workspace);
    const preserved=activeTab(workspaceLayout(workspace))?.kind==='session';
    const selected=this.primaryFirst && primary && !preserved ? primary : workspace.selectedTarget;
    const selectedTarget=selected?.kind === 'agent' && this.hidden.has(tabKey({kind:'agent',identity:selected.identity})) ? undefined : selected;
    const layout=workspaceLayout({...structuredClone(workspace),selectedTarget});
    for(const pane of paneLeaves(layout.root)) {
      pane.tabs=pane.tabs.filter(tab=>!this.hidden.has(tabKey(tab)));
      if(!pane.tabs.some(tab=>tabKey(tab) === pane.active))pane.active=pane.tabs[0]?tabKey(pane.tabs[0]):null;
    }
    return layout;
  }
  view(workspace: Workspace, primary?: Target): Workspace {
    const layout=this.layout(workspace,primary), tab=activeTab(layout);
    const selectedTarget=tab?.kind === 'agent' ? {kind:'agent' as const,identity:tab.identity} : tab?.kind === 'primary' ? primary : undefined;
    return {...workspace,conversationLayout:layout,selectedTarget,panelVisible:selectedTarget?.kind === 'agent'};
  }
  explicit(workspace: Workspace | undefined, change: SelectionChange): void {
    if(workspace?.id !== this.workspaceId)return;
    if(change.selectedTarget !== undefined || change.conversationLayout !== undefined)this.primaryFirst=false;
    if(change.selectedTarget?.kind === 'agent')this.hidden.delete(tabKey({kind:'agent',identity:change.selectedTarget.identity}));
    if(change.conversationLayout)for(const pane of paneLeaves(change.conversationLayout.root))for(const tab of pane.tabs)this.hidden.delete(tabKey(tab));
  }
  /** Saved writes retain tabs omitted only by this page's default presentation. */
  save(workspace: Workspace, change: SelectionChange): SelectionChange {
    this.explicit(workspace,change);
    if(workspace.id !== this.workspaceId || !change.conversationLayout || !this.hidden.size)return change;
    const layout=structuredClone(change.conversationLayout), canonical=workspaceLayout(structuredClone(workspace));
    for(const pane of paneLeaves(canonical.root))pane.tabs.forEach((tab,index)=> {
      if(this.hidden.has(tabKey(tab)))this.insert(layout,{tab,pane:pane.id,index});
    });
    return {...change,conversationLayout:layout};
  }
  reopen(workspace: Workspace, primary?: Target): ConversationLayout {
    const layout=this.layout(workspace,primary);
    for(const saved of this.hidden.values())this.insert(layout,saved);
    this.hidden.clear();this.primaryFirst=false;return layout;
  }
  private insert(layout: ConversationLayout, saved: SavedTab): void {
    const panes=paneLeaves(layout.root);
    if(panes.some(pane=>pane.tabs.some(tab=>tabKey(tab) === tabKey(saved.tab))))return;
    const pane=panes.find(pane=>pane.id === saved.pane) ?? panes[0];if(!pane)return;
    pane.tabs.splice(Math.min(saved.index,pane.tabs.length),0,structuredClone(saved.tab));
    pane.active ??= tabKey(saved.tab);
  }
}
