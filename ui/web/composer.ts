import { LIMITS } from '../shared/api.ts';
import type { DraftView, OperationView, Target, TargetIndex, TargetState, UnconfirmedInput } from '../shared/api.ts';
import { announce, byId, button, copy, element, rawText, setText } from './dom.ts';
import { exactInput } from './recovery.ts';
import { targetReceipts } from './receipt.ts';
import { CommandMenu } from './command-menu.ts';
import type { CommandInventory } from './command-menu-state.ts';
import { draftPresentation, SLOW_SAVE_MS } from './draft-presentation.ts';
export type { CommandOption } from './command-menu-state.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
import { acknowledgeDraft, beginDraftSave, captureSubmission, createDraft, draftSaved, editDraft, receiveDraft, rejectDraftSave, resolveDraftConflict, settleSubmission } from './draft-state.ts';
import type { DraftState, Submission } from './draft-state.ts';
import { ApiError, errorMessage, operation, request, reserve } from './transport.ts';

export type ComposerHooks = {submitted: (operation: OperationView) => void; unknownCommand: (text: string, sendLiteral: () => void) => boolean; commands?: () => CommandInventory; retained?: (workspace: string, target: Target, retained: boolean) => void};
type Edit = {text: string; mode: string; edit: number};
type Pending = {submission: Submission; original?: UnconfirmedInput; uncertain: boolean; authorized?: boolean; cleanup?: DraftView; settling?: Promise<void>};
type Buffer = {workspace: string; state: TargetState; data: DraftState; saving?: Promise<DraftView>; submitting: boolean;
  review: boolean; saveError?: string; outstandingSince?: number; slowTimer?: ReturnType<typeof setTimeout>; localCopy?: string; reservation?: {promise: Promise<string>; at: number}; pending: Map<string, Pending>; resolved: Set<string>; notice: string; lastOperation?: OperationView; retained?: boolean};
const encoded = encodeURIComponent;
const sameTarget = (a: Target, b?: Target): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Composer {
  readonly editor: HTMLTextAreaElement;
  private buffers = new Map<string, Buffer>();
  private current?: Buffer;
  private connected = false;
  private gated = false;
  private get admissionBlocked(): boolean { return !this.connected || this.gated; }
  private ready = false;
  private busy = false;
  private sidebar = false;
  private operations: OperationView[] = [];
  private sizePending = false;
  private manualHeight?: number;
  private sizedHeight = 0;
  readonly prefix: 'primary' | 'agent';
  private hooks: ComposerHooks;
  private commandMenu?: CommandMenu;
  private composing = false;
  constructor(prefix: 'primary' | 'agent', hooks: ComposerHooks) {
    this.prefix = prefix; this.hooks = hooks; this.editor = byId(`${prefix}-editor`);
    this.editor.addEventListener('input', () => {
      performance.mark('ui:editor-input'); this.change(this.editor.value);
      requestAnimationFrame(() => { performance.mark('ui:editor-paint'); performance.measure('ui:editor-echo', 'ui:editor-input', 'ui:editor-paint'); });
    });
    this.editor.addEventListener('keydown', event => this.key(event));
    this.editor.addEventListener('compositionstart', () => { this.composing = true; });
    this.editor.addEventListener('compositionend', () => { this.composing = false; });
    if (prefix === 'primary' && hooks.commands) this.commandMenu = new CommandMenu(this.editor, byId('primary-command-menu'), hooks.commands, text => this.change(text));
    this.editor.addEventListener('pointerup', () => {
      if (this.editor.offsetHeight !== this.sizedHeight) this.manualHeight = this.editor.offsetHeight;
    });
    byId<HTMLFormElement>(`${prefix}-composer`).addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    for (const node of this.modes()) node.addEventListener('click', () => this.change(this.editor.value, node.dataset.mode === 'steer' ? 'steer' : 'followUp'));
  }
  placement(sidebar: boolean): void { this.sidebar = sidebar; this.resize(); this.renderControls(); }
  commandsChanged(): void { this.commandMenu?.update(); }
  attach(workspace: string, state?: TargetState): void {
    const previousTarget = this.current?.state.target;
    if (!state) { this.commandMenu?.reset(); }
    if (!state) { this.current = undefined; this.editor.value = ''; this.slot().replaceChildren(); byId(`${this.prefix}-receipt-details`).replaceChildren(); this.render(); return; }
    const key = `${workspace}/${state.targetKey}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = {workspace, state: {...state}, data: createDraft(state.draft), submitting: false, review: false, pending: new Map(), resolved: new Set(), notice: ''};
      this.buffers.set(key, buffer);
    } else {
      buffer.state = {...state, draft: buffer.data.server}; this.receive(buffer, state.draft);
    }
    const switched = this.current !== buffer; this.current = buffer;
    if (switched || !sameTarget(state.target, previousTarget)) this.commandMenu?.reset();
    this.hydrate(buffer, state); this.paint(buffer); this.prepare(buffer);
    this.receipt(buffer); this.flush(buffer);
  }
  updateDraft(draft: DraftView): void { if (this.current) { this.receive(this.current, draft); this.paint(this.current); this.receipt(this.current); } }
  availability(connected: boolean, ready: boolean, busy: boolean, gated = false): void {
    this.connected = connected; this.ready = ready; this.busy = busy; this.gated = gated;
    const buffer = this.current;
    if (buffer) {
      if (this.prefix === 'primary' && busy && buffer.data.mode === 'prompt' && !buffer.submitting) this.change(buffer.data.text, 'steer');
      this.prepare(buffer);
    }
    this.resize(); this.render(); this.commandMenu?.update(); if (!this.admissionBlocked) for (const item of this.buffers.values()) this.flush(item);
  }
  receipts(operations: Iterable<OperationView>): void { this.operations = [...operations]; this.receipt(this.current); this.render(); }
  get unsaved(): boolean { return [...this.buffers.values()].some(item => !draftSaved(item.data) || item.review); }
  private retainedBuffer(workspace: string, target: Target): Buffer | undefined {
    return [...this.buffers.values()].find(item => item.workspace === workspace && sameTarget(item.state.target, target));
  }
  attachRetained(workspace: string, target: Target): boolean {
    const buffer = this.retainedBuffer(workspace, target); this.attach(workspace, buffer?.state); return !!buffer;
  }
  retained(workspace: string, target: Target, index?: TargetIndex): boolean | undefined {
    const buffer = this.retainedBuffer(workspace, target);
    if (index && !sameTarget(index.target, target)) index = undefined;
    if (!buffer) return index ? index.hasDraft || index.unconfirmedOperationIds.length > 0 : undefined;
    if (this.hasRetained(buffer)) return true;
    if (index?.unconfirmedOperationIds.some(id => !buffer.resolved.has(id))) return true;
    return !!index && index.draftRevision > buffer.data.server.revision && index.hasDraft;
  }
  private hasRetained(buffer: Buffer): boolean { return !!buffer.data.text || !draftSaved(buffer.data) || buffer.review || buffer.submitting || buffer.pending.size > 0 || buffer.state.unconfirmed.some(item => !buffer.resolved.has(item.operationId)); }
  private notifyRetained(buffer: Buffer): void {
    const retained = this.hasRetained(buffer); if (buffer.retained === retained) return;
    buffer.retained = retained; this.hooks.retained?.(buffer.workspace, buffer.state.target, retained);
  }
  get target(): Target | undefined { return this.current?.state.target; }
  get state(): TargetState | undefined { return this.current?.state; }
  setText(text: string): void { this.editor.value = text; this.change(text); }
  suggest(text: string): void {
    if (!this.editor.value && this.current && draftSaved(this.current.data)) { this.setText(text); return; }
    this.slot().replaceChildren(element('p', 'warning', 'Pi suggested editor text. Your draft stays unchanged.'), button('Use suggested text', () => this.setText(text)), button('Keep draft', () => this.receipt(this.current)));
  }
  private modes(): NodeListOf<HTMLButtonElement> { return byId(`${this.prefix}-modes`).querySelectorAll<HTMLButtonElement>('button'); }
  private slot(): HTMLElement { return byId(`${this.prefix}-receipt`); }
  private base(buffer: Buffer): string { return `/api/workspaces/${encoded(buffer.workspace)}/targets/${encoded(buffer.state.targetKey)}`; }
  private change(text: string, mode = this.current?.data.mode): void {
    const buffer = this.current; if (!buffer) return;
    buffer.data = editDraft(buffer.data, text, mode); this.notifyRetained(buffer); this.resize(); this.render(); this.commandMenu?.update(); this.flush(buffer);
  }
  private key(event: KeyboardEvent): void {
    if (event.defaultPrevented || this.composing || event.isComposing || event.keyCode === 229) return;
    if (this.commandMenu?.key(event) || event.repeat) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void this.send(); }
  }
  private prepare(buffer: Buffer): void {
    if (this.admissionBlocked || !this.ready || buffer !== this.current || buffer.reservation || buffer.submitting) return;
    const reservation = {promise: reserve(buffer.state.target.kind === 'primary' ? 'primary.input' : 'agent.input', buffer.state.target), at: Date.now()};
    buffer.reservation = reservation;
    void reservation.promise.catch(error => {
      if (buffer.reservation !== reservation) return;
      buffer.reservation = undefined; buffer.notice = errorMessage(error); this.receipt(buffer);
    });
  }
  private paint(buffer: Buffer): void {
    buffer.state.draft = buffer.data.server;
    if (this.current !== buffer) return;
    if (this.editor.value !== buffer.data.text) this.editor.value = buffer.data.text;
    this.resize(); this.render();
  }
  resize(): void {
    if (this.sizePending) return; this.sizePending = true;
    requestAnimationFrame(() => {
      this.sizePending = false;
      if (!this.editor.isConnected) return;
      const style = getComputedStyle(this.editor); const line = Number.parseFloat(style.lineHeight);
      const extra = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
      const short = matchMedia('(max-height: 599px)').matches;
      const baseline = line + extra;
      const available = this.editor.closest<HTMLElement>('.conversation')?.clientHeight ?? innerHeight;
      const cap = Math.max(baseline, Math.min(10 * line + extra, available * (short ? 0.25 : 0.3)));
      this.editor.style.maxHeight = `${cap}px`;
      this.editor.style.height = this.manualHeight === undefined ? '0px' : `${Math.min(cap, Math.max(baseline, this.manualHeight))}px`;
      if (this.manualHeight === undefined) this.editor.style.height = `${Math.min(cap, Math.max(baseline, this.editor.scrollHeight + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)))}px`;
      this.sizedHeight = this.editor.offsetHeight;
    });
  }
  private render(): void {
    const buffer = this.current; const mode = buffer?.data.mode;
    byId(`${this.prefix}-composer`).hidden = !buffer; this.editor.disabled = !buffer;
    this.renderControls();
    byId<HTMLButtonElement>(`${this.prefix}-send`).disabled = !buffer || !this.ready || this.admissionBlocked || buffer.submitting || buffer.review || this.pendingBlocks(buffer) || !buffer.data.text.trim();
    const active = this.deliveryMode(mode);
    for (const node of this.modes()) node.setAttribute('aria-pressed', String(node.dataset.mode === active));
    setText(byId(`${this.prefix}-save`), this.saveSummary(buffer));
  }
  private renderControls(): void {
    const unavailableAgent = this.prefix === 'agent' && this.connected && !this.ready;
    byId(`${this.prefix}-modes`).hidden = !this.ready || !this.connected || (this.prefix === 'primary' && !this.busy);
    if (this.prefix === 'agent') {
      byId('agent-send').hidden = unavailableAgent; byId('agent-acquire').hidden = this.sidebar || !unavailableAgent;
      this.editor.setAttribute('aria-label', unavailableAgent ? 'Draft for this agent' : 'Message to this agent');
      this.editor.placeholder = unavailableAgent ? 'draft only · agent not live' : '';
    }
    byId(`${this.prefix}-send`).setAttribute('aria-description', !this.connected ? 'Connection lost. Reconnect before sending.' : this.gated ? 'View change in progress. Wait before sending.' : !this.ready ? 'No compatible input operation is available.' : '');
    setText(byId(`${this.prefix}-caption`), this.modeCaption());
  }
  private modeCaption(): string {
    if (!this.ready || !this.connected || (this.prefix === 'primary' && !this.busy)) return '';
    return this.deliveryMode(this.current?.data.mode) === 'steer' ? 'steer at next step' : 'follow-up after answer';
  }
  /** A primary prompt draft is delivered as steer while work runs; the saved mode changes on the next edit or send. */
  private deliveryMode(mode?: string): string | undefined {
    return this.prefix === 'primary' && this.busy && mode === 'prompt' ? 'steer' : mode;
  }
  private records(buffer?: Buffer): OperationView[] {
    const operations = this.operations.length ? this.operations : buffer?.lastOperation ? [buffer.lastOperation] : [];
    return targetReceipts(operations, buffer?.state.target);
  }
  private saveSummary(buffer?: Buffer): string {
    if (!buffer) return '';
    return draftPresentation({connected: this.connected, unsaved: !draftSaved(buffer.data), text: buffer.data.text,
      failed: !!buffer.saveError, conflict: buffer.review, outstandingSince: buffer.outstandingSince}, Date.now());
  }
  private receive(buffer: Buffer, draft: DraftView): void {
    for (const pending of buffer.pending.values()) {
      if (draft.revision === pending.submission.draftRevision + 1 && draft.text === '') { pending.cleanup = draft; return; }
    }
    buffer.data = receiveDraft(buffer.data, draft); buffer.state.draft = buffer.data.server;
    if (buffer.data.conflict) this.conflict(buffer);
    else if (draftSaved(buffer.data)) buffer.saveError = undefined;
  }
  private flush(buffer: Buffer): void {
    if (this.admissionBlocked || buffer.submitting || buffer.review || buffer.saving || buffer.saveError || draftSaved(buffer.data)) return;
    void this.save(buffer, buffer.data).then(() => this.flush(buffer), () => {});
  }
  private async save(buffer: Buffer, edit: Edit): Promise<DraftView> {
    if (this.admissionBlocked) throw new Error('Draft save is unavailable. Wait for the current view.');
    const begun = beginDraftSave({...buffer.data, ...edit}); const sent = begun.request;
    if (!sent) throw new Error('Review this draft before submission.');
    buffer.data = {...buffer.data, inFlight: sent}; buffer.saveError = undefined;
    buffer.outstandingSince = Date.now();
    buffer.slowTimer = setTimeout(() => {
      if (buffer.data.inFlight !== sent || !buffer.saving || this.current !== buffer) return;
      this.render();
    }, SLOW_SAVE_MS);
    const saving = (async () => {
      try {
        const draft = await request<DraftView>(`${this.base(buffer)}/draft`, 'PUT', {expectedRevision: sent.expectedRevision, text: sent.text, mode: sent.mode});
        buffer.data = acknowledgeDraft(buffer.data, sent, draft);
        if (draft.revision <= sent.expectedRevision || draft.text !== sent.text || draft.mode !== sent.mode) throw new Error('The saved draft did not match your input.');
        if (buffer.data.conflict) this.conflict(buffer);
        return draft;
      } catch (error) {
        buffer.data = rejectDraftSave(buffer.data, sent);
        this.saveFailure(buffer, error); throw error;
      } finally { clearTimeout(buffer.slowTimer); buffer.slowTimer = undefined; buffer.outstandingSince = undefined; buffer.saving = undefined; this.paint(buffer); this.receipt(buffer); }
    })();
    buffer.saving = saving; this.render(); return saving;
  }
  private saveFailure(buffer: Buffer, error: unknown): void {
    if (error instanceof ApiError && error.view.code === 'stale_revision') this.stale(buffer, error);
    else { buffer.saveError = draftSaved(buffer.data) ? undefined : errorMessage(error); this.receipt(buffer); }
  }
  private stale(buffer: Buffer, error: ApiError): void {
    const value = error.view.details?.value;
    if (!error.view.details?.truncated && value && typeof value === 'object' && 'revision' in value && 'text' in value && 'mode' in value && 'persisted' in value &&
      Number.isSafeInteger(value.revision) && typeof value.text === 'string' && typeof value.mode === 'string' && value.persisted === true) {
      buffer.data = receiveDraft(buffer.data, value as DraftView, true);
    }
    this.conflict(buffer);
  }
  private conflict(buffer: Buffer): void {
    buffer.review = true; buffer.localCopy ??= buffer.data.text; this.receipt(buffer); this.render();
  }
  private async review(buffer: Buffer): Promise<void> {
    try {
      const state = await request<TargetState>(this.base(buffer));
      buffer.data = {...buffer.data, server: state.draft, conflict: state.draft}; buffer.state.draft = state.draft;
      this.receipt(buffer);
    } catch (error) { buffer.notice = errorMessage(error); this.receipt(buffer); }
  }
  private choose(buffer: Buffer, choice: 'local' | 'server'): void {
    if (buffer.saving) return;
    buffer.data = resolveDraftConflict(buffer.data, choice); buffer.review = false; buffer.localCopy = undefined; buffer.notice = ''; buffer.saveError = undefined;
    this.paint(buffer); this.receipt(buffer); this.flush(buffer);
  }
  private receipt(buffer?: Buffer): void {
    if (buffer) this.notifyRetained(buffer);
    if (!buffer || this.current !== buffer) return;
    const slot = this.slot(); slot.replaceChildren();
    const records = this.records(buffer); this.receiptDetails(records);
    this.controlExceptions(buffer, records, slot);
    this.receiptNotices(buffer, records, slot);
    if (buffer.review) {
      slot.append(element('p', 'warning', 'Draft changed in another tab · Review'), element('pre', undefined, buffer.localCopy ?? buffer.data.text), button('Review', () => { void this.review(buffer); }));
      if (buffer.data.conflict) slot.append(element('p', undefined, 'Draft on the Mac'), element('pre', undefined, buffer.data.conflict.text), button('Use Mac draft', () => this.choose(buffer, 'server')), button('Keep my copy', () => this.choose(buffer, 'local')));
    }
    for (const pending of buffer.pending.values()) if (pending.uncertain) this.recovery(buffer, pending, slot);
  }
  private receiptNotices(buffer: Buffer, records: OperationView[], slot: HTMLElement): void {
    const ordinary = buffer.lastOperation?.state === 'accepted' && ['Admitted', 'Steer admitted'].includes(buffer.notice);
    if (buffer.notice && !ordinary && buffer.notice !== buffer.saveError) slot.append(element('p', 'warning', buffer.notice));
    this.inputReceiptNotice(buffer, records.find(inputOperation), slot);
    if (!buffer.saveError || buffer.review) return;
    const retry = button('Retry', () => { if (this.current !== buffer || this.admissionBlocked || buffer.saving) return; if (buffer.notice === buffer.saveError) buffer.notice = ''; buffer.saveError = undefined; this.render(); this.receipt(buffer); this.flush(buffer); });
    retry.disabled = this.admissionBlocked || !!buffer.saving;
    slot.append(element('p', 'warning', `Draft not saved · ${buffer.saveError}`), retry);
  }
  private inputReceiptNotice(buffer: Buffer, record: OperationView | undefined, slot: HTMLElement): void {
    if (!record || buffer.pending.has(record.id)) return;
    const queued = record.state === 'accepted' && record.receipt?.kind === 'rpc' && record.receipt.disposition === 'queued';
    const label = queued ? 'Follow-up queued' : ['uncertain', 'rejected'].includes(record.state) ? operationLabel(record) : '';
    if (label && buffer.notice !== label) slot.append(element('p', queued ? 'secondary' : 'warning', label));
  }
  private receiptDetails(records: OperationView[]): void {
    const disclosure = byId(`${this.prefix}-receipt-details`);
    const key = this.current?.state.targetKey ?? '';
    const expanded = disclosure.dataset.targetKey === key && disclosure.querySelector<HTMLDetailsElement>('details')?.open;
    disclosure.replaceChildren(); disclosure.dataset.targetKey = key;
    if (!records.length) return;
    const latest = [records.find(inputOperation), records.find(item => !inputOperation(item))].filter((item): item is OperationView => !!item);
    const node = element('details'); const pre = element('pre'); node.open = !!expanded;
    const paint = (): void => {
      if (!node.open) return;
      setText(pre, latest.map(item => {
        const raw = rawText(item); return `${inputOperation(item) ? 'Input receipt' : 'Control receipt'}\n${raw.slice(0, 65536)}${raw.length > 65536 ? '\nReceipt data display limited.' : ''}`;
      }).join('\n\n'));
    };
    node.append(element('summary', undefined, 'Details'), pre); node.addEventListener('toggle', paint); paint(); disclosure.append(node);
  }
  private controlExceptions(buffer: Buffer, records: OperationView[], slot: HTMLElement): void {
    for (const item of records) {
      if (inputOperation(item) || !['uncertain', 'rejected'].includes(item.state)) continue;
      slot.append(element('p', 'warning', operationLabel(item)));
      if (item.state === 'uncertain') slot.append(button('Check control receipt', () => {
        void request<OperationView>(`/api/operations/${encoded(item.id)}/reconcile`, 'POST', {}).then(result => this.hooks.submitted(result)).catch(error => { buffer.notice = errorMessage(error); this.receipt(buffer); });
      }));
    }
  }
  private recovery(buffer: Buffer, pending: Pending, slot: HTMLElement): void {
    const captured = pending.submission; const row = element('div');
    row.append(element('p', 'warning', 'Send not confirmed'), element('pre', undefined, `${JSON.stringify(captured.target)}\n${captured.operationId}\n${captured.mode} · revision ${captured.draftRevision}`), element('pre', undefined, captured.text));
    if (pending.original?.textTruncated) row.append(element('p', 'secondary', 'Preview limited. Copy and Restore fetch the exact retained text.'));
    row.append(button('Check receipt', () => { void this.check(buffer, pending); }), button('Copy', () => { void this.exact(buffer, pending).then(item => copy(item.text, row)).catch(error => this.recoveryError(buffer, error)); }), button('Restore to draft', () => {
      void this.exact(buffer, pending).then(item => {
        if (buffer.data.text && buffer.data.text !== item.text) row.append(element('p', undefined, 'Your newer draft stays unchanged. Copy the original text or explicitly replace the draft.'), button('Replace draft with original', () => this.restore(buffer, item)));
        else this.restore(buffer, item);
      }).catch(error => this.recoveryError(buffer, error));
    }));
    if (!pending.authorized && captured.target.kind === 'primary') row.append(button('Send again…', () => {
      row.append(element('p', 'warning', 'The original input might already be admitted. A new submission risks duplicate work.'), button('Confirm duplicate risk and send', () => {
        if (this.current !== buffer || buffer.submitting) return;
        pending.authorized = true; buffer.data = settleSubmission(buffer.data, captured, 'rejected'); void this.send();
      }));
    }));
    slot.append(row);
  }
  private recoveryError(buffer: Buffer, error: unknown): void { buffer.notice = errorMessage(error); this.receipt(buffer); }
  private async exact(buffer: Buffer, pending: Pending): Promise<Submission> {
    if (!pending.original?.textTruncated) return pending.submission;
    const item = await exactInput(buffer.workspace, pending.original); const previous = pending.submission;
    if (item.textTruncated || item.operationId !== previous.operationId || !sameTarget(previous.target, item.target) || item.mode !== previous.mode || item.submittedDraftRevision !== previous.draftRevision) throw new Error('The retained copy does not match the captured input.');
    pending.submission = {...previous, text: item.text}; pending.original = item;
    if (buffer.data.submissions.get(previous.operationId) === previous) buffer.data = {...buffer.data, submissions: new Map(buffer.data.submissions).set(previous.operationId, pending.submission)};
    return pending.submission;
  }
  private restore(buffer: Buffer, captured: Submission): void {
    buffer.data = editDraft(buffer.data, captured.text, captured.mode); this.paint(buffer); this.flush(buffer);
  }
  private async check(buffer: Buffer, pending: Pending): Promise<void> {
    try {
      const result = await request<OperationView>(`/api/operations/${encoded(pending.submission.operationId)}/reconcile`, 'POST', {});
      if (!this.updateOperation(result)) throw new Error('The receipt does not match the original operation.');
      this.hooks.submitted(result);
    } catch (error) { buffer.notice = `${errorMessage(error)} The original admission remains unknown.`; this.receipt(buffer); }
  }
  private hydrate(buffer: Buffer, state: TargetState): void {
    for (const item of state.unconfirmed) {
      if (buffer.pending.has(item.operationId) || buffer.resolved.has(item.operationId)) continue;
      const matches = (item.textTruncated || buffer.data.text === item.text) && buffer.data.mode === item.mode && buffer.data.server.revision === item.submittedDraftRevision;
      const submission: Submission = {operationId: item.operationId, target: {...item.target}, text: item.textTruncated && matches ? buffer.data.server.text : item.text, mode: item.mode, draftRevision: item.submittedDraftRevision, edit: matches ? buffer.data.edit : -1};
      buffer.pending.set(item.operationId, {submission, original: item, uncertain: true});
      buffer.data = {...buffer.data, submissions: new Map(buffer.data.submissions).set(item.operationId, submission)};
    }
  }
  updateOperation(result: OperationView): boolean {
    for (const buffer of this.buffers.values()) {
      const pending = buffer.pending.get(result.id);
      if (!pending || !sameTarget(pending.submission.target, result.target)) continue;
      void this.finish(buffer, pending, result); return true;
    }
    return false;
  }
  private finish(buffer: Buffer, pending: Pending, result: OperationView): Promise<void> {
    if (pending.settling) return pending.settling;
    buffer.lastOperation = result;
    if (result.state !== 'accepted' && result.state !== 'rejected') {
      pending.uncertain = true; buffer.notice = 'Check the receipt before another submission.'; this.receipt(buffer); return Promise.resolve();
    }
    const outcome = result.state;
    pending.settling = Promise.resolve().then(async () => {
      pending.uncertain = false; buffer.data = settleSubmission(buffer.data, pending.submission, outcome);
      buffer.notice = this.admissionNotice(result, pending.submission);
      this.paint(buffer); this.receipt(buffer); announce(buffer.notice);
      if (outcome === 'accepted') await this.refreshAccepted(buffer, pending);
      buffer.pending.delete(result.id); buffer.resolved.add(result.id);
      if (buffer.resolved.size > LIMITS.operations) buffer.resolved.delete(buffer.resolved.values().next().value as string);
      this.paint(buffer); this.receipt(buffer); this.flush(buffer);
    });
    return pending.settling;
  }
  private async refreshAccepted(buffer: Buffer, pending: Pending): Promise<void> {
    try {
      const draft = pending.cleanup ?? (await request<TargetState>(this.base(buffer))).draft;
      if (draft.text === '' && draft.revision === pending.submission.draftRevision + 1 && draft.revision >= buffer.data.server.revision) {
        const savedEdit = buffer.data.text === '' ? buffer.data.edit : buffer.data.savedEdit === buffer.data.edit ? -1 : buffer.data.savedEdit;
        buffer.data = {...buffer.data, server: draft, savedEdit};
      } else this.receive(buffer, draft);
    } catch (error) { buffer.notice = errorMessage(error); this.receipt(buffer); }
  }
  private admissionNotice(result: OperationView, submission: Submission): string {
    if (result.state !== 'accepted') return result.error?.message ?? 'Input refused';
    if (result.receipt?.kind === 'rpc' && result.receipt.disposition === 'queued') return 'Follow-up queued';
    return submission.mode === 'steer' ? 'Steer admitted' : 'Admitted';
  }
  private pendingBlocks(buffer: Buffer): boolean {
    return [...buffer.pending.values()].some(item => !item.authorized && (buffer.state.target.kind === 'primary' || item.submission.text === buffer.data.text));
  }
  private blocked(buffer: Buffer): boolean {
    if (this.admissionBlocked || !this.ready || buffer.submitting || buffer.review || !buffer.data.text.trim()) return true;
    if (this.pendingBlocks(buffer)) { this.receipt(buffer); return true; }
    return false;
  }
  async send(literal = false): Promise<void> {
    const buffer = this.current; if (!buffer || this.blocked(buffer)) return;
    this.commandMenu?.close();
    const snapshot: Edit = {text: buffer.data.text, mode: this.prefix === 'primary' && !this.busy ? 'prompt' : this.deliveryMode(buffer.data.mode) ?? buffer.data.mode, edit: buffer.data.edit};
    const confirmation = {target: {...buffer.state.target}, revision: buffer.data.server.revision, mode: buffer.data.mode};
    if (!literal && this.prefix === 'primary' && this.hooks.unknownCommand(snapshot.text, () => {
      if (this.current === buffer && sameTarget(confirmation.target, buffer.state.target) && buffer.data.text === snapshot.text &&
        buffer.data.edit === snapshot.edit && buffer.data.server.revision === confirmation.revision && buffer.data.mode === confirmation.mode) void this.send(true);
    })) return;
    // Mode is part of the saved payload, including an idle primary's prompt mode.
    if (snapshot.mode !== buffer.data.mode) { buffer.data = editDraft(buffer.data, snapshot.text, snapshot.mode); snapshot.edit = buffer.data.edit; }
    buffer.submitting = true; buffer.lastOperation = undefined; buffer.notice = 'Sending…'; this.render(); this.receipt(buffer);
    const reservation = buffer.reservation;
    let pending: Pending | undefined;
    try {
      await this.confirmSaved(buffer, snapshot);
      if (this.admissionBlocked) throw new Error('Input is unavailable. Wait for the current view before sending.');
      pending = await this.capture(buffer, snapshot, reservation);
      const result = await this.dispatch(pending.submission, literal);
      if (result.id !== pending.submission.operationId || !sameTarget(pending.submission.target, result.target)) throw new Error('The response did not match the submitted operation.');
      await this.finish(buffer, pending, result); this.hooks.submitted(result);
    } catch (error) { this.sendError(buffer, pending, error); }
    finally { buffer.submitting = false; this.paint(buffer); this.receipt(buffer); this.prepare(buffer); if (pending?.settling) this.flush(buffer); }
  }
  private async confirmSaved(buffer: Buffer, snapshot: Edit): Promise<void> {
    if (buffer.saving) await buffer.saving;
    if (buffer.review) throw new Error('Review this draft before submission.');
    if (buffer.data.server.text !== snapshot.text || buffer.data.server.mode !== snapshot.mode || buffer.data.savedEdit < snapshot.edit) await this.save(buffer, snapshot);
    if (buffer.review) throw new Error('Review this draft before submission.');
  }
  private async capture(buffer: Buffer, snapshot: Edit, reservation?: Buffer['reservation']): Promise<Pending> {
    buffer.reservation = undefined;
    if (reservation && Date.now() - reservation.at >= LIMITS.reservationMs) throw new Error('Input reservation expired. Your text was not sent. Send again with a new reservation.');
    const target = {...buffer.state.target};
    const id = reservation ? await reservation.promise : await reserve(target.kind === 'primary' ? 'primary.input' : 'agent.input', target);
    const captured = captureSubmission({...buffer.data, ...snapshot, savedEdit: snapshot.edit}, target, id);
    if (!captured.submission) throw new Error('This draft already has a pending submission.');
    buffer.data = {...buffer.data, submissions: captured.state.submissions};
    const pending = {submission: captured.submission, uncertain: false}; buffer.pending.set(id, pending); return pending;
  }
  private dispatch(submission: Submission, literal: boolean): Promise<OperationView> {
    const target = submission.target;
    const path = target.kind === 'primary' ? `/api/primaries/${encoded(target.key)}/inputs` : `/api/agents/${encoded(target.identity)}/inputs`;
    const body = target.kind === 'primary' ? {epoch: target.epoch, message: submission.text, mode: submission.mode, draftRevision: submission.draftRevision, literal} : {message: submission.text, mode: submission.mode, draftRevision: submission.draftRevision};
    return operation(target.kind === 'primary' ? 'primary.input' : 'agent.input', path, body, target, submission.operationId);
  }
  private sendError(buffer: Buffer, pending: Pending | undefined, error: unknown): void {
    buffer.notice = errorMessage(error);
    if (pending && (!(error instanceof ApiError) || ['delivery_uncertain', 'internal'].includes(error.view.code))) pending.uncertain = true;
    else if (pending) {
      buffer.data = settleSubmission(buffer.data, pending.submission, 'rejected'); buffer.pending.delete(pending.submission.operationId);
      if (pending.cleanup) this.receive(buffer, pending.cleanup);
    }
    if (error instanceof ApiError && error.view.code === 'stale_revision') this.stale(buffer, error);
    if (error instanceof ApiError && error.view.code === 'unknown_operation') buffer.notice = 'Input reservation expired or unknown. Your text was not sent. Send again with a new reservation.';
    this.receipt(buffer); announce(buffer.notice);
  }
}
