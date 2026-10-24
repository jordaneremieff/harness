import {cardIcon, type CardIcon} from './card-icons.ts';
import { announce, button, element } from './dom.ts';
import { tabKey } from './tabs.ts';
import { canSplitPane, closePane, MAX_PANES, movePaneTab, paneById, paneLeaves, samePaneLayout, type PaneAxis, type PaneLayout, type PaneSpace } from './pane-layout.ts';

export type ContextItem = {key?: string; icon?: CardIcon; hint?: string; label: string; run: () => void; enabled?: boolean; checked?: boolean; checkbox?: boolean; description?: string; disabledReason?: string; separatorBefore?: boolean; heading?: string};
function itemRole(item: ContextItem): string { return item.checked === undefined ? 'menuitem' : item.checkbox ? 'menuitemcheckbox' : 'menuitemradio'; }
export type MenuPoint = {x: number; y: number};
/** A compact menu draws fixed-height rows with the typed trigger at the right and keeps a disabled reason in the tooltip; an upward menu ends at the given point. */
export type MenuOptions = {compact?: boolean; above?: boolean; presentation?: 'composer-intake'};
export function menuPosition(point: MenuPoint, size: {width: number; height: number}, viewport: {width: number; height: number}): MenuPoint {
  return {x: Math.max(4, Math.min(point.x, viewport.width - size.width - 4)), y: Math.max(4, Math.min(point.y, viewport.height - size.height - 4))};
}
function menuClass(options: MenuOptions): string { return `context-menu${options.compact ? ' context-menu-compact' : ''}${options.presentation === 'composer-intake' ? ' composer-intake-menu' : ''}`; }
function placeMenu(point: MenuPoint, size: {width: number; height: number}, options: MenuOptions, viewport: {width: number; height: number}): MenuPoint {
  return menuPosition({x: point.x, y: options.above ? point.y - size.height : point.y}, size, viewport);
}
export function nativeEditingTarget(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
function explainDisabled(row: HTMLElement, reason: string, options: MenuOptions): void {
  if (options.compact) {row.title = reason; row.setAttribute('aria-description', reason); return;}
  const note = element('span', 'context-menu-note'); note.textContent = reason; row.append(note);
}
/** One row: a check or icon, the label, the typed trigger, and a disabled reason as a note or, in a compact menu, as its tooltip. */
function menuRow(item: ContextItem, options: MenuOptions, choose: () => void): HTMLButtonElement {
  const row = button(item.label, choose);
  row.className = 'context-menu-item';
  row.setAttribute('role', itemRole(item));
  const check = item.checked !== undefined ? cardIcon('success') : undefined;
  if (check) {row.setAttribute('aria-checked', String(item.checked)); check.classList.add('choice-check'); row.prepend(check);}
  const icon = item.icon ? cardIcon(item.icon) : undefined; icon?.classList.add('context-menu-icon');
  const hint = item.hint ? element('span', 'context-menu-hint', item.hint) : undefined; hint?.setAttribute('aria-hidden', 'true');
  if (options.compact) row.replaceChildren(...[check ?? icon, element('span', 'context-menu-label', item.label), hint].filter((node): node is NonNullable<typeof node> => !!node));
  else {if (icon) row.prepend(icon); if (hint) row.prepend(hint);}
  if (item.hint) row.setAttribute('aria-keyshortcuts', item.hint);
  if (item.description) {row.setAttribute('aria-description', item.description); row.title = item.description;}
  row.setAttribute('aria-disabled', String(item.enabled === false)); row.tabIndex = -1;
  if (item.disabledReason && item.enabled === false) explainDisabled(row, item.disabledReason, options);
  return row;
}
function retainedFocusIndex(items: ContextItem[], choice: ContextItem | undefined, previous: number): number {
  if (previous < 0) return 0;
  const retained = choice?.key ? items.findIndex(item => item.key === choice.key) : -1;
  return retained >= 0 ? retained : Math.min(previous, items.length - 1);
}
/** One popup owns menu navigation and dismissal; callers retain the action's exact target. */
export class ContextMenu {
  private node?: HTMLElement;
  private restore?: HTMLElement;
  private cleanup?: () => void;
  private surface?: HTMLElement;
  private releaseSheet?: () => void;
  private sheetDismiss?: HTMLButtonElement;
  private trigger?: HTMLElement;
  private rows: HTMLElement[] = [];
  private items: ContextItem[] = [];
  get openNow(): boolean { return !!this.node; }
  owns(origin: HTMLElement): boolean { return !!this.node && this.trigger === origin; }
  open(origin: HTMLElement, point: MenuPoint, label: string, items: ContextItem[], valid: () => boolean = () => true, options: MenuOptions = {}): void {
    const previous = this.trigger === origin ? this.rows.indexOf(origin.ownerDocument.activeElement as HTMLElement) : -1;
    const choice = this.items[previous];
    const restore = previous >= 0 ? this.restore : undefined;
    this.close(false); if (!items.length) return;
    const doc = origin.ownerDocument; const view = doc.defaultView; if (!view) return;
    const mobile = view.matchMedia?.('(max-width: 999px)').matches === true;
    const active = doc.activeElement as HTMLElement | null;
    this.restore = restore ?? (active && origin.contains(active) ? active : origin);
    if (origin.getAttribute?.('aria-haspopup') === 'menu') { this.trigger = origin; origin.setAttribute('aria-expanded', 'true'); }
    const menu = element('div', menuClass(options)); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
    this.node = menu;
    if (options.presentation === 'composer-intake' && !mobile) { const heading = element('div', 'composer-menu-heading', label); heading.setAttribute('role', 'presentation'); heading.setAttribute('aria-hidden', 'true'); menu.append(heading); }
    const rows = items.map(item => {
      const row = menuRow(item, options, () => {
        if (this.node !== menu || item.enabled === false) return;
        const current = valid(); this.close();
        if (current) item.run(); else announce('This item changed. Choose the action again.');
      });
      if (item.separatorBefore) { const separator = element('div', 'context-menu-separator'); separator.setAttribute('role', 'separator'); menu.append(separator); }
      if (item.heading) {const heading = element('div', 'context-menu-heading'); heading.setAttribute('role', 'presentation'); heading.textContent = item.heading; menu.append(heading);}
      menu.append(row); return row;
    });
    this.rows = rows; this.items = items;
    const markActive = (index: number) => {if (mobile) for (const [position, row] of rows.entries()) row.tabIndex = position === index ? 0 : -1;};
    for (const [index, row] of rows.entries()) row.addEventListener('focus', () => markActive(index));
    const focus = (index: number) => {markActive(index); rows[index]?.focus({preventScroll: true});};
    menu.addEventListener('keydown', event => this.navigateMenu(event, menu, rows, focus, mobile));
    this.observeDismissal(menu, view, mobile);
    const dialog = origin.closest<HTMLDialogElement>('dialog:modal');
    if (mobile) {this.openSheet(menu, label, dialog ?? undefined); this.sheetDismiss?.addEventListener('keydown', event => this.cycleSheet(event, rows, focus));}
    else this.openAnchored(menu, point, options, view, dialog ?? doc.body);
    focus(retainedFocusIndex(items, choice, previous));
  }
  private observeDismissal(menu: HTMLElement, view: Window, mobile: boolean): void {
    const doc = menu.ownerDocument;
    const outside = (event: Event) => {if (!(this.surface ?? menu).contains(event.target as Node)) this.close();};
    const blur = (event: FocusEvent) => {if (!(this.surface ?? menu).contains(event.target as Node)) this.close(false);};
    const resize = () => this.close();
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', blur);
    if (!mobile) view.addEventListener('resize', resize);
    view.addEventListener('blur', resize);
    this.cleanup = () => {doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', blur); view.removeEventListener('resize', resize); view.removeEventListener('blur', resize);};
  }
  private navigateMenu(event: KeyboardEvent, menu: HTMLElement, rows: HTMLButtonElement[], focus: (index: number) => void, mobile: boolean): void {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const index = rows.indexOf(menu.ownerDocument.activeElement as HTMLButtonElement);
    const next: Record<string, number> = {ArrowDown: (index + 1) % rows.length, ArrowUp: (index - 1 + rows.length) % rows.length, Home: 0, End: rows.length - 1};
    const destination = next[event.key];
    if (destination !== undefined) {
      event.preventDefault(); event.stopPropagation(); focus(destination); rows[destination]?.scrollIntoView({block: 'nearest'}); return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) rows[index]?.click(); return;
    }
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); this.close(); return;}
    if (event.key === 'Tab' && mobile) {this.cycleSheet(event, rows, focus); return;}
    if (event.key === 'Tab' && !mobile) this.close();
  }
  /** A sheet owns its Tab key: the close control and the roving action form one contained focus cycle. */
  private cycleSheet(event: KeyboardEvent, rows: HTMLButtonElement[], focus: (index: number) => void): void {
    const dismiss = this.sheetDismiss;
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key !== 'Tab' || !dismiss) return;
    event.preventDefault(); event.stopPropagation();
    if (dismiss.ownerDocument.activeElement === dismiss) {const active = rows.findIndex(row => row.tabIndex === 0); focus(active >= 0 ? active : 0); return;}
    dismiss.focus({preventScroll: true});
  }
  private openAnchored(menu: HTMLElement, point: MenuPoint, options: MenuOptions, view: Window, parent: HTMLElement): void {
    parent.append(menu);
    if (parent !== menu.ownerDocument.body) {
      // A top-layer popover remains modal-owned without inheriting dialog clipping or transforms.
      menu.popover = 'manual'; menu.style.margin = '0'; menu.style.inset = 'auto'; menu.showPopover();
    }
    menu.style.maxWidth = `${Math.max(1, view.innerWidth - 8)}px`; menu.style.maxHeight = `${Math.max(1, view.innerHeight - 8)}px`;
    const position = placeMenu(point, menu.getBoundingClientRect(), options, {width: view.innerWidth, height: view.innerHeight});
    menu.style.left = `${position.x}px`; menu.style.top = `${position.y}px`;
  }
  private openSheet(menu: HTMLElement, label: string, parent?: HTMLDialogElement): void {
    const surface = element(parent ? 'section' : 'dialog', 'context-menu-sheet');
    surface.setAttribute('aria-label', label); surface.dataset.sheet = 'content'; this.surface = surface;
    const heading = element('div', 'sheet-heading'); heading.append(element('h2', undefined, label));
    const dismiss = button(parent ? 'Back' : 'Close', () => this.close(), 'sheet-close'); dismiss.setAttribute('aria-label', parent ? `Back from ${label}` : `Close ${label}`);
    heading.append(dismiss); menu.classList.add('context-menu-sheet-body'); surface.append(heading, menu);
    this.sheetDismiss = dismiss;
    const cancel = (event: Event) => {event.preventDefault(); event.stopImmediatePropagation(); this.close();};
    const closed = () => {if (this.surface === surface) this.close(false);};
    if (parent) {
      const previous = [...parent.children].filter((node): node is HTMLElement => node instanceof HTMLElement).map(node => ({node, hidden: node.hidden, inert: node.inert}));
      for (const {node} of previous) {node.hidden = true; node.inert = true;}
      parent.dataset.contextSheet = 'true'; parent.append(surface); parent.addEventListener('cancel', cancel, true); parent.addEventListener('close', closed);
      this.releaseSheet = () => {
        parent.removeEventListener('cancel', cancel, true); parent.removeEventListener('close', closed); delete parent.dataset.contextSheet;
        for (const {node, hidden, inert} of previous) {node.hidden = hidden; node.inert = inert;}
        surface.remove();
      };
    } else {
      const dialog = surface as HTMLDialogElement; dialog.addEventListener('cancel', cancel); dialog.addEventListener('close', closed);
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.close();
      });
      menu.ownerDocument.body.append(dialog); dialog.showModal();
      this.releaseSheet = () => {dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('close', closed); dialog.close(); dialog.remove();};
    }
  }
  close(restore = true): void {
    if (!this.node) return;
    const origin = this.restore;
    this.cleanup?.(); this.cleanup = undefined; this.node.remove(); this.node = undefined; this.restore = undefined;
    const release = this.releaseSheet; this.releaseSheet = undefined; this.surface = undefined; this.sheetDismiss = undefined; release?.();
    this.trigger?.setAttribute('aria-expanded', 'false'); this.trigger = undefined; this.rows = []; this.items = [];
    if (restore && origin?.isConnected) origin.focus({preventScroll: true});
  }
}
export const contextMenu = new ContextMenu();

export type PaneMenuTarget = {paneId: string; tabKey?: string};
export type PaneMenuHooks = {layout: () => PaneLayout; valid: () => boolean; space: (pane: string) => PaneSpace;
  label: (key: string) => string; change: (layout: PaneLayout) => void; newTab: (pane: string) => void;
  split: (pane: string, axis: PaneAxis, key: string | null) => void; closeTab: (key: string) => void;
  activate: (pane: string, key: string) => void; conversation: (pane: string, key: string) => void;
  overflow?: boolean; purpose?: 'add' | 'context'};
type Guard = (run: () => void) => () => void;
function moveChoices(layout: PaneLayout, paneId: string, key: string | null, hooks: PaneMenuHooks, guard: Guard): ContextItem[] {
  const leaves = paneLeaves(layout.root); const destinations = leaves.filter(leaf => leaf.id !== paneId);
  if (!destinations.length) return [{label: 'Move tab to pane', enabled: false, disabledReason: 'No other pane', run() {}}];
  return destinations.map(destination => {
    const number = leaves.indexOf(destination) + 1; const name = destination.active ? hooks.label(destination.active) : 'Empty';
    return {label: `Move tab to ${name} (pane ${number})`, enabled: !!key, run: guard(() => {if (key) hooks.change(movePaneTab(layout, key, destination.id));})};
  });
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
    if (hooks.valid() && samePaneLayout(hooks.layout(), layout)) run(); else announce('This item changed. Choose the action again.');
  };
  const split = (axis: PaneAxis): ContextItem => ({label: axis === 'x' ? 'Split right' : 'Split down', enabled: canSplitPane(layout, pane.id, axis, space),
    disabledReason: leaves.length >= MAX_PANES ? 'Four panes maximum' : 'Not enough space', run: guard(() => hooks.split(pane.id, axis, key))});
  const items: ContextItem[] = [{label: 'New tab', run: guard(() => hooks.newTab(pane.id))}, split('x'), split('y')];
  if (hooks.purpose === 'add') return items;
  items.push(...moveChoices(layout, pane.id, key, hooks, guard));
  items.push({label: 'Close tab', enabled: !!key, run: guard(() => {if (key) hooks.closeTab(key);})},
    {label: 'Close pane', enabled: leaves.length > 1, run: guard(() => hooks.change(closePane(layout, pane.id)))});
  if (pane.tabs.find(tab=>tabKey(tab) === key)?.kind !== 'file') items.push({label: 'Conversation actions', enabled: !!key, separatorBefore: true, run: guard(() => {if (key) hooks.conversation(pane.id, key);})});
  if (hooks.overflow) items.push(...tabChoices(layout, hooks, guard));
  return items;
}
