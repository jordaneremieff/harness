import { byId, button, element, setText } from './dom.ts';
import { errorMessage } from './transport.ts';

export class Modal {
  readonly node = byId<HTMLDialogElement>('modal');
  readonly body = byId('modal-body');
  private restore?: HTMLElement;
  private cancelAction?: () => void;
  private closeAction?: () => void;
  private revision = 0;
  private running = new Set<number>();
  constructor() {
    byId('modal-close').addEventListener('click', () => this.cancel());
    this.node.addEventListener('cancel', event => { event.preventDefault(); this.cancel(); });
    this.node.addEventListener('close', () => {
      this.closeAction?.(); this.closeAction = undefined;
      const focus = this.restore?.isConnected ? this.restore : byId('primary-editor');
      focus.focus();
    });
  }
  open(title: string, cancel?: () => void, closed?: () => void): HTMLElement {
    this.revision++;
    if (!this.node.open) this.restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.body.replaceChildren();
    setText(byId('modal-title'), title); setText(byId('modal-error'), '');
    this.cancelAction = cancel; this.closeAction = closed;
    if (!this.node.open) this.node.showModal();
    return this.body;
  }
  get openNow(): boolean { return this.node.open; }
  get token(): number { return this.revision; }
  owns(token: number): boolean { return this.node.open && this.revision === token; }
  close(): void { this.cancelAction = undefined; this.node.close(); }
  cancel(): void { if (this.cancelAction) this.cancelAction(); else this.close(); }
  error(error: unknown): void { setText(byId('modal-error'), errorMessage(error)); }
  actions(...buttons: HTMLButtonElement[]): HTMLElement {
    const row = element('div', 'dialog-actions'); row.append(...buttons); this.body.append(row); return row;
  }
  async run(action: () => Promise<unknown>, close = true): Promise<void> {
    const revision = this.revision;
    if (this.running.has(revision)) return;
    this.running.add(revision);
    const enabled = [...this.body.querySelectorAll<HTMLButtonElement>('button')].filter(node => !node.disabled);
    for (const node of enabled) node.disabled = true;
    try { await action(); if (close && this.revision === revision) this.close(); }
    catch (error) { if (this.revision === revision) this.error(error); }
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
