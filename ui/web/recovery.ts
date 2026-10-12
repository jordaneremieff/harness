import type { Snapshot, TargetIndex, TargetState, UnconfirmedInput } from '../shared/api.ts';
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
export async function exactInput(workspace: string, item: UnconfirmedInput): Promise<UnconfirmedInput> {
  return item.textTruncated ? request<UnconfirmedInput>(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}`) : item;
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
    const rows = snapshot?.targetIndex?.filter(item => item.hasDraft || item.unconfirmedOperationIds.length) ?? [];
    if (!rows.length) modal.body.append(element('p', 'secondary', 'No saved drafts or unconfirmed messages.'));
    const list = element('div', 'options recovery-targets');
    for (const row of rows) {
      const name = recoveryName(row, snapshot); const node = button('', () => { void modal.run(() => this.target(row), false); }, 'recovery-target');
      const counts = [row.hasDraft ? 'Saved draft' : '', row.unconfirmedOperationIds.length ? `${row.unconfirmedOperationIds.length} unconfirmed ${row.unconfirmedOperationIds.length === 1 ? 'message' : 'messages'}` : ''].filter(Boolean).join(' · ');
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
    if (saved.draft.text) modal.body.append(element('h2', undefined, 'Saved draft'), element('pre', undefined, saved.draft.text), cardAction('copy', 'Copy draft', () => { void copy(saved.draft.text, modal.body); }));
    for (const item of saved.unconfirmed) this.input(saved, item, workspace);
  }
  private input(saved: TargetState, item: UnconfirmedInput, workspace: string): void {
    const modal = this.ctx.modal; const row = element('section', 'notification');
    row.append(element('h2', undefined, 'Send not confirmed'), element('p', undefined, 'Check before you send again.'), element('pre', undefined, item.text));
    if (item.textTruncated) row.append(element('p', 'secondary', 'Preview shortened. Copy the full message.'));
    row.append(cardAction('copy', 'Copy full message', () => { void modal.run(async () => { const exact = await exactInput(workspace, item); await copy(exact.text, row); }, false); }), cardAction('restart', 'Check delivery', () => { void modal.run(async () => {
      const receipt = await request(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {});
      const details = element('details', 'receipt-disclosure'); details.append(element('summary', undefined, 'Delivery details'), element('pre', undefined, JSON.stringify(receipt, null, 2))); row.append(details);
    }, false); }), button('Restore to this draft', () => { void modal.run(async () => {
      await request(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}/restore`, 'POST', {expectedDraftRevision: saved.draft.revision}); await this.ctx.reload(); setText(row, 'Message restored to this draft. No message was sent.');
    }, false); }), button('Discard copy…', () => modal.confirm('Discard message copy', 'This deletes the saved copy only. It does not stop work or confirm whether the message was sent.', async () => {
      await request(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}`, 'DELETE'); await this.ctx.reload(); this.open();
    }, 'Discard copy')));
    if (saved.target.kind === 'agent') row.append(button('Retry original message…', () => modal.confirm('Retry original message', 'Retry the original message without creating a separate request.', async () => {
      await request(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {retry: true}); await this.ctx.reload(); this.open();
    }, 'Retry original message')));
    modal.body.append(row);
  }
}
