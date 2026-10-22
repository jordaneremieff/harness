import {cardIcon} from './card-icons.ts';
import type {PresentationTone} from './conversation-presentation.ts';
import type {Attention} from './attention.ts';
import type { WorkspaceTab as ConversationTab } from '../shared/api.ts';
import { ConversationCaptions, duplicateTabTails, tabKey } from './tabs.ts';
import { paneById, paneForTab, paneLeaves, type PaneLayout } from './pane-layout.ts';

export type TabRegion = {id: string; tabs: HTMLElement; controls: string};
export type TabRegions = {panes: () => TabRegion[]; conversations: HTMLElement};
export type TabHooks = {layout: () => PaneLayout; reopen?: () => {count: number; drafts?: number; run: () => void} | undefined; activate: (pane: string, key: string) => void; close: (key: string) => void;
  move: (key: string, pane: string, index: number) => void; label: (tab: ConversationTab) => string;
  identity?: (tab: ConversationTab) => string | undefined;unnamed?:(tab:ConversationTab)=>boolean;
  fallback?:()=>HTMLElement|undefined;
  status: (tab: ConversationTab) => {label: string; rowLabel?: string; glyph: string; tone?: PresentationTone; attention?: Attention; word?: string}; section?: {collapsed(): boolean; toggle(): void}; keep?: (key:string)=>void; overflow?: (overflow: boolean, pane: string) => void};
/** Keyed tab and sidebar nodes follow real pane ownership, independent of target kind. */
export class TabStrip {
  private nodes = new Map<string, HTMLElement>();
  private rows = new Map<string, HTMLElement>();
  private groups = new Map<string, HTMLElement>();
  private hosts = new Map<HTMLElement, () => void>();
  private widths = new Map<HTMLElement, number>();
  private dragging?: string;
  private signature = '';
  private revealPending = false;
  private tails = new Map<string, string>();
  private captions = new ConversationCaptions();
  private observer: ResizeObserver;
  private heading: HTMLElement;
  private sectionBody: HTMLElement;
  private fallback?:HTMLElement;
  private sectionToggle: HTMLButtonElement;
  private count: HTMLElement;
  private attention: HTMLElement;
  private reopenRow?: HTMLButtonElement;
  private destroyed = false;
  private hooks: TabHooks;
  private regions: TabRegions;
  constructor(hooks: TabHooks, regions: TabRegions) {
    this.hooks = hooks; this.regions = regions;
    const doc = regions.conversations.ownerDocument;
    this.heading = doc.createElement('div'); this.heading.className = 'nav-heading-row';
    const label = doc.createElement('h2'); label.className = 'nav-heading';
    this.sectionToggle = doc.createElement('button'); this.sectionToggle.id = 'tabs-heading'; this.sectionToggle.className = 'section-toggle'; this.sectionToggle.type = 'button'; this.sectionToggle.textContent = 'TABS';
    this.sectionToggle.setAttribute('aria-label', 'Open tabs'); this.sectionToggle.setAttribute('aria-controls', 'tabs-section-body'); this.sectionToggle.setAttribute('aria-expanded', 'true');
    this.count = doc.createElement('span'); this.count.className = 'count'; this.count.hidden = true;
    this.attention = doc.createElement('span'); this.attention.className = 'tabs-attention'; this.attention.hidden = true;
    this.sectionToggle.append(this.count, this.attention); this.sectionToggle.addEventListener('click', () => this.hooks.section?.toggle()); label.append(this.sectionToggle); this.heading.append(label);
    this.sectionBody = doc.createElement('div'); this.sectionBody.id = 'tabs-section-body'; this.sectionBody.className = 'section-body';
    regions.conversations.setAttribute('aria-label', 'Open tabs'); regions.conversations.append(this.heading, this.sectionBody);
    this.observer = new ResizeObserver(() => {
      if (this.destroyed) return;
      this.fitStatuses();
      for (const region of this.regions.panes()) { const width = region.tabs.clientWidth; if (width > 0 && width < (this.widths.get(region.tabs) ?? 0)) this.revealActive(region.id); this.widths.set(region.tabs, width); }
    });
  }
  private owner(key: string): string | undefined { return paneForTab(this.hooks.layout(), key)?.id; }
  private region(id: string): TabRegion | undefined { return this.regions.panes().find(region => region.id === id); }
  private activate(key: string): void { const pane = this.owner(key); if (!pane) return; this.requestReveal(); this.hooks.activate(pane, key); }
  requestReveal(): void { this.revealPending = true; }
  step(id: string, direction: -1 | 1): void {
    const pane = paneById(this.hooks.layout(), id); if (!pane) return;
    const index = pane.tabs.findIndex(tab => tabKey(tab) === pane.active); if (index < 0) return;
    const tab = pane.tabs[index + direction]; if (!tab) return;
    this.activate(tabKey(tab)); this.focusActive(id);
  }
  revealActive(id = this.hooks.layout().focusedPane): void {
    const pane = paneById(this.hooks.layout(), id); const host = this.region(id)?.tabs; const node = pane?.active ? this.nodes.get(pane.active) : undefined;
    if (!host?.clientWidth || !node) return;
    const left = node.getBoundingClientRect().left - host.getBoundingClientRect().left + host.scrollLeft;
    host.scrollLeft = revealTabScroll(host.scrollLeft, host.clientWidth, left, node.offsetWidth);
  }
  focusActive(id = this.hooks.layout().focusedPane): void {
    const pane = paneById(this.hooks.layout(), id); const node = pane?.active ? this.nodes.get(pane.active) : undefined;
    (node ?? this.region(id)?.tabs)?.focus({preventScroll: true});
  }
  render(): void {
    try {
    if (this.destroyed) return;
    const layout = this.hooks.layout(); const panes = paneLeaves(layout.root); const tabs = panes.flatMap(pane => pane.tabs);
    const regions = this.regions.panes(); const signature = JSON.stringify([panes.map(pane => [pane.id, pane.tabs.map(tabKey), pane.active]), layout.focusedPane]);
    const reveal = this.revealPending || signature !== this.signature; this.signature = signature; this.revealPending = false;
    const doc = this.regions.conversations.ownerDocument; const focused = doc.activeElement as HTMLElement | null;
    const hadFocus = [...this.hosts.keys(), this.regions.conversations].some(host => host.contains(focused));
    this.syncHosts(regions);
    this.tails = duplicateTabTails(tabs,this.hooks.label,this.captions);
    this.pruneNodes(new Set(tabs.map(tabKey)), new Set(panes.map(pane => pane.id)));
    panes.forEach((pane, paneIndex) => {
      const region = regions.find(region => region.id === pane.id); if (!region) throw new Error(`Missing tab region for pane ${pane.id}.`);
      const host = region.tabs; const group = this.group(pane.id); const title = group.querySelector<HTMLElement>('.conversation-group-title'); if (title) {title.textContent = `Pane ${paneIndex + 1}`; title.hidden = panes.length === 1;}
      if (this.sectionBody.children[paneIndex] !== group) this.sectionBody.insertBefore(group, this.sectionBody.children[paneIndex] ?? null);
      const list = group.querySelector<HTMLElement>('.conversation-list'); if (!list) return;
      pane.tabs.forEach((tab, index) => {
        const key = tabKey(tab); let node = this.nodes.get(key); if (!node) {node = this.create(key); this.nodes.set(key, node); this.observer.observe(node);}
        this.paintTab(node, tab, pane.active === key); node.dataset.paneId = pane.id; node.setAttribute('aria-controls', region.controls);
        if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);

      });
      this.sidebarRows(list,pane.id,pane.tabs,pane.active,layout.focusedPane===pane.id,region.controls);
      host.dataset.sole = String(pane.tabs.length === 1);
      host.tabIndex = pane.tabs.length ? -1 : 0; host.dataset.focused = String(layout.focusedPane === pane.id);
    });
    this.renderSection(tabs,this.paintFallback());this.renderReopen();
    for (const pane of panes) {const group = this.groups.get(pane.id); if (group) group.hidden = !pane.tabs.length;}
    this.fitStatuses(); if (reveal) this.revealActive();
    if (hadFocus) { if (focused && [...regions.map(region => region.tabs), this.regions.conversations].some(host => host.contains(focused))) focused.focus({preventScroll: true}); else this.focusActive(); }
    } catch (error) {try {window.reportClientError?.('Open tabs',error);} catch {} throw error;}
  }
  private paintFallback():boolean {
    const fallback=this.hooks.fallback?.();
    if(this.fallback&&this.fallback!==fallback)this.fallback.hidden=true;this.fallback=fallback;
    if(fallback){fallback.hidden=false;this.sectionBody.prepend(fallback);}return !!fallback;
  }
  private renderReopen(): void {
    const action=this.hooks.reopen?.();
    if(!action?.count){if(this.reopenRow)this.reopenRow.hidden=true;return;}
    if(!this.reopenRow){
      const row=this.regions.conversations.ownerDocument.createElement('button');row.type='button';row.className='conversation-row conversation-reopen';
      row.addEventListener('click',()=>this.hooks.reopen?.()?.run());this.reopenRow=row;
    }
    this.reopenRow.textContent=`Reopen ${action.count} older tabs${action.drafts ? ` · ${action.drafts} with drafts` : ''}`;this.reopenRow.hidden=false;this.sectionBody.append(this.reopenRow);
  }
  private renderSection(tabs: readonly ConversationTab[], fallback=false): void {
    const collapsed = this.hooks.section?.collapsed() === true;
    this.sectionBody.hidden = collapsed; this.sectionToggle.setAttribute('aria-expanded', String(!collapsed));
    this.regions.conversations.dataset.collapsed = String(collapsed);
    this.count.textContent = String(tabs.length+Number(fallback)); this.count.hidden = !collapsed;
    const needs = tabs.flatMap(tab => {const attention = this.hooks.status(tab).attention; return attention ? [attention] : [];});
    this.attention.textContent = needs.length ? ` · ${needs.length} ${needs.length === 1 ? 'needs' : 'need'} you` : '';
    this.attention.hidden = !collapsed || !needs.length; this.attention.dataset.tone = needs.some(item => item.tone === 'error') ? 'error' : 'warning';
  }
  private pruneNodes(keys: Set<string>, paneIds: Set<string>): void {
    for (const [key, node] of this.nodes) if (!keys.has(key)) {this.observer.unobserve(node); node.remove(); this.nodes.delete(key); this.rows.get(key)?.remove(); this.rows.delete(key); if (this.dragging === key) this.clearDrag();}
    for (const [id, group] of this.groups) if (!paneIds.has(id)) {group.remove(); this.groups.delete(id);}
  }
  private syncHosts(regions: TabRegion[]): void {
    for (const [host, cleanup] of this.hosts) if (!regions.some(region => region.tabs === host)) {cleanup(); this.observer.unobserve(host); this.hosts.delete(host); this.widths.delete(host);}
    for (const region of regions) if (!this.hosts.has(region.tabs)) {
      const host = region.tabs; host.setAttribute('role', 'tablist'); host.setAttribute('aria-label', 'Tabs');
      const over = (event: DragEvent) => {if (this.dragging && this.owner(this.dragging)) {event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';}};
      const drop = (event: DragEvent) => {if (!this.dragging || !this.owner(this.dragging)) return; event.preventDefault(); this.hooks.move(this.dragging, region.id, paneById(this.hooks.layout(), region.id)?.tabs.length ?? 0); this.clearDrag();};
      host.addEventListener('dragover', over); host.addEventListener('drop', drop);
      this.hosts.set(host, () => {host.removeEventListener('dragover', over); host.removeEventListener('drop', drop);}); this.observer.observe(host);
    }
  }
  private fitStatuses(): void {
    for (const {id, tabs: host} of this.regions.panes()) {
      const nodes = [...this.nodes.values()].filter(node => host.contains(node));
      if (host.clientWidth) for (const node of nodes) this.fitStatus(node);
      this.hooks.overflow?.(host.clientWidth > 0 && host.scrollWidth > host.clientWidth + 1, id);
    }
  }
  private fitStatus(node: HTMLElement): void {
    const identity = node.querySelector<HTMLElement>('.tab-identity');
    const tail = identity && !identity.hidden ? identity.offsetWidth + Number.parseFloat(getComputedStyle(node).columnGap) : 0;
    node.style.setProperty('--tab-identity-width', `${tail}px`);
  }
  private paintTab(node: HTMLElement, tab: ConversationTab, selected: boolean): void {
    const label = this.hooks.label(tab); const tail = this.tail(tab); const accessible = tail ? `${label}, ${tail}` : label; const status = this.hooks.status(tab);
    const statusLabel=this.paintSessionState(node,status.word,status.label);
    node.title = [label, tab.kind === 'file' ? tab.path : tab.kind === 'agent' ? tab.identity : '', statusLabel].filter(Boolean).join(' · ');
    node.setAttribute('aria-label', `${accessible}${statusLabel ? `, ${statusLabel}` : ''}`); node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    const compact=!selected&&this.hooks.unnamed?.(tab)===true;node.dataset.unnamed=String(compact);
    const caption = node.querySelector('.tab-label'); if (caption) caption.textContent = this.tabCaption(label,tail,compact);
    this.paintDot(node, status.glyph, status.label, status.attention?.tone ?? status.tone, status.attention);
    const identity = node.querySelector<HTMLElement>('.tab-identity'); if (identity) {identity.textContent = tail ?? ''; identity.hidden = compact||!tail;}
    const close = node.querySelector<HTMLElement>('.tab-close'); if (close) {close.hidden=tab.kind==='session';close.setAttribute('aria-label', `Close ${accessible} tab`); close.title = `Close ${accessible} tab`;}
  }
  private paintSessionState(node:HTMLElement,word:string|undefined,label:string):string {
    const state=node.querySelector<HTMLElement>('.tab-session-state');if(state){state.textContent=word??'';state.hidden=!word;}
    return word&&word!==label.toLowerCase()?[word,label].filter(Boolean).join(' · '):label;
  }
  private tabCaption(label:string,tail:string|undefined,compact:boolean):string{
    if(!compact)return label;return `Unnamed${tail?` · ${tail}`:''}`;
  }
  private tail(tab: ConversationTab): string | undefined {return this.hooks.identity?.(tab) ?? this.tails.get(tab.kind === 'file' ? tabKey(tab) : tab.kind === 'agent' ? tab.identity : 'primary');}
  private paintDot(node: HTMLElement, glyph: string, label: string, tone: PresentationTone = 'secondary', attention?: Attention): void {
    const dot = node.querySelector<HTMLElement>('.tab-dot'); if (!dot) return;
    const text = attention?.label ?? (glyph === '•' || tone === 'info' || tone === 'error' ? '•' : '');
    dot.hidden = !text; dot.textContent = text; dot.dataset.tone = tone; dot.title = label;
  }
  private navigate(key: string, event: KeyboardEvent): void {
    const pane = paneForTab(this.hooks.layout(), key); if (!pane) return;
    const index = pane.tabs.findIndex(tab => tabKey(tab) === key);
    const positions: Record<string, number> = {ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(pane.tabs.length - 1, index + 1), Home: 0, End: pane.tabs.length - 1};
    const next = positions[event.key]; const tab = next === undefined ? undefined : pane.tabs[next]; if (!tab) return;
    event.preventDefault(); if (event.altKey && event.shiftKey) this.hooks.move(key, pane.id, next as number); else this.activate(tabKey(tab));
    this.focusActive(pane.id);
  }
  private create(key: string): HTMLElement {
    const doc = this.regions.conversations.ownerDocument; const node = doc.createElement('div'); node.className = 'conversation-tab'; node.setAttribute('role', 'tab'); node.draggable = true; node.dataset.tabKey = key;
    const dot = doc.createElement('span'); dot.className = 'tab-dot'; dot.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span'); label.className = 'tab-label'; const identity = doc.createElement('span'); identity.className = 'tab-identity';
    const close = doc.createElement('button'); close.className = 'tab-close'; close.type = 'button'; close.append(cardIcon('close', doc)); close.tabIndex = -1;
    const remove = () => {if (this.owner(key)) this.hooks.close(key);};
    close.addEventListener('click', event => {event.stopPropagation(); remove();}); node.addEventListener('click', () => this.activate(key));node.addEventListener('dblclick',()=>this.hooks.keep?.(key));
    node.addEventListener('auxclick', event => {if (event.button === 1) {event.preventDefault(); remove();}});
    node.addEventListener('keydown', event => {
      if (event.target === close || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault(); remove(); this.focusActive();}
      else if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); if (!event.repeat) this.activate(key);}
      else this.navigate(key, event);
    });
    node.addEventListener('dragstart', event => {this.dragging = key; event.dataTransfer?.setData('text/plain', key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; node.classList.add('tab-dragging');});
    node.addEventListener('dragover', event => {if (!this.dragging || !this.owner(this.dragging)) return; event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; node.classList.add('tab-drop-target');});
    node.addEventListener('dragleave', () => node.classList.remove('tab-drop-target'));
    node.addEventListener('drop', event => {const pane = paneForTab(this.hooks.layout(), key); if (!pane || !this.dragging || !this.owner(this.dragging)) return; event.preventDefault(); event.stopPropagation(); this.hooks.move(this.dragging, pane.id, pane.tabs.findIndex(tab => tabKey(tab) === key)); this.clearDrag();});
    const word=doc.createElement('span');word.className='tab-session-state';word.setAttribute('aria-hidden','true');word.hidden=true;
    node.addEventListener('dragend', () => this.clearDrag()); node.append(label, identity, word, dot, close); return node;
  }
  private group(id: string): HTMLElement {
    let group = this.groups.get(id); if (group) return group;
    const doc = this.regions.conversations.ownerDocument; group = doc.createElement('div'); group.className = 'conversation-group'; group.dataset.paneId = id;
    const heading = doc.createElement('h3'); heading.className = 'conversation-group-title'; const list = doc.createElement('div'); list.className = 'conversation-list'; group.append(heading, list); this.groups.set(id, group); return group;
  }
  private sidebarRows(list:HTMLElement,pane:string,tabs:readonly ConversationTab[],active:string|null,focused:boolean,controls:string):void{
    const rows = tabs.map(tab => {const key=tabKey(tab),row=this.conversationRow(tab,controls);row.dataset.paneId=pane;row.setAttribute('aria-current',String(key===active&&focused)); return row;});
    this.placeSidebarRows(list,rows);
  }
  private placeSidebarRows(parent:HTMLElement,nodes:readonly HTMLElement[]):void{
    nodes.forEach((node,at)=>{if(parent.children[at]!==node)parent.insertBefore(node,parent.children[at]??null);});
    const wanted=new Set<Element>(nodes);for(const node of [...parent.children])if(!wanted.has(node))node.remove();
  }
  private conversationRow(tab: ConversationTab, controls: string): HTMLElement {
    const key = tabKey(tab); let row = this.rows.get(key);
    if (!row) {row = this.createConversationRow(key); this.rows.set(key, row);}
    const status = this.hooks.status(tab); const label = this.hooks.label(tab); const tail = this.tail(tab), word = status.rowLabel ?? status.label;
    row.dataset.kind = tab.kind;
    row.title = [label, status.attention?.title ? `${word}: ${status.attention.title}` : word, tab.kind === 'file' ? tab.path : tab.kind === 'agent' ? tab.identity : ''].filter(Boolean).join('\n'); row.setAttribute('aria-label', [label, tail, word].filter(Boolean).join(', ')); row.setAttribute('aria-controls', controls);
    const state = row.querySelector<HTMLElement>('.conversation-state'); if (state) {state.textContent = word; state.hidden = !word; state.title = status.attention?.title ?? word; state.dataset.tone = status.attention?.tone ?? status.tone ?? 'secondary'; state.setAttribute('aria-hidden', 'true');}
    const caption = row.querySelector<HTMLElement>('.conversation-name'); if (caption) caption.textContent = label;
    const identity = row.querySelector<HTMLElement>('.conversation-identity'); if (identity) {identity.textContent = tail ?? ''; identity.hidden = !tail; identity.title = tab.kind === 'agent' ? `Agent ID: ${tab.identity}` : '';}
    const close = row.querySelector<HTMLElement>('.conversation-row-close'); if (close) {close.hidden=tab.kind==='session';close.setAttribute('aria-label', `Close ${label} tab`); close.title = `Close ${label} tab`;}
    return row;
  }
  private createConversationRow(key: string): HTMLElement {
    const doc = this.regions.conversations.ownerDocument, row = doc.createElement('div'); row.className = 'conversation-row'; row.dataset.tabKey = key; row.tabIndex = 0; row.setAttribute('role', 'button');
    for (const name of ['name', 'identity', 'state']) {const span = doc.createElement('span'); span.className = `conversation-${name}`; row.append(span);}
    const close = doc.createElement('button'); close.type = 'button'; close.className = 'conversation-row-close'; close.append(cardIcon('close', doc));
    const remove = () => {if (this.owner(key)) this.hooks.close(key);};
    close.addEventListener('click', event => {event.stopPropagation(); remove();}); row.append(close);
    row.addEventListener('click', () => this.activate(key));
    row.addEventListener('keydown', event => {
      if (event.target === close || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault(); remove(); this.focusActive();}
      else if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); if (!event.repeat) this.activate(key);}
    }); return row;
  }
  private clearDrag(): void {this.dragging = undefined; for (const node of this.nodes.values()) node.classList.remove('tab-dragging', 'tab-drop-target');}
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true; this.observer.disconnect();
    for (const cleanup of this.hosts.values()) cleanup(); for (const node of this.nodes.values()) node.remove(); for (const group of this.groups.values()) group.remove(); this.heading.remove(); this.sectionBody.remove();
    this.hosts.clear(); this.nodes.clear(); this.rows.clear(); this.groups.clear(); this.widths.clear(); this.dragging = undefined;
  }
}
/** Reveal only the local strip; do not scroll ancestors or change editor focus. */
export function revealTabScroll(scroll: number, width: number, left: number, tabWidth: number): number {
  return Math.max(0, left < scroll ? left : left + Math.min(tabWidth, width) > scroll + width ? left + Math.min(tabWidth, width) - width : scroll);
}
