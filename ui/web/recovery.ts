import type { Snapshot, TargetIndex, TargetState, UnconfirmedInput } from '../shared/api.ts';
import { button, copy, element, setText } from './dom.ts';
import type { Modal } from './modal.ts';
import { request } from './transport.ts';
export type RecoveryContext = {snapshot: () => Snapshot | undefined; reload: () => Promise<void>; modal: Modal};
function label(index: TargetIndex): string {
  return index.target.kind === 'primary' ? `Primary ${index.target.key} · conversation ${index.target.epoch}` : `Agent ${index.target.identity}`;
}
export async function exactInput(workspace: string, item: UnconfirmedInput): Promise<UnconfirmedInput> {
  return item.textTruncated ? request<UnconfirmedInput>(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}`) : item;
}
export class Recovery {
  private ctx: RecoveryContext;
  constructor(ctx: RecoveryContext) { this.ctx = ctx; }
  open(): void {
    const modal = this.ctx.modal; modal.open('Saved drafts and input copies');
    const token = modal.token; modal.body.append(element('p', 'secondary', 'Loading saved drafts'));
    void modal.run(async () => { await this.ctx.reload(); if (modal.owns(token)) this.paint(); }, false);
  }
  private paint(): void {
    const snapshot = this.ctx.snapshot(); const modal = this.ctx.modal;
    modal.open('Saved drafts and input copies');
    const rows = snapshot?.targetIndex?.filter(item => item.hasDraft || item.unconfirmedOperationIds.length) ?? [];
    if (!rows.length) modal.body.append(element('p', 'secondary', 'No saved drafts or unconfirmed input copies.'));
    for (const row of rows) {
      const node = button(label(row), () => { void modal.run(() => this.target(row), false); });
      node.append(element('span', 'secondary', `${row.hasDraft ? 'Saved draft' : ''}${row.unconfirmedOperationIds.length ? ' · Input copies' : ''}`)); modal.body.append(node);
    }
  }
  private async target(index: TargetIndex): Promise<void> {
    const workspace = this.ctx.snapshot()?.workspace.id; if (!workspace) return;
    const modal = this.ctx.modal; const token = modal.token;
    const saved = await request<TargetState>(`/api/workspaces/${encodeURIComponent(workspace)}/targets/${encodeURIComponent(index.targetKey)}`);
    if (!modal.owns(token)) return; modal.open(label(index));
    if (saved.draft.text) modal.body.append(element('h2', undefined, 'Saved draft'), element('pre', undefined, saved.draft.text), button('Copy draft', () => { void copy(saved.draft.text, modal.body); }));
    for (const item of saved.unconfirmed) this.input(saved, item, workspace);
  }
  private input(saved: TargetState, item: UnconfirmedInput, workspace: string): void {
    const modal = this.ctx.modal; const row = element('section', 'notification');
    row.append(element('h2', undefined, 'Send not confirmed'), element('pre', undefined, item.text));
    if (item.textTruncated) row.append(element('p', 'secondary', 'Preview limited. Copy fetches the exact retained text.'));
    row.append(button('Copy exact text', () => { void modal.run(async () => { const exact = await exactInput(workspace, item); await copy(exact.text, row); }, false); }), button('Check receipt', () => { void modal.run(async () => {
      const receipt = await request(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {}); row.append(element('pre', undefined, JSON.stringify(receipt, null, 2)));
    }, false); }), button('Restore to this target’s draft', () => { void modal.run(async () => {
      await request(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}/restore`, 'POST', {expectedDraftRevision: saved.draft.revision}); await this.ctx.reload(); setText(row, 'Restored to the captured target’s draft. This did not send input.');
    }, false); }), button('Discard copy…', () => modal.confirm('Discard input copy', 'This deletes only the local copy. It does not cancel work or prove non-admission.', async () => {
      await request(`/api/workspaces/${encodeURIComponent(workspace)}/unconfirmed/${encodeURIComponent(item.operationId)}`, 'DELETE'); await this.ctx.reload(); this.open();
    }, 'Discard copy')));
    if (saved.target.kind === 'agent') row.append(button('Retry same native request key…', () => modal.confirm('Retry same agent input key', 'This repeats only the captured native request key and exact input after fresh contract checks. It does not create a new request.', async () => {
      await request(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {retry: true}); await this.ctx.reload(); this.open();
    }, 'Retry same key')));
    modal.body.append(row);
  }
}
