import { createHash, randomUUID } from 'node:crypto';
import type { DialogResponse, DialogView, ExtensionState, PrimaryView } from '../shared/api.ts';
import { safeText } from '../server/projection.mts';
import { RpcError, type RpcClient, type RpcRecord } from './client.mts';
import { type EventProjection, text } from './events.mts';

type SelectOptions = { epoch: number; values: string[]; keys: string[]; bytes: number };
function displayKey(value: unknown): string {
  const raw = text(value);
  if (Buffer.byteLength(raw) > 1024) throw new RpcError('capacity', 'Extension key exceeds the display limit.');
  const label = safeText(raw, 1024).replace(/[\r\n\t]/g, '');
  return label === raw ? raw : `${label}#${createHash('sha256').update(raw).digest('hex')}`;
}

export class Dialogs {
  private timers = new Map<string, NodeJS.Timeout>();
  private selections = new Map<string, SelectOptions>();
  private blockedIds = new Set<string>();
  private view: PrimaryView; private projection: EventProjection; private client: RpcClient; private changed: () => void;
  constructor(view: PrimaryView, projection: EventProjection, client: RpcClient, changed: () => void) {
    this.view = view; this.projection = projection; this.client = client; this.changed = changed;
    view.extension = { statuses: {}, widgets: {} };
  }
  accept(event: RpcRecord): void {
    const method = text(event.method); const id = text(event.id);
    if (id.length > 256) throw new RpcError('protocol_error', 'Extension request ID is too long.');
    if (['select', 'confirm', 'input', 'editor'].includes(method)) this.acceptDialog(event, id, method as DialogView['method']);
    else this.acceptState(event, method);
  }
  private block(id: string, message: string): never {
    if (this.blockedIds.size < 16) this.blockedIds.add(id);
    throw new RpcError('capacity', message);
  }
  private acceptDialog(event: RpcRecord, id: string, method: DialogView['method']): void {
    if (this.view.pendingDialogs.some((dialog) => dialog.id === id)) throw new RpcError('protocol_error', 'Duplicate extension dialog ID.');
    if (this.view.pendingDialogs.length >= 16) this.block(id, 'Too many pending extension dialogs; browser input is blocked.');
    const selection = method === 'select' ? this.selectOptions(event, id) : undefined;
    const dialog = this.dialogView(event, id, method, selection);
    if (Buffer.byteLength(JSON.stringify([...this.view.pendingDialogs, dialog])) > 32 * 1024) this.block(id, 'Extension dialog exceeds the display limit; browser input is blocked.');
    this.timeout(event, dialog);
    if (selection) this.selections.set(id, selection);
    this.view.pendingDialogs.push(dialog); this.changed(); this.projection.emit('extension.request', structuredClone(dialog)); this.projection.state();
  }
  private selectOptions(event: RpcRecord, id: string): SelectOptions {
    if (!Array.isArray(event.options) || event.options.length > 2048) throw new RpcError('protocol_error', 'Invalid extension select options.');
    const values = event.options.map((value) => text(value));
    let sourceBytes = 0;
    for (const value of values) { sourceBytes += Buffer.byteLength(value); if (sourceBytes > 64 * 1024) this.block(id, 'Extension options exceed the private retention limit.'); }
    const bytes = Buffer.byteLength(JSON.stringify(values));
    let retained = bytes; for (const selection of this.selections.values()) retained += selection.bytes;
    if (retained > 64 * 1024) this.block(id, 'Extension options exceed the private retention limit.');
    const epoch = this.view.epoch; const nonce = randomUUID();
    return { values, bytes, epoch, keys: values.map((_value, index) => `${index}:${epoch}:${nonce}`) };
  }
  private dialogView(event: RpcRecord, id: string, method: DialogView['method'], selection?: SelectOptions): DialogView {
    const dialog: DialogView = { id, method, title: safeText(text(event.title)) };
    for (const field of ['message', 'placeholder', 'prefill'] as const) if (event[field] !== undefined) dialog[field] = safeText(text(event[field]));
    if (selection) { dialog.options = selection.values.map((value) => safeText(value)); dialog.optionKeys = [...selection.keys]; }
    return dialog;
  }
  private timeout(event: RpcRecord, dialog: DialogView): void {
    if (event.timeout === undefined) return;
    if (typeof event.timeout !== 'number' || !Number.isFinite(event.timeout) || event.timeout < 0 || event.timeout > 2_147_483_647) throw new RpcError('protocol_error', 'Invalid extension dialog timeout.');
    dialog.deadline = new Date(Date.now() + event.timeout).toISOString();
    this.timers.set(dialog.id, setTimeout(() => this.expire(dialog.id, 'timeout'), event.timeout));
  }
  private acceptState(event: RpcRecord, method: string): void {
    const extension = this.view.extension ?? { statuses: {}, widgets: {} };
    const previous = structuredClone(extension);
    const state = this.stateView(event, method, extension);
    if (Buffer.byteLength(JSON.stringify(extension)) > 16 * 1024) { this.view.extension = previous; throw new RpcError('capacity', 'Extension state exceeds display limit.'); }
    this.view.extension = extension; this.projection.emit('extension.request', state); this.projection.state();
  }
  private stateView(event: RpcRecord, method: string, extension: NonNullable<PrimaryView['extension']>): ExtensionState {
    switch (method) {
      case 'notify': return { method, message: safeText(text(event.message)), notifyType: typeof event.notifyType === 'string' ? event.notifyType : 'info' };
      case 'setStatus': return this.status(event, extension);
      case 'setWidget': return this.widget(event, extension);
      case 'setTitle': extension.title = safeText(text(event.title)); return { method, title: extension.title };
      case 'set_editor_text': return { method, text: safeText(text(event.text)) };
      default: throw new RpcError('unsupported', 'Unsupported extension UI method.');
    }
  }
  private status(event: RpcRecord, extension: NonNullable<PrimaryView['extension']>): ExtensionState {
    const statusKey = displayKey(event.statusKey); const statusText = event.statusText === undefined ? undefined : safeText(text(event.statusText));
    if (statusText === undefined) delete extension.statuses[statusKey];
    else Object.defineProperty(extension.statuses, statusKey, { value: statusText, enumerable: true, configurable: true, writable: true });
    return { method: 'setStatus', statusKey, ...(statusText === undefined ? {} : { statusText }) };
  }
  private widget(event: RpcRecord, extension: NonNullable<PrimaryView['extension']>): ExtensionState {
    const widgetKey = displayKey(event.widgetKey);
    if (event.widgetLines !== undefined && !Array.isArray(event.widgetLines)) throw new RpcError('protocol_error', 'Invalid text widget.');
    const widgetLines = event.widgetLines === undefined ? undefined : (event.widgetLines as unknown[]).slice(0, 2048).map((value) => safeText(text(value)));
    const widgetPlacement = event.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor';
    if (widgetLines === undefined) delete extension.widgets[widgetKey];
    else Object.defineProperty(extension.widgets, widgetKey, { value: { lines: widgetLines, placement: widgetPlacement }, enumerable: true, configurable: true, writable: true });
    return { method: 'setWidget', widgetKey, widgetPlacement, ...(widgetLines === undefined ? {} : { widgetLines }) };
  }
  get blocked(): boolean { return this.blockedIds.size > 0; }
  async respond(id: string, body: DialogResponse): Promise<void> {
    if (body.epoch !== this.view.epoch) throw new RpcError('stale_epoch', 'Dialog belongs to another session epoch.');
    const dialog = this.view.pendingDialogs.find((d) => d.id === id);
    if (!dialog) throw new RpcError('invalid_request', 'Extension dialog is absent or already answered.');
    let response: Record<string, unknown>;
    if ('cancelled' in body && body.cancelled === true) response = { cancelled: true };
    else if (dialog.method === 'confirm' && 'confirmed' in body && typeof body.confirmed === 'boolean') response = { confirmed: body.confirmed };
    else if (dialog.method !== 'confirm' && 'value' in body && typeof body.value === 'string') {
      if (Buffer.byteLength(body.value) > 64 * 1024) throw new RpcError('payload_too_large', 'Dialog response exceeds text limit.');
      response = { value: dialog.method === 'select' ? this.selectValue(id, body.value) : body.value };
    } else throw new RpcError('invalid_request', 'Response does not match the extension dialog method.');
    const allowed = new Set(['epoch', ...Object.keys(response)]);
    if (Object.keys(body).some((k) => !allowed.has(k))) throw new RpcError('invalid_request', 'Invalid dialog response fields.');
    this.expire(id, 'answered');
    await this.client.sendUI({ id, ...response });
  }
  private selectValue(id: string, key: string): string {
    const selection = this.selections.get(id); const index = selection?.keys.indexOf(key) ?? -1;
    if (!selection || selection.epoch !== this.view.epoch || index < 0) throw new RpcError('invalid_request', 'Value is not a supplied select key.');
    return selection.values[index] as string;
  }
  async cancel(): Promise<void> {
    for (const id of this.blockedIds) { await this.client.sendUI({ id, cancelled: true }); this.blockedIds.delete(id); this.projection.emit('extension.expired', { id, reason: 'cancelled' }); }
    const pending = [...this.view.pendingDialogs];
    for (const dialog of pending) { this.expire(dialog.id, 'cancelled'); await this.client.sendUI({ id: dialog.id, cancelled: true }); }
  }
  expireAll(reason: 'epoch-changed' | 'process-exit'): void {
    for (const id of this.blockedIds) this.projection.emit('extension.expired', { id, reason }); this.blockedIds.clear();
    for (const dialog of [...this.view.pendingDialogs]) this.expire(dialog.id, reason);
    this.selections.clear();
  }
  private expire(id: string, reason: 'answered' | 'timeout' | 'epoch-changed' | 'process-exit' | 'cancelled'): void {
    const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id);
    this.selections.delete(id);
    this.view.pendingDialogs = this.view.pendingDialogs.filter((d) => d.id !== id);
    this.changed(); this.projection.emit('extension.expired', { id, reason }); this.projection.state();
  }
}
