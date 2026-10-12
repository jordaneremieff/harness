import {cardIcon} from './card-icons.ts';
import { announce, button, element } from './dom.ts';
import { tabKey } from './tabs.ts';
import { canSplitPane, closePane, MAX_PANES, movePaneTab, paneById, paneLeaves, type PaneAxis, type PaneLayout, type PaneSpace, type PaneView } from './pane-layout.ts';

export type ContextItem = {key?: string; label: string; run: () => void; enabled?: boolean; checked?: boolean; checkbox?: boolean; description?: string; disabledReason?: string; separatorBefore?: boolean; heading?: string};
function itemRole(item: ContextItem): string { return item.checked === undefined ? 'menuitem' : item.checkbox ? 'menuitemcheckbox' : 'menuitemradio'; }
export type MenuPoint = {x: number; y: number};
export function menuPosition(point: MenuPoint, size: {width: number; height: number}, viewport: {width: number; height: number}): MenuPoint {
  return {x: Math.max(4, Math.min(point.x, viewport.width - size.width - 4)), y: Math.max(4, Math.min(point.y, viewport.height - size.height - 4))};
}
export function nativeEditingTarget(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
/** One popup owns menu navigation and dismissal; callers retain the action's exact target. */
export class ContextMenu {
  private node?: HTMLElement;
  private restore?: HTMLElement;
  private cleanup?: () => void;
  private trigger?: HTMLElement;
  private rows: HTMLElement[] = [];
  private items: ContextItem[] = [];
  get openNow(): boolean { return !!this.node; }
  owns(origin: HTMLElement): boolean { return !!this.node && this.trigger === origin; }
  open(origin: HTMLElement, point: MenuPoint, label: string, items: ContextItem[], valid: () => boolean = () => true): void {
    const previous = this.trigger === origin ? this.rows.indexOf(origin.ownerDocument.activeElement as HTMLElement) : -1;
    const choice = this.items[previous];
    const restore = previous >= 0 ? this.restore : undefined;
    this.close(false); if (!items.length) return;
    const doc = origin.ownerDocument; const view = doc.defaultView; if (!view) return;
    const active = doc.activeElement as HTMLElement | null;
    this.restore = restore ?? (active && origin.contains(active) ? active : origin);
    if (origin.getAttribute?.('aria-haspopup') === 'menu') { this.trigger = origin; origin.setAttribute('aria-expanded', 'true'); }
    const menu = element('div', 'context-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
    this.node = menu;
    const rows = items.map(item => {
      const row = button(item.label, () => {
        if (item.enabled === false) return;
        const current = valid(); this.close();
        if (current) item.run(); else announce('This item changed. Choose the action again.');
      });
      row.className = 'context-menu-item';
      row.setAttribute('role', itemRole(item));
      if (item.checked !== undefined) {row.setAttribute('aria-checked', String(item.checked)); const check = cardIcon('success'); check.classList.add('choice-check'); row.prepend(check);}
      if (item.description) {row.setAttribute('aria-description', item.description); row.title = item.description;}
      row.setAttribute('aria-disabled', String(item.enabled === false)); row.tabIndex = -1;
      if (item.disabledReason && item.enabled === false) { const note = element('span', 'context-menu-note'); note.textContent = item.disabledReason; row.append(note); }
      if (item.separatorBefore) { const separator = element('div', 'context-menu-separator'); separator.setAttribute('role', 'separator'); menu.append(separator); }
      if (item.heading) {const heading = element('div', 'context-menu-heading'); heading.setAttribute('role', 'presentation'); heading.textContent = item.heading; menu.append(heading);}
      menu.append(row); return row;
    });
    this.rows = rows; this.items = items;
    const focus = (index: number) => rows[index]?.focus({preventScroll: true});
    menu.addEventListener('keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const index = rows.indexOf(doc.activeElement as HTMLButtonElement);
      const next: Record<string, number> = {ArrowDown: (index + 1) % rows.length, ArrowUp: (index - 1 + rows.length) % rows.length, Home: 0, End: rows.length - 1};
      const destination = next[event.key];
      if (destination !== undefined) { event.preventDefault(); event.stopPropagation(); focus(destination); rows[destination]?.scrollIntoView({block: 'nearest'}); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) rows[index]?.click(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === 'Tab') this.close();
    });
    const outside = (event: Event) => { if (!menu.contains(event.target as Node)) this.close(); };
    const blur = (event: FocusEvent) => { if (!menu.contains(event.target as Node)) this.close(false); };
    const resize = () => this.close();
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', blur);
    view.addEventListener('resize', resize); view.addEventListener('blur', resize);
    this.cleanup = () => { doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', blur); view.removeEventListener('resize', resize); view.removeEventListener('blur', resize); };
    const dialog = origin.closest('dialog:modal');
    (dialog ?? doc.body).append(menu);
    if (dialog) {
      // A top-layer popover remains modal-owned without inheriting dialog clipping or transforms.
      menu.popover = 'manual'; menu.style.margin = '0'; menu.style.inset = 'auto'; menu.showPopover();
    }
    menu.style.maxWidth = `${Math.max(1, view.innerWidth - 8)}px`; menu.style.maxHeight = `${Math.max(1, view.innerHeight - 8)}px`;
    const position = menuPosition(point, menu.getBoundingClientRect(), {width: view.innerWidth, height: view.innerHeight});
    menu.style.left = `${position.x}px`; menu.style.top = `${position.y}px`;
    const retained = choice?.key ? items.findIndex(item => item.key === choice.key) : -1;
    focus(previous < 0 ? 0 : retained >= 0 ? retained : Math.min(previous, rows.length - 1));
  }
  close(restore = true): void {
    if (!this.node) return;
    const origin = this.restore;
    this.cleanup?.(); this.cleanup = undefined; this.node.remove(); this.node = undefined; this.restore = undefined;
    this.trigger?.setAttribute('aria-expanded', 'false'); this.trigger = undefined; this.rows = []; this.items = [];
    if (restore && origin?.isConnected) origin.focus({preventScroll: true});
  }
}
export const contextMenu = new ContextMenu();

export type PaneMenuTarget = {paneId: string; tabKey?: string};
export type PaneMenuHooks = {layout: () => PaneLayout; valid: () => boolean; space: (pane: string) => PaneSpace;
  label: (key: string) => string; change: (layout: PaneLayout) => void; newTab: (pane: string) => void;
  split: (pane: string, axis: PaneAxis, key: string | null) => void; closeTab: (key: string) => void;
  activate: (pane: string, key: string) => void; view: (key: string) => PaneView; setView: (key: string, view: PaneView) => void;
  overflow?: boolean; sessionItems?: ContextItem[]; purpose?: 'add' | 'context'};
type Guard = (run: () => void) => () => void;
function moveChoices(layout: PaneLayout, paneId: string, key: string | null, hooks: PaneMenuHooks, guard: Guard): ContextItem[] {
  const leaves = paneLeaves(layout.root); const destinations = leaves.filter(leaf => leaf.id !== paneId);
  if (!destinations.length) return [{label: 'Move tab to pane…', enabled: false, disabledReason: 'No other pane', run() {}}];
  return destinations.map(destination => {
    const number = leaves.indexOf(destination) + 1; const name = destination.active ? hooks.label(destination.active) : 'Empty';
    return {label: `Move tab to ${name} (pane ${number})`, enabled: !!key, run: guard(() => {if (key) hooks.change(movePaneTab(layout, key, destination.id));})};
  });
}
function viewChoices(key: string | null, hooks: PaneMenuHooks, guard: Guard): ContextItem[] {
  const view = key ? hooks.view(key) : 'chronological';
  return ([['chronological', 'View: Conversation'], ['grouped', 'View: Grouped']] as const).map(([mode, label]) =>
    ({label, checked: view === mode, enabled: !!key, separatorBefore: mode === 'chronological', run: guard(() => {if (key) hooks.setView(key, mode);})}));
}
function tabChoices(layout: PaneLayout, hooks: PaneMenuHooks, guard: Guard): ContextItem[] {
  return paneLeaves(layout.root).flatMap((leaf, index) => leaf.tabs.map((tab, tabIndex) => {
    const key = tabKey(tab); const first = index === 0 && tabIndex === 0;
    return {label: `${hooks.label(key)} (pane ${index + 1})`, heading: first ? 'Tabs' : undefined, separatorBefore: first, run: guard(() => hooks.activate(leaf.id, key))};
  }));
}
/** Entry points share captured targets, while the plus owns only conversation creation and splits. */
export function paneMenuItems(target: PaneMenuTarget, hooks: PaneMenuHooks): ContextItem[] {
  const layout = hooks.layout(); const pane = paneById(layout, target.paneId); if (!pane) return [];
  const key = target.tabKey ?? pane.active;
  if (target.tabKey && !pane.tabs.some(tab => tabKey(tab) === target.tabKey)) return [];
  const leaves = paneLeaves(layout.root); const space = hooks.space(pane.id);
  const guard = (run: () => void): (() => void) => () => {
    if (hooks.valid() && hooks.layout().root === layout.root) run(); else announce('This item changed. Choose the action again.');
  };
  const split = (axis: PaneAxis): ContextItem => ({label: axis === 'x' ? 'Split right' : 'Split down', enabled: canSplitPane(layout, pane.id, axis, space),
    disabledReason: leaves.length >= MAX_PANES ? 'Four panes maximum' : 'Not enough space', run: guard(() => hooks.split(pane.id, axis, key))});
  const items: ContextItem[] = [{label: 'New tab…', run: guard(() => hooks.newTab(pane.id))}, split('x'), split('y')];
  if (hooks.purpose === 'add') return items;
  items.push(...moveChoices(layout, pane.id, key, hooks, guard));
  items.push({label: 'Close tab', enabled: !!key, run: guard(() => {if (key) hooks.closeTab(key);})},
    {label: 'Close pane', enabled: leaves.length > 1, run: guard(() => hooks.change(closePane(layout, pane.id)))});
  items.push(...viewChoices(key, hooks, guard));
  items.push(...(hooks.sessionItems ?? []).map((item, index) => ({...item, separatorBefore: index === 0 || item.separatorBefore, run: guard(item.run)})));
  if (hooks.overflow) items.push(...tabChoices(layout, hooks, guard));
  return items;
}
