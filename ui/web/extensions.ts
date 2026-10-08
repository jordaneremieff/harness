import type { DialogView, PrimaryView, Target } from '../shared/api.ts';
import { activeDialog, respondDialog } from './dialog-state.ts';
import type { DialogValue, QueuedDialog } from './dialog-state.ts';
import type { UiState } from './state.ts';
import { byId, button, details, element, input, setText, stripControls } from './dom.ts';
import type { Modal } from './modal.ts';
import { operation, reserve, request } from './transport.ts';

export class ExtensionDialogs {
  private shown?: string;
  private shownToken = 0;
  private answering = new Set<string>();
  private modal: Modal;
  private get: () => UiState;
  private put: (state: UiState) => void;
  private primary: () => PrimaryView | undefined;
  constructor(modal: Modal, get: () => UiState, put: (state: UiState) => void, primary: () => PrimaryView | undefined) { this.modal = modal; this.get = get; this.put = put; this.primary = primary; }
  update(): void {
    const primary = this.primary(); if (!primary) return;
    const target: Extract<Target, {kind: 'primary'}> = {kind: 'primary', key: primary.key, epoch: primary.epoch};
    const item = activeDialog(this.get().dialogs, target);
    if (!item) { if (this.shown) { this.shown = undefined; if (this.modal.owns(this.shownToken)) this.modal.close(); } return; }
    if (this.shown === this.key(item) && this.modal.owns(this.shownToken)) return;
    this.show(item, primary);
  }
  private show(item: QueuedDialog, primary: PrimaryView): void {
    const dialog = item.dialog; this.shown = this.key(item);
    const submit = (value: DialogValue) => { void this.answer(item, value); };
    const body = this.modal.open(dialog.title, () => {
      const cancellation = respondDialog(this.get().dialogs, item.target, item.dialog.id, {cancelled: true});
      if (this.answering.has(this.key(item)) || !cancellation.command) { this.shown = undefined; this.modal.close(); }
      else submit({cancelled: true});
    });
    this.shownToken = this.modal.token;
    body.append(element('p', 'target-label', `Primary: ${primary.sessionName ?? primary.sessionId ?? primary.key}`));
    if (dialog.message) body.append(element('p', undefined, stripControls(dialog.message)));
    if (dialog.deadline) body.append(element('p', 'secondary', `Pi limits this request until ${new Date(dialog.deadline).toLocaleString()}. Pi owns expiry.`));
    const cancel = button('Cancel', () => submit({cancelled: true}));
    if (dialog.method === 'select') {
      this.options(dialog, body, submit); this.modal.actions(cancel);
    } else if (dialog.method === 'confirm') {
      const no = button('No', () => submit({confirmed: false})); this.modal.actions(cancel, no, button('Yes', () => submit({confirmed: true}))); no.focus(); return;
    } else {
      const field = input(dialog.method === 'editor' ? 'Text' : dialog.placeholder ?? 'Value', dialog.prefill ?? '', dialog.method === 'editor');
      body.append(field.label, field.field); this.modal.actions(cancel, button(dialog.method === 'editor' ? 'Save' : 'Choose', () => submit({value: field.field.value}), 'accent'));
      field.field.addEventListener('keydown', rawEvent => {
        const event = rawEvent as KeyboardEvent;
        if (event.isComposing || event.repeat || event.key !== 'Enter') return;
        if (dialog.method === 'editor' && !event.metaKey) return;
        event.preventDefault(); submit({value: field.field.value});
      }); field.field.focus(); return;
    }
    cancel.focus();
  }
  private options(dialog: DialogView, body: HTMLElement, submit: (value: DialogValue) => void): void {
    const list = element('div', 'options');
    for (const [index, option] of (dialog.options ?? []).entries()) list.append(button(option, () => submit({value: dialog.optionKeys?.[index] ?? option})));
    if ((dialog.options?.length ?? 0) > 8) {
      const search = input('Filter options'); body.append(search.label, search.field);
      search.field.addEventListener('input', () => {
        for (const node of list.children) if (node instanceof HTMLElement) node.hidden = !node.textContent?.toLocaleLowerCase().includes(search.field.value.toLocaleLowerCase());
      });
    }
    body.append(list); list.addEventListener('keydown', event => this.arrows(event, list));
  }
  private arrows(event: KeyboardEvent, list: HTMLElement): void {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button:not([hidden])')]; if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement); const index = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
    event.preventDefault(); buttons[index]?.focus();
  }
  private key(item: QueuedDialog): string { return JSON.stringify([item.target.key, item.target.epoch, item.dialog.id]); }
  private async answer(item: QueuedDialog, value: DialogValue): Promise<void> {
    const key = this.key(item); const token = this.modal.token;
    if (this.answering.has(key) || !respondDialog(this.get().dialogs, item.target, item.dialog.id, value).command) return;
    this.answering.add(key); this.buttons(true);
    let id: string | undefined;
    try {
      id = await reserve('primary.dialog', item.target);
      const result = respondDialog(this.get().dialogs, item.target, item.dialog.id, value);
      if (!result.command) { await request(`/api/operations/${encodeURIComponent(id)}`, 'DELETE'); return; }
      this.put({...this.get(), dialogs: result.state});
      if (this.modal.owns(token)) this.modal.body.append(element('p', 'secondary', 'Response requested'));
      await operation('primary.dialog', `/api/primaries/${encodeURIComponent(item.target.key)}/dialogs/${encodeURIComponent(item.dialog.id)}`, result.command.response, item.target, id);
      if (this.shown === key) { this.shown = undefined; if (this.modal.owns(token)) this.modal.close(); } this.update();
    } catch (error) { if (this.modal.owns(token)) this.responseError(error, id); }
    finally { this.answering.delete(key); if (!id && this.modal.owns(token)) this.buttons(false); }
  }
  private buttons(disabled: boolean): void { for (const node of this.modal.body.querySelectorAll<HTMLButtonElement>('button')) node.disabled = disabled; }
  private responseError(error: unknown, id?: string): void {
    this.modal.error(error);
    if (!id) return;
    this.modal.body.append(button('Check response receipt', () => { void this.modal.run(async () => {
      const result = await request(`/api/operations/${encodeURIComponent(id)}/reconcile`, 'POST', {}); this.modal.body.append(details('Response receipt', JSON.stringify(result, null, 2)));
    }, false); }), button('Close without another response', () => { this.shown = undefined; this.modal.close(); }));
  }
}
export function extensionStatus(primary?: PrimaryView): void {
  const extension = primary?.extension;
  setText(byId('extension-status'), Object.values(extension?.statuses ?? {}).map(stripControls).join(' · '));
  renderWidgets(extension?.widgets ?? {});
  if (extension?.title) document.title = `Pi · ${stripControls(extension.title)}`;
}
function renderWidgets(widgets: Record<string, {lines: string[]; placement?: string}>): void {
  for (const place of ['above', 'below']) {
    const node = byId(`primary-widgets-${place}`); node.replaceChildren();
    for (const [key, widget] of Object.entries(widgets)) {
      if ((widget.placement === 'belowEditor' ? 'below' : 'above') !== place) continue;
      const text = widget.lines.map(stripControls).join('\n'); const preview = element('pre', undefined, widget.lines.slice(0, 3).map(stripControls).join('\n')); node.append(preview);
      if (widget.lines.length > 3) node.append(details(`Expand ${key}`, text));
    }
  }
}
