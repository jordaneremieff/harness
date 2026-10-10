import type { ConversationLayout, ConversationTab } from '../shared/api.ts';
import { activeTab, closeTab, moveTab, tabKey } from './tabs.ts';

type Hooks = {layout: () => ConversationLayout; change: (layout: ConversationLayout) => void; label: (tab: ConversationTab) => string; status: (tab: ConversationTab) => string};
/** Retained tab nodes preserve keyboard focus through transcript and roster updates. */
export class TabStrip {
  private nodes = new Map<string, HTMLElement>();
  private dragging?: string;
  private root: HTMLElement;
  private hooks: Hooks;
  private observer: ResizeObserver;
  constructor(root: HTMLElement, hooks: Hooks) {
    this.root = root; this.hooks = hooks;
    this.observer = new ResizeObserver(() => this.fitStatuses()); this.observer.observe(root);
  }
  focusActive(): void {
    const tab = activeTab(this.hooks.layout()); if (tab) this.nodes.get(tabKey(tab))?.focus(); else this.root.focus();
  }
  render(): void {
    const layout = this.hooks.layout(); const keys = new Set(layout.tabs.map(tabKey));
    this.root.tabIndex = layout.tabs.length ? -1 : 0;
    const hadFocus = this.root.contains(this.root.ownerDocument.activeElement);
    for (const [key, node] of this.nodes) if (!keys.has(key)) { this.observer.unobserve(node); node.remove(); this.nodes.delete(key); }
    layout.tabs.forEach((tab, index) => {
      const key = tabKey(tab); let node = this.nodes.get(key);
      if (!node) { node = this.create(key); this.nodes.set(key, node); this.observer.observe(node); }
      this.paintTab(node, tab, layout.active === index);
      if (this.root.children[index] !== node) this.root.insertBefore(node, this.root.children[index] ?? null);
    });
    this.fitStatuses();
    if (hadFocus && !this.root.contains(this.root.ownerDocument.activeElement)) this.focusActive();
  }
  private fitStatuses(): void {
    if (!this.root.clientWidth) return;
    this.root.style.setProperty('--tab-share', `${this.root.clientWidth / Math.max(1, this.nodes.size)}px`);
    const states: {node: HTMLElement; state: HTMLElement; label: HTMLElement; close: HTMLElement}[] = [];
    for (const node of this.nodes.values()) {
      const state = node.querySelector<HTMLElement>('.tab-state'); const label = node.querySelector<HTMLElement>('.tab-label'); const close = node.querySelector<HTMLElement>('.tab-close');
      if (!state || !label || !close || !state.textContent) continue;
      state.hidden = false; states.push({node, state, label, close});
    }
    const hidden = states.map(({node, state, label, close}) => {
      const style = getComputedStyle(node);
      const chrome = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) + close.offsetWidth + 2 * Number.parseFloat(style.columnGap);
      const minimum = Number.parseFloat(getComputedStyle(label).minWidth);
      return node.clientWidth < chrome + minimum + state.scrollWidth;
    });
    states.forEach(({state}, index) => { state.hidden = hidden[index] ?? false; });
  }
  private paintTab(node: HTMLElement, tab: ConversationTab, selected: boolean): void {
    const label = this.hooks.label(tab); const status = this.hooks.status(tab);
    node.title = [label, tab.kind === 'agent' ? tab.identity : '', status].filter(Boolean).join(' · ');
    node.setAttribute('aria-label', `${label}${tab.kind === 'agent' && tab.split ? ', split with primary' : ''}${status ? `, ${status}` : ''}`);
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    const caption = node.querySelector('.tab-label'); if (caption) caption.textContent = label;
    const state = node.querySelector<HTMLElement>('.tab-state'); if (state) { state.textContent = status; state.hidden = !status; state.dataset.state = status; }
    node.querySelector('.tab-close')?.setAttribute('aria-label', `Close ${label} tab`);
  }
  private create(key: string): HTMLElement {
    const doc = this.root.ownerDocument; const node = doc.createElement('div'); node.className = 'conversation-tab';
    node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', 'conversation-panes'); node.draggable = true; node.dataset.tabKey = key;
    const label = doc.createElement('span'); label.className = 'tab-label';
    const state = doc.createElement('span'); state.className = 'tab-state';
    const close = doc.createElement('button'); close.className = 'tab-close'; close.type = 'button'; close.textContent = '×'; close.tabIndex = -1;
    const index = (): number => this.hooks.layout().tabs.findIndex(tab => tabKey(tab) === key);
    const activate = (): void => { this.hooks.change({...this.hooks.layout(), active: index()}); };
    close.addEventListener('click', event => { event.stopPropagation(); this.hooks.change(closeTab(this.hooks.layout(), index())); });
    node.addEventListener('click', activate);
    node.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); this.hooks.change(closeTab(this.hooks.layout(), index())); } });
    node.addEventListener('keydown', event => {
      if (event.target === close || event.ctrlKey || event.metaKey || event.isComposing) return;
      const layout = this.hooks.layout(); const current = index();
      const positions: Record<string, number> = {ArrowLeft: Math.max(0, current - 1), ArrowRight: Math.min(layout.tabs.length - 1, current + 1), Home: 0, End: layout.tabs.length - 1};
      const next = positions[event.key];
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.hooks.change(closeTab(layout, current)); this.focusActive(); return; }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); return; }
      else if (next === undefined) return;
      event.preventDefault();
      this.hooks.change(event.altKey && event.shiftKey ? moveTab(layout, current, next) : {...layout, active: next}); this.focusActive();
    });
    node.addEventListener('dragstart', event => { this.dragging = key; event.dataTransfer?.setData('text/plain', key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; node.classList.add('tab-dragging'); });
    node.addEventListener('dragover', event => { if (!this.dragging) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; node.classList.add('tab-drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('tab-drop-target'));
    node.addEventListener('drop', event => {
      if (!this.dragging) return; event.preventDefault(); const layout = this.hooks.layout();
      this.hooks.change(moveTab(layout, layout.tabs.findIndex(tab => tabKey(tab) === this.dragging), index())); this.clearDrag();
    });
    node.addEventListener('dragend', () => this.clearDrag());
    node.append(label, state, close); return node;
  }
  private clearDrag(): void { this.dragging = undefined; for (const node of this.nodes.values()) node.classList.remove('tab-dragging', 'tab-drop-target'); }
}
