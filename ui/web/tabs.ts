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
  const tails = duplicateIdentityTails(tabs.filter(tab=>tab.kind !== 'file').map(tab=>({name:label(tab),identity:tab.kind === 'agent' ? tab.identity : 'primary'})));
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
function agentTail(identity: string, counts: Map<string, number>[], conversations: Map<string, number>): string {
  const colon = identity.lastIndexOf(':');
  if (colon >= 0 && colon < identity.length - 1 && conversations.get(identity.slice(colon + 1)) === 1) return identity.slice(colon + 1);
  const index = counts.findIndex((values, index) => values.get(identity.slice(-(index + 4))) === 1);
  return index < 0 ? identity : identity.slice(-(index + 4));
}
export function duplicateIdentityTails(rows: {name: string; identity: string}[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const row of rows) { const name = row.name; const group = groups.get(name) ?? []; group.push(row.identity); groups.set(name, group); }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const conversations = new Map<string, number>();
    for (const identity of group) { const tail = identity.slice(identity.lastIndexOf(':') + 1); conversations.set(tail, (conversations.get(tail) ?? 0) + 1); }
    const counts = Array.from({length: 5}, (_, index) => {
      const values = new Map<string, number>();
      for (const identity of group) { const tail = identity.slice(-(index + 4)); values.set(tail, (values.get(tail) ?? 0) + 1); }
      return values;
    });
    for (const identity of group) labels.set(identity, agentTail(identity, counts, conversations));
  }
  return labels;
}
