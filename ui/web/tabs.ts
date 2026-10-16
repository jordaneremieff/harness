import { LIMITS, workspaceTabKey, type ConversationLayout, type WorkspaceTab as ConversationTab, type Target, type Workspace } from '../shared/api.ts';
import {movedFileKey,type FileMove} from './file-identity.ts';
import { activatePaneTab, closePaneTab, createPaneLayout, openPaneTab, paneById, paneForTab } from './pane-layout.ts';

export const MAX_TABS = LIMITS.conversationTabs;
export const tabKey = workspaceTabKey;
export function activeTab(layout: ConversationLayout): ConversationTab | undefined {
  const pane = paneById(layout, layout.focusedPane); return pane?.tabs.find(tab => tabKey(tab) === pane.active);
}
export function tabForTarget(target: Target): ConversationTab { return target.kind === 'primary' ? {kind: 'primary'} : {kind: 'agent', identity: target.identity}; }
export function openTab(layout: ConversationLayout, tab: ConversationTab): ConversationLayout { return openPaneTab(layout, layout.focusedPane, tab); }
export function closeTab(layout: ConversationLayout, key: string): ConversationLayout { return closePaneTab(layout, key); }
export function workspaceLayout(workspace?: Workspace): ConversationLayout {
  let layout = workspace?.conversationLayout ?? createPaneLayout(workspace?.primaryKey ? [{kind: 'primary'}] : []);
  if (!workspace?.primaryKey) layout = closePaneTab(layout, 'primary');
  const target = workspace?.selectedTarget;
  if (!target || activeTab(layout)?.kind === 'file' || target.kind === 'primary' && !workspace?.primaryKey) return layout;
  const tab = tabForTarget(target); const key = tabKey(tab); const owner = paneForTab(layout, key);
  return owner ? activatePaneTab(layout, owner.id, key) : openTab(layout, tab);
}
export function switchTab(layout: ConversationLayout, direction: number): ConversationLayout {
  const pane = paneById(layout, layout.focusedPane); if (!pane?.tabs.length || !Number.isInteger(direction)) return layout;
  const current = pane.tabs.findIndex(tab => tabKey(tab) === pane.active);
  const index = ((Math.max(0, current) + direction) % pane.tabs.length + pane.tabs.length) % pane.tabs.length;
  const tab = pane.tabs[index]; return tab ? activatePaneTab(layout, pane.id, tabKey(tab)) : layout;
}
export function layoutTarget(layout: ConversationLayout, primary?: Target): Target | null {
  const tab = activeTab(layout);
  return !tab || tab.kind === 'file' ? null : tab.kind === 'primary' ? primary ?? null : {kind: 'agent', identity: tab.identity};
}

/** Plain browse replacement is local and never inferred from restored tabs. */
export class FileBrowseState {
  private transient = new Map<string,string>();
  keep(key:string):void {for (const [pane,current] of this.transient) if (current === key) this.transient.delete(pane);}
  hold():void {this.transient.clear();}
  remap(move:FileMove):void {for (const [pane,key] of this.transient) this.transient.set(pane,movedFileKey(key,move));}
  choose(layout:ConversationLayout,tab:Extract<ConversationTab,{kind:'file'}>,modified:(key:string)=>boolean):ConversationLayout {
    const key = tabKey(tab), existing = paneForTab(layout,key);if (existing) return activatePaneTab(layout,existing.id,key);
    const pane = layout.focusedPane, previous = this.transient.get(pane);
    const next = previous && paneForTab(layout,previous)?.id === pane && !modified(previous) ? closePaneTab(layout,previous) : layout;
    this.transient.set(pane,key);return openPaneTab(next,pane,tab);
  }
}
export function duplicateTabTails(tabs:ConversationTab[],label:(tab:ConversationTab)=>string):Map<string,string> {
  const tails = agentIdentityTails(tabs.filter((tab):tab is Extract<ConversationTab,{kind:'agent'}>=>tab.kind === 'agent').map(tab=>({name:label(tab),identity:tab.identity})));
  for (const tab of tabs) {
    if (tab.kind !== 'file') continue;
    const peers = tabs.filter((peer):peer is Extract<ConversationTab,{kind:'file'}>=>peer.kind === 'file' && label(peer) === label(tab));
    if (peers.length < 2) continue;
    const parts = tab.path.split('/').slice(0,-1);let suffix = parts.join('/') || '/';
    for (let length = 1;length <= parts.length;length++) {
      const candidate = parts.slice(-length).join('/');
      if (peers.filter(peer=>peer.path.split('/').slice(0,-1).slice(-length).join('/') === candidate).length === 1) {suffix = candidate;break;}
    }
    const roots = [...new Set(peers.filter(peer=>peer.path === tab.path).map(peer=>peer.rootId))];
    if (roots.length > 1) {
      const rootTails = duplicateIdentityTails(roots.map(identity=>({name:'',identity})));
      suffix += ` · ${rootTails.get(tab.rootId) ?? tab.rootId}`;
    }
    tails.set(tabKey(tab),suffix);
  }
  return tails;
}
export function agentName(name: string | undefined, handle: string | undefined, identity: string, reported?: string): string {
  return [reported, name, handle].find(value => !!value?.trim() && value.trim() !== identity) ?? 'Agent';
}
function storageTail(identity: string, length: number): string {
  const colon = identity.lastIndexOf(':');
  return colon < 0 ? identity.slice(-length) : `${identity.slice(0, colon).slice(-length)}${identity.slice(colon)}`;
}
function identityCounts(values: string[]): Map<string, number> {
  const counts=new Map<string,number>();for(const value of values)counts.set(value,(counts.get(value)??0)+1);return counts;
}
function extendIdentityTails(group: string[], preferred: Set<string>, lengths: Map<string,number>, labels: Map<string,string>): boolean {
  const counts=identityCounts(group.map(identity=>labels.get(identity)??identity));
  const collisions=group.filter(identity=>(counts.get(labels.get(identity)??identity)??0)>1);
  for(const identity of collisions)if(!preferred.has(identity)){const length=(lengths.get(identity)??4)+1;lengths.set(identity,length);labels.set(identity,storageTail(identity,length));}
  return collisions.length>0;
}
function identityGroup(group: string[], labels: Map<string,string>): void {
  const conversations=identityCounts(group.filter(identity=>identity.includes(':')).map(identity=>identity.slice(identity.lastIndexOf(':')+1)));
  const preferred=new Set(group.filter(identity=>identity.includes(':')&&conversations.get(identity.slice(identity.lastIndexOf(':')+1))===1));
  const lengths=new Map(group.map(identity=>[identity,4]));
  for(const identity of group)labels.set(identity,preferred.has(identity)?identity.slice(identity.lastIndexOf(':')+1):storageTail(identity,4));
  const bound=group.reduce((maximum,identity)=>Math.max(maximum,identity.length),0)+1;
  for(let pass=0;pass<bound;pass++)if(!extendIdentityTails(group,preferred,lengths,labels))return;
  for(const identity of group)labels.set(identity,identity);
}
type NamedIdentity = {name: string; identity: string};
/** Generic captions keep their supplied names; only duplicate captions need tails. */
export function duplicateIdentityTails(rows: NamedIdentity[]): Map<string, string> {return identityTails(rows, false);}
/** Agent captions reject identity fallbacks and keep unnamed singleton suffixes. */
export function agentIdentityTails(rows: NamedIdentity[]): Map<string, string> {
  return identityTails(rows.map(row=>({...row,name:agentName(row.name,undefined,row.identity)})), true);
}
function identityTails(rows: NamedIdentity[], agents: boolean): Map<string, string> {
  const groups=new Map<string,Set<string>>(),labels=new Map<string,string>();
  for(const {name,identity} of rows){const group=groups.get(name)??new Set<string>();group.add(identity);groups.set(name,group);}
  for(const [name,identities]of groups)if(identities.size>1||agents&&name==='Agent')identityGroup([...identities],labels);
  return labels;
}
