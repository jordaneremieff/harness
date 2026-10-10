import { announce, button, element } from './dom.ts';

export type ContextItem = {label: string; run: () => void; enabled?: boolean};
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
  get openNow(): boolean { return !!this.node; }
  open(origin: HTMLElement, point: MenuPoint, label: string, items: ContextItem[], valid: () => boolean = () => true): void {
    this.close(false); if (!items.length) return;
    const doc = origin.ownerDocument; const view = doc.defaultView; if (!view) return;
    const active = doc.activeElement as HTMLElement | null;
    this.restore = active && origin.contains(active) ? active : origin;
    const menu = element('div', 'context-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
    this.node = menu;
    const rows = items.map(item => {
      const row = button(item.label, () => {
        if (item.enabled === false) return;
        const current = valid(); this.close();
        if (current) item.run(); else announce('This menu target changed. Open its menu again.');
      });
      row.setAttribute('role', 'menuitem'); row.setAttribute('aria-disabled', String(item.enabled === false)); row.tabIndex = -1;
      menu.append(row); return row;
    });
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
    doc.body.append(menu);
    menu.style.maxWidth = `${Math.max(1, view.innerWidth - 8)}px`; menu.style.maxHeight = `${Math.max(1, view.innerHeight - 8)}px`;
    const position = menuPosition(point, menu.getBoundingClientRect(), {width: view.innerWidth, height: view.innerHeight});
    menu.style.left = `${position.x}px`; menu.style.top = `${position.y}px`; focus(0);
  }
  close(restore = true): void {
    if (!this.node) return;
    const origin = this.restore;
    this.cleanup?.(); this.cleanup = undefined; this.node.remove(); this.node = undefined; this.restore = undefined;
    if (restore && origin?.isConnected) origin.focus({preventScroll: true});
  }
}
export const contextMenu = new ContextMenu();
