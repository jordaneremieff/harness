import { byId, button, details, element, setText } from './dom.ts';
import { errorMessage } from './transport.ts';

export class Modal {
  readonly node = byId<HTMLDialogElement>('modal');
  readonly body = byId('modal-body');
  private restore?: HTMLElement;
  private cancelAction?: () => void;
  private closeAction?: () => void;
  private revision = 0;
  private presented = false;
  private restoreOnClose = true;
  private running = new Set<number>();
  private readonly focusCurrent: () => void;
  constructor(focusCurrent: () => void = () => {}) {
    this.focusCurrent = focusCurrent;
    byId('modal-close').addEventListener('click', () => this.cancel());
    this.node.addEventListener('cancel', event => { event.preventDefault(); this.cancel(); });
    this.node.addEventListener('close', () => this.finishClose());
    this.node.addEventListener('keydown', event => {
      if (this.node.dataset.variant === 'find' && event.key === 'Escape' && !event.isComposing) {event.preventDefault(); this.cancel();}
    });
    this.node.addEventListener('click', event => {
      if (!['menu', 'palette'].includes(this.node.dataset.variant ?? '') || event.target !== this.node) return;
      const box = this.node.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.cancel();
    });
  }
  /** Presents the open dialog as a compact menu under its trigger; modal focus and Escape stay unchanged. */
  anchor(trigger: HTMLElement): void {
    const box = trigger.getBoundingClientRect();
    this.node.dataset.variant = 'menu';
    this.node.style.setProperty('--menu-top', `${Math.round(box.bottom + 4)}px`);
    this.node.style.setProperty('--menu-right', `${Math.max(8, Math.round(innerWidth - box.right))}px`);
  }
  open(title: string, cancel?: () => void, closed?: () => void, variant?: 'find' | 'image'): HTMLElement {
    const previousClose = this.closeAction; this.closeAction = undefined; previousClose?.();
    if (this.node.open && (this.node.dataset.variant === 'find' || variant === 'find')) this.close(false);
    this.revision++; this.presented = true; this.restoreOnClose = true;
    if (!this.node.open) this.restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.body.replaceChildren();
    setText(byId('modal-title'), title); byId('modal-error').replaceChildren();
    delete this.node.dataset.variant;
    this.cancelAction = cancel; this.closeAction = closed;
    if (variant) this.node.dataset.variant = variant;
    if (!this.node.open) {if (variant === 'find') this.node.show(); else this.node.showModal();}
    return this.body;
  }
  get openNow(): boolean { return this.node.open; }
  get token(): number { return this.revision; }
  owns(token: number): boolean { return this.node.open && this.revision === token; }
  restoreFocus(node: HTMLElement): void { if (this.node.open) {this.restore = node; this.presented = true;} else node.focus({preventScroll: true}); }
  private finishClose(): void {
    if (!this.presented || this.node.open) return;
    const revision = this.revision, closed = this.closeAction, restore = this.restore, focus = this.restoreOnClose;
    this.presented = false; this.closeAction = undefined; this.cancelAction = undefined; this.restore = undefined;
    closed?.();
    if (!focus || this.revision !== revision || this.node.open) return;
    if (restore?.isConnected) restore.focus(); else this.focusCurrent();
  }
  close(restore = true): void {
    this.restoreOnClose = restore; this.cancelAction = undefined; this.node.close(); this.finishClose();
  }
  cancel(): void { if (this.cancelAction) this.cancelAction(); else this.close(); }
  error(error: unknown, message = 'The action failed.'): void {
    byId('modal-error').replaceChildren(element('p', undefined, message), details('Details', errorMessage(error)));
  }
  actions(...buttons: HTMLButtonElement[]): HTMLElement {
    const row = element('div', 'dialog-actions'); row.append(...buttons); this.body.append(row); return row;
  }
  async run(action: () => Promise<unknown>, close = true, message = 'The action failed.'): Promise<void> {
    const revision = this.revision;
    if (this.running.has(revision)) return;
    this.running.add(revision);
    const enabled = [...this.body.querySelectorAll<HTMLButtonElement>('button')].filter(node => !node.disabled);
    for (const node of enabled) node.disabled = true;
    try { await action(); if (close && this.revision === revision) this.close(); }
    catch (error) { if (this.revision === revision) this.error(error, message); }
    finally {
      this.running.delete(revision);
      if (this.revision === revision) for (const node of enabled) node.disabled = false;
    }
  }
  confirm(title: string, message: string, action: () => Promise<unknown>, label = 'Confirm'): void {
    this.open(title).append(element('p', undefined, message));
    const cancel = button('Cancel', () => this.close());
    this.actions(cancel, button(label, () => { void this.run(action); }, 'danger'));
    cancel.focus();
  }
}
