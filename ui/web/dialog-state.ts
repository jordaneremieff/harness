import type { DialogResponse, DialogView, Target } from '../shared/api.ts';

export type PrimaryTarget = Extract<Target, { kind: 'primary' }>;
export type DialogValue = { value: string } | { confirmed: boolean } | { cancelled: true };
export interface DialogCommand { target: PrimaryTarget; id: string; response: DialogResponse }
export interface QueuedDialog {
  target: PrimaryTarget;
  dialog: DialogView;
  status: 'pending' | 'responded' | 'expired';
  response?: DialogResponse;
  reason?: string;
}
export interface DialogState { order: string[]; items: ReadonlyMap<string, QueuedDialog> }
export function createDialogs(): DialogState { return { order: [], items: new Map() }; }
function dialogKey(target: PrimaryTarget, id: string): string { return JSON.stringify([target.key, target.epoch, id]); }
function sameTarget(a: PrimaryTarget, b: PrimaryTarget): boolean { return a.key === b.key && a.epoch === b.epoch; }
export function enqueueDialog(state: DialogState, target: PrimaryTarget, dialog: DialogView): DialogState {
  const key = dialogKey(target, dialog.id);
  if (state.items.has(key)) return state;
  const items = new Map(state.items);
  items.set(key, { target, dialog, status: 'pending' });
  return { order: [...state.order, key], items };
}
export function activeDialog(state: DialogState, target: PrimaryTarget): QueuedDialog | undefined {
  for (const key of state.order) {
    const item = state.items.get(key);
    if (item?.status === 'pending' && sameTarget(item.target, target)) return item;
  }
  return undefined;
}
function validResponse(dialog: DialogView, response: DialogValue): boolean {
  if ('cancelled' in response) return response.cancelled === true;
  if (dialog.method === 'confirm') return 'confirmed' in response && typeof response.confirmed === 'boolean';
  if (!('value' in response) || typeof response.value !== 'string') return false;
  return dialog.method !== 'select' || !!(dialog.optionKeys ?? dialog.options)?.includes(response.value);
}
export function respondDialog(state: DialogState, target: PrimaryTarget, id: string, value: DialogValue): { state: DialogState; command?: DialogCommand } {
  const key = dialogKey(target, id);
  const item = state.items.get(key);
  if (item?.status !== 'pending' || !validResponse(item.dialog, value)) return { state };
  const response: DialogResponse = { ...value, epoch: target.epoch };
  const items = new Map(state.items);
  items.set(key, { ...item, status: 'responded', response });
  return { state: { ...state, items }, command: { target, id, response } };
}
export function expireDialog(state: DialogState, target: PrimaryTarget, id: string, reason: string): DialogState {
  const key = dialogKey(target, id);
  const item = state.items.get(key);
  if (!item || item.status === 'expired') return state;
  const items = new Map(state.items);
  items.set(key, { ...item, status: 'expired', reason });
  return { ...state, items };
}
export function cancelDialogs(state: DialogState, target: PrimaryTarget): { state: DialogState; commands: DialogCommand[] } {
  let next = state;
  const commands: DialogCommand[] = [];
  for (const key of state.order) {
    const item = state.items.get(key);
    if (item?.status !== 'pending' || !sameTarget(item.target, target)) continue;
    const result = respondDialog(next, target, item.dialog.id, { cancelled: true });
    next = result.state;
    if (result.command) commands.push(result.command);
  }
  return { state: next, commands };
}
/** Host expiry signals, not browser time, remove requests from the queue. */
export function reconcileDialogs(state: DialogState, target: PrimaryTarget, dialogs: DialogView[]): DialogState {
  let next = state;
  const present = new Set(dialogs.map(item => item.id));
  for (const item of state.items.values()) {
    if (item.status === 'pending' && sameTarget(item.target, target) && !present.has(item.dialog.id)) {
      next = expireDialog(next, target, item.dialog.id, 'snapshot');
    }
  }
  for (const dialog of dialogs) next = enqueueDialog(next, target, dialog);
  return next;
}
export function expirePrimaryDialogs(state: DialogState, key: string, currentEpoch?: number): DialogState {
  let next = state;
  for (const item of state.items.values()) {
    if (item.target.key === key && item.target.epoch !== currentEpoch) {
      next = expireDialog(next, item.target, item.dialog.id, 'epoch-changed');
    }
  }
  return next;
}
