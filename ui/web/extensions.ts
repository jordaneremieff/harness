import type { DialogView, PrimaryView, Target } from '../shared/api.ts';
import { activeDialog, respondDialog } from './dialog-state.ts';
import type { DialogValue, QueuedDialog } from './dialog-state.ts';
import type { UiState } from './state.ts';
import { byId, button, details, element, input, setText, stripControls } from './dom.ts';
import type { Modal } from './modal.ts';
import { operation, reserve, request } from './transport.ts';
import { localDateTime } from './format.ts';

export class ExtensionDialogs {
  private shown?: string;
  private inlineHost?: HTMLElement;
  private inlineKey?: string;
  private inlineHeld=false;
  /** The same dialog action is presented in the on-demand Desk instead of a modal. */
  inline(host?:HTMLElement,hold=false):void {this.inlineHost=host;this.inlineHeld=hold||!!host;if(!host)this.inlineKey=undefined;this.update();}
  private shownToken = 0;
  private answering = new Set<string>();
  private modal: Modal;
  private get: () => UiState;
  private put: (state: UiState) => void;
  private primary: () => PrimaryView | undefined;
  private caption: (primary: PrimaryView) => string;
  private waiting = false;
  private changed: () => void;
  constructor(modal: Modal, get: () => UiState, put: (state: UiState) => void, primary: () => PrimaryView | undefined, caption: (primary: PrimaryView) => string = () => 'Primary', changed: () => void = () => {}) { this.modal = modal; this.get = get; this.put = put; this.primary = primary; this.caption = caption; this.changed = changed; }
  /** True while a pending dialog waits for an answer from this Primary conversation. */
  awaiting(): boolean {
    const primary = this.primary(); if (!primary) return false;
    return !!activeDialog(this.get().dialogs, {kind: 'primary', key: primary.key, epoch: primary.epoch});
  }
  private publish(): void { const next = this.awaiting(); if (next !== this.waiting) { this.waiting = next; this.changed(); } }
  update(): void {
    this.publish();
    const primary = this.primary(); if (!primary) return;
    const target: Extract<Target, {kind: 'primary'}> = {kind: 'primary', key: primary.key, epoch: primary.epoch};
    const item = activeDialog(this.get().dialogs, target);
    if (!item) {this.inlineHost?.replaceChildren();this.inlineKey=undefined; if (this.shown) { this.shown = undefined; if (this.modal.owns(this.shownToken)) this.modal.close(); } return; }
    if(this.inlineHost){this.showInline(item,primary,this.inlineHost);return;}
    if(this.inlineHeld)return;
    if (this.shown === this.key(item) && this.modal.owns(this.shownToken)) return;
    this.show(item, primary);
  }
  private showInline(item:QueuedDialog,primary:PrimaryView,body:HTMLElement):void {
    if(this.shown&&this.modal.owns(this.shownToken)){this.shown=undefined;this.modal.close(false);}
    if(this.inlineKey===this.key(item)&&body.childNodes.length)return;
    this.inlineKey=this.key(item);body.replaceChildren(element('p','target-label',`To ${this.caption(primary)}`));
    if(item.dialog.message)body.append(element('p',undefined,stripControls(item.dialog.message)));
    if(item.dialog.deadline)body.append(element('p','secondary',`Respond before ${localDateTime(item.dialog.deadline)}.`));
    const submit=(value:DialogValue)=>{void this.answer(item,value);};
    if(item.dialog.method==='select')this.options(item.dialog,body,submit);
    else if(item.dialog.method==='confirm')body.append(button('No',()=>submit({confirmed:false})),button('Yes',()=>submit({confirmed:true})));
    else {const field=input(item.dialog.placeholder??'Answer',item.dialog.prefill??'',item.dialog.method==='editor');body.append(field.label,field.field,button('Respond',()=>submit({value:field.field.value})));}
    body.append(button('Cancel',()=>submit({cancelled:true})));
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
    const label = element('p', 'target-label', stripControls(this.caption(primary)));
    const exact = `Conversation ID: ${primary.sessionId ?? primary.key}`; label.setAttribute('title', exact); label.setAttribute('aria-description', exact); body.append(label);
    if (dialog.message) body.append(element('p', undefined, stripControls(dialog.message)));
    if (dialog.deadline) body.append(element('p', 'secondary', `Respond before ${localDateTime(dialog.deadline)}.`));
    const cancel = button('Cancel', () => submit({cancelled: true}));
    if (dialog.method === 'select') {
      this.options(dialog, body, submit); this.modal.actions(cancel);
    } else if (dialog.method === 'confirm') {
      const no = button('No', () => submit({confirmed: false})); this.modal.actions(no, button('Yes', () => submit({confirmed: true}))); no.focus(); return;
    } else {
      const field = input(dialog.method === 'editor' ? 'Text' : dialog.placeholder ?? 'Value', dialog.prefill ?? '', dialog.method === 'editor');
      body.append(field.label, field.field); this.modal.actions(cancel, button(dialog.method === 'editor' ? 'Save' : 'Choose', () => submit({value: field.field.value}), 'main-action'));
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
    const inline=this.inlineKey===key?this.inlineHost:undefined;
    this.answering.add(key);this.answerButtons(true,inline);
    let id: string | undefined;
    try {
      id = await reserve('primary.dialog', item.target);
      const result = respondDialog(this.get().dialogs, item.target, item.dialog.id, value);
      if (!result.command) { await request(`/api/operations/${encodeURIComponent(id)}`, 'DELETE'); return; }
      this.put({...this.get(), dialogs: result.state}); this.publish();
      if (this.modal.owns(token)) this.modal.body.append(element('p', 'secondary', 'Sending response…'));
      await operation('primary.dialog', `/api/primaries/${encodeURIComponent(item.target.key)}/dialogs/${encodeURIComponent(item.dialog.id)}`, result.command.response, item.target, id);
      if (this.shown === key) { this.shown = undefined; if (this.modal.owns(token)) this.modal.close(); } this.update();
    } catch (error) {this.answerError(error,id,token,inline);}
    finally {this.answering.delete(key);if(!id)this.answerButtons(false,inline,token);}
  }
  private answerButtons(disabled:boolean,inline?:HTMLElement,token=this.modal.token):void {
    if(inline){for(const node of inline.querySelectorAll<HTMLButtonElement>('button'))node.disabled=disabled;}
    else if(this.modal.owns(token))this.buttons(disabled);
  }
  private answerError(error:unknown,id:string|undefined,token:number,inline?:HTMLElement):void {
    if(!inline){if(this.modal.owns(token))this.responseError(error,id);return;}
    inline.append(element('p','error',id?'Response not confirmed. Check before another response.':'The response was not sent.'));
    if(id)inline.append(button('Check response',()=>{void request(`/api/operations/${encodeURIComponent(id)}/reconcile`,'POST',{}).then(result=>inline.append(details('Response details',JSON.stringify(result,null,2)))).catch(()=>inline.append(element('p','error','Response check failed.')));}));
  }
  private buttons(disabled: boolean): void { for (const node of this.modal.body.querySelectorAll<HTMLButtonElement>('button')) node.disabled = disabled; }
  private responseError(error: unknown, id?: string): void {
    this.modal.error(error, id ? 'Response not confirmed. Check before you respond again.' : 'The response was not sent. Try again.');
    if (!id) return;
    this.modal.body.append(button('Check response', () => { void this.modal.run(async () => {
      const result = await request(`/api/operations/${encodeURIComponent(id)}/reconcile`, 'POST', {}); this.modal.body.append(details('Response details', JSON.stringify(result, null, 2)));
    }, false); }), button('Close without another response', () => { this.shown = undefined; this.modal.close(); }));
  }
}
type StatusRows = Array<[string, string]>;
type StatusDisclosure = {node: HTMLDetailsElement; summary: HTMLElement; preview: HTMLElement; count: HTMLElement; list: HTMLElement; rows: StatusRows; signature: string};
const statusDisclosures = new WeakMap<HTMLElement, StatusDisclosure>();
function statusPreview(rows: StatusRows): {text: string; omitted: number} {
  const visible: string[] = []; let length = 0;
  for (const [, value] of rows) {
    const points = Array.from(value); const added = points.length + (visible.length ? 3 : 0);
    if (length + added > 56) {
      if (!visible.length) visible.push(`${points.slice(0, 55).join('')}…`);
      break;
    }
    visible.push(value); length += added;
  }
  const omitted = rows.length - visible.length;
  return {text: visible.join(' · '), omitted};
}
function statusList(disclosure: StatusDisclosure): void {
  disclosure.list.replaceChildren(...disclosure.rows.flatMap(([key, value]) => [element('dt', undefined, key), element('dd', undefined, value)]));
}
function renderStatuses(root: HTMLElement, statuses: Record<string, string>): void {
  const rows: StatusRows = Object.entries(statuses).map(([key, value]) => [stripControls(key), stripControls(value)]);
  const visible = rows.filter(([, value]) => value.length > 0); const signature = JSON.stringify(visible);
  if (!visible.length) { if (root.childNodes.length) root.replaceChildren(); statusDisclosures.delete(root); return; }
  let disclosure = statusDisclosures.get(root);
  if (disclosure?.signature === signature) return;
  if (!disclosure) {
    const node = element('details', 'extension-status-details'); const summary = element('summary'); const list = element('dl', 'extension-status-list');
    const preview = element('span', 'extension-status-preview'); const count = element('span', 'extension-status-count');
    summary.append(preview, count); list.tabIndex = 0; list.setAttribute('aria-label', 'All extension statuses');
    disclosure = {node, summary, preview, count, list, rows: [], signature: ''}; const retained = disclosure;
    node.append(summary, list); node.addEventListener('toggle', () => { if (node.open) statusList(retained); });
    root.replaceChildren(node); statusDisclosures.set(root, disclosure);
  }
  disclosure.rows = visible; disclosure.signature = signature;
  const compact = statusPreview(visible);
  setText(disclosure.preview, compact.text); setText(disclosure.count, compact.omitted ? ` · ${compact.omitted} more` : '');
  disclosure.count.hidden = compact.omitted === 0;
  disclosure.summary.setAttribute('aria-label', `${visible.length} extension statuses. Expand for details.`);
  if (disclosure.node.open) statusList(disclosure);
}
type WidgetRoots = {above: HTMLElement; below: HTMLElement};
export function extensionStatus(primary?: PrimaryView, roots?: WidgetRoots): void {
  const extension = primary?.extension;
  renderStatuses(byId('extension-status'), extension?.statuses ?? {});
  if (roots) renderWidgets(extension?.widgets ?? {}, roots);
}
function renderWidgets(widgets: Record<string, {lines: string[]; placement?: string}>, roots: WidgetRoots): void {
  for (const place of ['above', 'below'] as const) {
    const node = roots[place]; node.replaceChildren();
    for (const [key, widget] of Object.entries(widgets)) {
      if ((widget.placement === 'belowEditor' ? 'below' : 'above') !== place) continue;
      const text = widget.lines.map(stripControls).join('\n'); const preview = element('pre', undefined, widget.lines.slice(0, 3).map(stripControls).join('\n')); node.append(preview);
      if (widget.lines.length > 3) node.append(details(`Expand ${key}`, text));
    }
  }
}
