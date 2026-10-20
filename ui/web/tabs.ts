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
export function duplicateTabTails(tabs:ConversationTab[],label:(tab:ConversationTab)=>string,captions = new ConversationCaptions()):Map<string,string> {
  const agents = tabs.filter((tab):tab is Extract<ConversationTab,{kind:'agent'}>=>tab.kind === 'agent');
  captions.update(agents.map(tab=>({name:label(tab),identity:tab.identity})));
  const tails = new Map<string,string>(agents.flatMap(tab => {const tail = captions.get(tab.identity).tail; return tail ? [[tab.identity,tail]] : [];}));
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
const identityPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?::[2-9]\d*|:1\d+)?$/i;
export function conversationIdentityText(value: string): boolean {return identityPattern.test(value);}
function usefulName(value: string | undefined, identity: string): string | undefined {
  const text = value?.trim(); return text && text !== identity && !conversationIdentityText(text) ? text : undefined;
}
function firstMessageTitle(firstMessage: string | undefined, identity: string): string | undefined {
  const excerpt = usefulName(firstMessage?.slice(0, 162).trim().split(/\r?\n/, 1)[0], identity);
  if (!excerpt) return;
  const points = Array.from(excerpt);
  return points.length > 80 ? `${points.slice(0, 79).join('')}…` : excerpt;
}
export function agentName(name: string | undefined, handle: string | undefined, identity: string, reported?: string, firstMessage?: string): string {
  for (const value of [reported, name, handle]) {const text = usefulName(value, identity); if (text) return text;}
  return firstMessageTitle(firstMessage, identity) ?? 'Unnamed conversation';
}
export type CaptionRow = {identity: string; name?: string; handle?: string; reported?: string; firstMessage?: string; cwd?: string};
export type ConversationCaption = {name: string; tail?: string; source?: 'first-message'};
/** Display qualifiers belong to this browser session, never to routing or persisted identity. */
export class ConversationCaptions {
  private ordinals = new Map<string, number>();
  private nextOrdinal = 1;
  private captions = new Map<string, ConversationCaption>();
  private knownNames = new Map<string, {name: string; provenance: 'reported' | 'supplied' | 'handle'}>();
  revision = 0;
  update(rows: readonly CaptionRow[]): void {
    const previous = this.captions, previousNames = this.knownNames;
    const unique = [...new Map(rows.map(row => [row.identity, row])).values()];
    this.knownNames = new Map();
    for (const row of unique) for (const [value, provenance] of [[row.reported,'reported'],[row.name,'supplied'],[row.handle,'handle']] as const) {
      const name = usefulName(value,row.identity);if(name){this.knownNames.set(row.identity,{name,provenance});break;}
    }
    this.captions = new Map(unique.map(row => [row.identity, {name: agentName(row.name, row.handle, row.identity, row.reported, row.firstMessage),
      ...(![row.reported, row.name, row.handle].some(value => usefulName(value, row.identity)) && firstMessageTitle(row.firstMessage, row.identity) ? {source: 'first-message' as const} : {})}]));
    for (const row of unique) this.deriveChild(row.identity);
    const groups = new Map<string, CaptionRow[]>();
    for (const row of unique) {const name = this.get(row.identity).name, group = groups.get(name) ?? []; group.push(row); groups.set(name, group);}
    for (const group of groups.values()) if (group.length > 1) this.qualify(group);
    this.distinguishComposed();
    if (previous.size !== this.captions.size || [...this.captions].some(([identity, caption]) => {
      const old = previous.get(identity); return old?.name !== caption.name || old?.tail !== caption.tail || old?.source !== caption.source || previousNames.get(identity)?.provenance !== this.knownNames.get(identity)?.provenance;
    })) this.revision++;
  }
  /** A child conversation with no name of its own reads as its parent's name plus its number. */
  private deriveChild(identity: string): void {
    const split = identity.lastIndexOf(':');
    if (split < 0 || this.knownNames.has(identity) || !conversationIdentityText(identity)) return;
    const parent = this.knownNames.get(identity.slice(0, split))?.name;
    if (parent) this.captions.set(identity, {name: `${parent} · ${identity.slice(split + 1)}`});
  }
  private composed(caption: ConversationCaption): string {return caption.tail ? `${caption.name} · ${caption.tail}` : caption.name;}
  private distinguishComposed(): void {
    const groups = new Map<string, string[]>();
    for (const [identity, caption] of this.captions) {const text = this.composed(caption), group = groups.get(text) ?? []; group.push(identity); groups.set(text, group);}
    const occupied = new Set(groups.keys());
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => Number(!!this.get(b).tail) - Number(!!this.get(a).tail) || a.localeCompare(b));
      for (const identity of group.slice(1)) {
        const caption = this.get(identity);
        if (!this.ordinals.has(identity)) this.ordinals.set(identity, this.nextOrdinal++);
        let qualifier = [caption.tail, String(this.ordinals.get(identity))].filter(Boolean).join(' · ');
        while (occupied.has(this.composed({...caption, tail: qualifier}))) qualifier = `Label ${qualifier}`;
        caption.tail = qualifier; occupied.add(this.composed(caption));
      }
    }
  }
  private meaningfulTail(row: CaptionRow, group: CaptionRow[]): string | undefined {
    const handle = usefulName(row.handle, row.identity);
    if (handle && handle !== this.get(row.identity).name && group.filter(peer => usefulName(peer.handle, peer.identity) === handle).length === 1) return handle;
    const parts = row.cwd?.split('/').filter(Boolean) ?? [];
    for (let length = 1; length <= parts.length; length++) {
      const suffix = parts.slice(-length).join('/');
      if (group.filter(peer => peer.cwd?.split('/').filter(Boolean).slice(-length).join('/') === suffix).length === 1) return suffix;
    }
    if (parts.length && group.filter(peer => peer.cwd === row.cwd).length === 1) return `/${parts.join('/')}`;
  }
  private qualify(group: CaptionRow[]): void {
    for (const row of group) this.get(row.identity).tail = this.meaningfulTail(row, group);
    const tails = identityCounts(group.flatMap(row => this.get(row.identity).tail ? [this.get(row.identity).tail as string] : []));
    for (const row of group) {
      const caption = this.get(row.identity);
      if (caption.tail && tails.get(caption.tail) === 1) continue;
      if (!this.ordinals.has(row.identity)) {
        while (tails.has(String(this.nextOrdinal))) this.nextOrdinal++;
        this.ordinals.set(row.identity, this.nextOrdinal++);
      }
      let qualifier = [caption.tail, String(this.ordinals.get(row.identity))].filter(Boolean).join(' · ');
      while (tails.has(qualifier)) qualifier = `Label ${qualifier}`;
      caption.tail = qualifier; tails.set(qualifier, 1);
    }
  }
  knownName(identity: string): {name: string; provenance: 'reported' | 'supplied' | 'handle'} | undefined {return this.knownNames.get(identity);}
  get(identity: string): ConversationCaption {return this.captions.get(identity) ?? {name: 'Unnamed conversation'};}
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
export function duplicateIdentityTails(rows: NamedIdentity[]): Map<string, string> {return identityTails(rows);}
/** Standalone consumers use the same caption rules; app consumers share one session allocator. */
export function agentIdentityTails(rows: NamedIdentity[]): Map<string, string> {
  const captions = new ConversationCaptions(); captions.update(rows);
  return new Map(rows.flatMap(row => {const tail = captions.get(row.identity).tail; return tail ? [[row.identity, tail]] : [];}));
}
function identityTails(rows: NamedIdentity[]): Map<string, string> {
  const groups=new Map<string,Set<string>>(),labels=new Map<string,string>();
  for(const {name,identity} of rows){const group=groups.get(name)??new Set<string>();group.add(identity);groups.set(name,group);}
  for(const identities of groups.values())if(identities.size>1)identityGroup([...identities],labels);
  return labels;
}
