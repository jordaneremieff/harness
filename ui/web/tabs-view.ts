import {cardIcon} from './card-icons.ts';
import type {PresentationTone} from './conversation-presentation.ts';
import {statusGlyph} from './dom.ts';
import type { WorkspaceTab as ConversationTab } from '../shared/api.ts';
import { duplicateTabTails, tabKey } from './tabs.ts';
import { paneById, paneForTab, paneLeaves, type PaneLayout } from './pane-layout.ts';

export type TabRegion = {id: string; tabs: HTMLElement; controls: string};
export type TabRegions = {panes: () => TabRegion[]; conversations: HTMLElement};
export type TabHooks = {layout: () => PaneLayout; activate: (pane: string, key: string) => void; close: (key: string) => void;
  move: (key: string, pane: string, index: number) => void; label: (tab: ConversationTab) => string;
  identity?: (tab: ConversationTab) => string | undefined;
  status: (tab: ConversationTab) => {label: string; glyph: string; tone?: PresentationTone}; keep?: (key:string)=>void; overflow?: (overflow: boolean, pane: string) => void};
/** Keyed tab and sidebar nodes follow real pane ownership, independent of target kind. */
export class TabStrip {
  private nodes = new Map<string, HTMLElement>();
  private rows = new Map<string, HTMLButtonElement>();
  private groups = new Map<string, HTMLElement>();
  private hosts = new Map<HTMLElement, () => void>();
  private widths = new Map<HTMLElement, number>();
  private dragging?: string;
  private signature = '';
  private revealPending = false;
  private tails = new Map<string, string>();
  private observer: ResizeObserver;
  private heading: HTMLElement;
  private destroyed = false;
  private hooks: TabHooks;
  private regions: TabRegions;
  constructor(hooks: TabHooks, regions: TabRegions) {
    this.hooks = hooks; this.regions = regions;
    const doc = regions.conversations.ownerDocument; this.heading = doc.createElement('h2'); this.heading.className = 'conversation-heading'; this.heading.textContent = 'TABS';
    regions.conversations.setAttribute('aria-label', 'Tabs'); regions.conversations.append(this.heading);
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
    if (this.destroyed) return;
    const layout = this.hooks.layout(); const panes = paneLeaves(layout.root); const tabs = panes.flatMap(pane => pane.tabs);
    const regions = this.regions.panes(); const signature = JSON.stringify([panes.map(pane => [pane.id, pane.tabs.map(tabKey), pane.active]), layout.focusedPane]);
    const reveal = this.revealPending || signature !== this.signature; this.signature = signature; this.revealPending = false;
    const doc = this.regions.conversations.ownerDocument; const focused = doc.activeElement as HTMLElement | null;
    const hadFocus = [...this.hosts.keys(), this.regions.conversations].some(host => host.contains(focused));
    this.syncHosts(regions);
    this.tails = duplicateTabTails(tabs,this.hooks.label);
    this.pruneNodes(new Set(tabs.map(tabKey)), new Set(panes.map(pane => pane.id)));
    panes.forEach((pane, paneIndex) => {
      const region = regions.find(region => region.id === pane.id); if (!region) throw new Error(`Missing tab region for pane ${pane.id}.`);
      const host = region.tabs; const group = this.group(pane.id); const title = group.querySelector<HTMLElement>('.conversation-group-title'); if (title) {title.textContent = `Pane ${paneIndex + 1}`; title.hidden = panes.length === 1;}
      if (this.regions.conversations.children[paneIndex + 1] !== group) this.regions.conversations.insertBefore(group, this.regions.conversations.children[paneIndex + 1] ?? null);
      const list = group.querySelector<HTMLElement>('.conversation-list'); if (!list) return;
      pane.tabs.forEach((tab, index) => {
        const key = tabKey(tab); let node = this.nodes.get(key); if (!node) {node = this.create(key); this.nodes.set(key, node); this.observer.observe(node);}
        this.paintTab(node, tab, pane.active === key); node.dataset.paneId = pane.id; node.setAttribute('aria-controls', region.controls);
        if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);
        const row = this.conversationRow(tab, region.controls); row.dataset.paneId = pane.id; row.setAttribute('aria-current', String(pane.active === key && layout.focusedPane === pane.id));
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
      });
      host.dataset.sole = String(pane.tabs.length === 1);
      host.tabIndex = pane.tabs.length ? -1 : 0; host.dataset.focused = String(layout.focusedPane === pane.id);
    });
    this.heading.hidden = !tabs.length;
    for (const pane of panes) {const group = this.groups.get(pane.id); if (group) group.hidden = !pane.tabs.length;}
    this.fitStatuses(); if (reveal) this.revealActive();
    if (hadFocus) { if (focused && [...regions.map(region => region.tabs), this.regions.conversations].some(host => host.contains(focused))) focused.focus({preventScroll: true}); else this.focusActive(); }
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
    node.title = [label, tab.kind === 'file' ? tab.path : tab.kind === 'agent' ? tab.identity : '', status.label].filter(Boolean).join(' · ');
    node.setAttribute('aria-label', `${accessible}${status.label ? `, ${status.label}` : ''}`); node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    const caption = node.querySelector('.tab-label'); if (caption) caption.textContent = label;
    this.paintDot(node, status.glyph, status.label, status.tone);
    const identity = node.querySelector<HTMLElement>('.tab-identity'); if (identity) {identity.textContent = tail ?? ''; identity.hidden = !tail;}
    const close = node.querySelector<HTMLElement>('.tab-close'); if (close) {close.setAttribute('aria-label', `Close ${accessible} tab`); close.title = `Close ${accessible} tab`;}
  }
  private tail(tab: ConversationTab): string | undefined {return this.hooks.identity?.(tab) ?? this.tails.get(tab.kind === 'file' ? tabKey(tab) : tab.kind === 'agent' ? tab.identity : 'primary');}
  private paintDot(node: HTMLElement, glyph: string, label: string, tone: PresentationTone = 'secondary'): void {
    const dot = node.querySelector<HTMLElement>('.tab-dot'); if (!dot) return;
    dot.hidden = !glyph;statusGlyph(dot, glyph); dot.dataset.tone = tone; dot.title = label;
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
    node.addEventListener('dragend', () => this.clearDrag()); node.append(label, identity, dot, close); return node;
  }
  private group(id: string): HTMLElement {
    let group = this.groups.get(id); if (group) return group;
    const doc = this.regions.conversations.ownerDocument; group = doc.createElement('div'); group.className = 'conversation-group'; group.dataset.paneId = id;
    const heading = doc.createElement('h3'); heading.className = 'conversation-group-title'; const list = doc.createElement('div'); list.className = 'conversation-list'; group.append(heading, list); this.groups.set(id, group); return group;
  }
  private conversationRow(tab: ConversationTab, controls: string): HTMLButtonElement {
    const key = tabKey(tab); let row = this.rows.get(key);
    if (!row) {const doc = this.regions.conversations.ownerDocument; row = doc.createElement('button'); row.type = 'button'; row.className = 'conversation-row'; row.dataset.tabKey = key;
      for (const name of ['state', 'name', 'identity']) {const span = doc.createElement('span'); span.className = `conversation-${name}`; row.append(span);}
      row.addEventListener('click', () => this.activate(key)); this.rows.set(key, row);}
    const status = this.hooks.status(tab); const label = this.hooks.label(tab); const tail = this.tail(tab);
    row.title = [label, tab.kind === 'file' ? tab.path : tab.kind === 'agent' ? tab.identity : '', status.label].filter(Boolean).join(' · '); row.setAttribute('aria-label', [label, tail, status.label].filter(Boolean).join(', ')); row.setAttribute('aria-controls', controls);
    const state = row.querySelector<HTMLElement>('.conversation-state'); if (state) {statusGlyph(state, status.glyph); state.title = status.label; state.dataset.tone = status.tone ?? 'secondary'; state.setAttribute('aria-hidden', 'true');}
    const caption = row.querySelector<HTMLElement>('.conversation-name'); if (caption) caption.textContent = label;
    const identity = row.querySelector<HTMLElement>('.conversation-identity'); if (identity) {identity.textContent = tail ?? ''; identity.hidden = !tail; identity.title = tab.kind === 'agent' ? `Agent ID: ${tab.identity}` : '';}
    return row;
  }
  private clearDrag(): void {this.dragging = undefined; for (const node of this.nodes.values()) node.classList.remove('tab-dragging', 'tab-drop-target');}
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true; this.observer.disconnect();
    for (const cleanup of this.hosts.values()) cleanup(); for (const node of this.nodes.values()) node.remove(); for (const group of this.groups.values()) group.remove(); this.heading.remove();
    this.hosts.clear(); this.nodes.clear(); this.rows.clear(); this.groups.clear(); this.widths.clear(); this.dragging = undefined;
  }
}
/** Reveal only the local strip; do not scroll ancestors or change editor focus. */
export function revealTabScroll(scroll: number, width: number, left: number, tabWidth: number): number {
  return Math.max(0, left < scroll ? left : left + Math.min(tabWidth, width) > scroll + width ? left + Math.min(tabWidth, width) - width : scroll);
}
