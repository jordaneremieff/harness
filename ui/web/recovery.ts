import { draftHasContent } from '../shared/api.ts';
import type { InputCopy, RecoveryInput, Snapshot, TargetIndex, TargetState } from '../shared/api.ts';
import { attachmentSummary } from './composer-attachments.ts';
import {cardAction} from './card-icons.ts';
import {navigateOptions} from './list-navigation.ts';
import { button, copy, element, setText } from './dom.ts';
import type { Modal } from './modal.ts';
import { request } from './transport.ts';
export type RecoveryContext = {snapshot: () => Snapshot | undefined; reload: () => Promise<void>; modal: Modal};
function identity(index: TargetIndex): string {
  return index.target.kind === 'primary' ? `Primary session ${index.target.key} · conversation ${index.target.epoch}` : `Agent ${index.target.identity}`;
}
export function recoveryName(index: TargetIndex, snapshot?: Snapshot): string {
  const target = index.target;
  if (target.kind === 'primary') {
    const primary = snapshot?.primaries.find(item => item.key === target.key && item.epoch === target.epoch);
    return primary?.extension?.title ?? primary?.sessionName ?? `Primary conversation ${target.epoch}`;
  }
  const row = snapshot?.roster?.rows.find(item => item.identity === target.identity);
  return row?.name ?? row?.handle ?? 'Agent';
}
function recoveryContent(row: TargetIndex, name: string): HTMLElement {
  const content = element('span', 'recovery-content'); content.append(element('span', 'recovery-name', name));
  if (row.hasDraft && row.draftPreview !== undefined) {
    content.append(element('span', 'recovery-preview secondary', row.draftPreview));
    if (row.draftPreviewTruncated) content.append(element('span', 'secondary', 'Preview shortened.'));
  }
  return content;
}
export async function exactInput(workspace: string, item: Pick<InputCopy, 'operationId'>): Promise<RecoveryInput> {
  const exact = await request<RecoveryInput>(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}`);
  if (exact.operationId !== item.operationId || exact.textTruncated) throw new Error('The saved copy could not be read completely.');
  return exact;
}
export function recoveryLabel(item: RecoveryInput): {title: string; warning: string} {
  if (item.admission === 'queued-image') return {title: 'Queued image copy', warning: 'The original input was admitted. It might already have run. Current queue membership is unknown.'};
  if (item.admission === 'handled-image') return {title: 'Input handled; images not confirmed', warning: 'The original input was handled. Image delivery is not confirmed.'};
  if (item.admission === 'refused') return {title: 'Message not sent', warning: 'This attempt was refused. The original draft is retained without an admission receipt.'};
  return {title: 'Send not confirmed', warning: 'Check before you send again. This copy does not prove that the original was not sent.'};
}
export class Recovery {
  private ctx: RecoveryContext;
  constructor(ctx: RecoveryContext) { this.ctx = ctx; }
  open(): void {
    const modal = this.ctx.modal; modal.open('Saved drafts and messages');
    const token = modal.token; modal.body.append(element('p', 'secondary', 'Loading saved drafts…'));
    void modal.run(async () => { await this.ctx.reload(); if (modal.owns(token)) this.paint(); }, false);
  }
  private paint(): void {
    const snapshot = this.ctx.snapshot(); const modal = this.ctx.modal;
    modal.open('Saved drafts and messages');
    const rows = snapshot?.targetIndex?.filter(item => item.hasDraft || item.unconfirmedOperationIds.length || item.retainedInputOperationIds.length) ?? [];
    if (!rows.length) modal.body.append(element('p', 'secondary', 'No saved drafts or retained messages.'));
    const list = element('div', 'options recovery-targets');
    for (const row of rows) {
      const name = recoveryName(row, snapshot); const node = button('', () => { void modal.run(() => this.target(row), false); }, 'recovery-target');
      const counts = [row.hasDraft ? 'Saved draft' : '', row.unconfirmedOperationIds.length ? `${row.unconfirmedOperationIds.length} unconfirmed ${row.unconfirmedOperationIds.length === 1 ? 'message' : 'messages'}` : '', row.retainedInputOperationIds.length ? `${row.retainedInputOperationIds.length} retained ${row.retainedInputOperationIds.length === 1 ? 'copy' : 'copies'}` : ''].filter(Boolean).join(' · ');
      node.append(recoveryContent(row, name), element('span', 'recovery-count secondary', counts));
      node.title = identity(row); node.setAttribute('aria-label', `${name}, ${counts}`); node.setAttribute('aria-description', identity(row)); list.append(node);
    }
    list.addEventListener('keydown', event => navigateOptions(event, list)); modal.body.append(list);
  }
  private async target(index: TargetIndex): Promise<void> {
    const workspace = this.ctx.snapshot()?.workspace.id; if (!workspace) return;
    const modal = this.ctx.modal; const token = modal.token;
    const saved = await request<TargetState>(`/api/workspaces/${encodeURIComponent(workspace)}/targets/${encodeURIComponent(index.targetKey)}`);
    if (!modal.owns(token)) return; modal.open(recoveryName(index, this.ctx.snapshot())); modal.body.append(element('p', 'identity', identity(index)));
    if (JSON.stringify(saved.target) !== JSON.stringify(index.target) || saved.targetKey !== index.targetKey) throw new Error('The saved recipient changed.');
    if (draftHasContent(saved.draft)) modal.body.append(element('h2', undefined, 'Saved draft'), element('pre', undefined, saved.draft.text), attachmentSummary(workspace, saved.targetKey, saved.draft.images), cardAction('copy', 'Copy draft text only', () => { void copy(saved.draft.text, modal.body); }));
    if (saved.imageStorageError) modal.body.append(element('p', 'warning', saved.imageStorageError.message));
    if (saved.recoveryPreviewTruncated) modal.body.append(element('p', 'secondary', 'Some previews are omitted. Each saved copy remains available below.'));
    const ids = new Set([...index.unconfirmedOperationIds, ...index.retainedInputOperationIds]);
    for (const id of ids) {
      const row = element('section', 'notification'); const preview = [...saved.unconfirmed, ...saved.retainedInputs].find(item => item.operationId === id);
      row.append(element('p', 'identity', id));
      if (preview) row.append(element('pre', undefined, preview.text), attachmentSummary(workspace, saved.targetKey, preview.images));
      row.append(button('Review saved copy', () => {void modal.run(async () => {
        const token = modal.token, item = await exactInput(workspace, {operationId: id});
        if (!modal.owns(token)) return;
        if (JSON.stringify(item.target) !== JSON.stringify(saved.target)) throw new Error('The saved copy has a different recipient.');
        row.replaceChildren(); this.input(saved, item, workspace, row);
      }, false);})); modal.body.append(row);
    }
  }
  private input(saved: TargetState, item: RecoveryInput, workspace: string, row: HTMLElement): void {
    const modal = this.ctx.modal, label = recoveryLabel(item);
    row.append(element('h2', undefined, label.title), element('p', undefined, label.warning), element('pre', undefined, item.text), attachmentSummary(workspace, saved.targetKey, item.images));
    if (item.admission === 'refused' && item.error) row.append(element('p', 'warning', item.error.message));
    if (item.admission === 'unconfirmed' && item.sendGuard?.state === 'blocked') row.append(element('p', 'warning', 'Image copies remain from this queue clear. Restore and review the full copy before a separate message.'));
    if (item.admission === 'unconfirmed' && item.sendGuard?.state === 'unavailable') row.append(element('p', 'warning', 'Queue recovery information is unavailable. Confirmation does not permit a send.'));
    row.append(cardAction('copy', 'Copy text only', () => {void copy(item.text, row);}), button('Restore to this draft', () => {void modal.run(async () => {
      await request(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}/restore`, 'POST', {expectedDraftRevision: saved.draft.revision});
      await this.ctx.reload(); setText(row, 'The complete copy was restored to its draft. No message was sent.');
    }, false);}), button('Discard copy…', () => modal.confirm('Discard message copy', 'Delete only this saved copy. This does not cancel work or establish whether the original ran.', async () => {
      await request(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}`, 'DELETE'); await this.ctx.reload(); this.open();
    }, 'Discard copy')));
    if (item.admission === 'unconfirmed') row.append(cardAction('restart', 'Check delivery', () => {void modal.run(async () => {
      const receipt = await request(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {});
      const details = element('details', 'receipt-disclosure'); details.append(element('summary', undefined, 'Delivery details'), element('pre', undefined, JSON.stringify(receipt, null, 2))); row.append(details);
    }, false);}));
    if (item.admission === 'unconfirmed' && saved.target.kind === 'agent') row.append(button('Retry original message…', () => modal.confirm('Retry original message', 'Retry the original message with its existing request key.', async () => {
      await request(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {retry: true}); await this.ctx.reload(); this.open();
    }, 'Retry original message')));
    if (item.admission === 'queued-image' || item.admission === 'handled-image') {
      const details = element('details', 'receipt-disclosure'); details.append(element('summary', undefined, 'Admission receipt'), element('pre', undefined, JSON.stringify(item.receipt, null, 2))); row.append(details);
    }
  }
}
