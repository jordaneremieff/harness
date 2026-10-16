import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, sameDraftTuple } from '../shared/api.ts';
import type {DraftImage} from '../shared/api.ts';
import {normalizeDraftImages} from './validate.mts';
import type { ErrorView, OperationKind, OperationView, Target } from '../shared/api.ts';
import { StateError, sameTarget, validateTarget } from './state.mts';
import type { StateStore } from './state.mts';
import type { OperationRecord } from './state.mts';
import { projectJson, safeText } from './projection.mts';
import {withPrimaryOperation} from '../rpc/primary-operation.mts';

const KINDS: OperationKind[] = ['primary.open', 'primary.input', 'primary.stop', 'primary.session', 'primary.control', 'primary.dialog', 'primary.handoff', 'agent.input', 'agent.abort', 'agent.configure'];
const terminal = (record: {view: {state: string}; input?: unknown; inputResolved?: boolean; retainedInput?: unknown; protected?: boolean}) => ['accepted', 'rejected', 'completed'].includes(record.view.state) && (!record.input || record.inputResolved) && !record.retainedInput && !record.protected;
export type ExecuteRequest = {workspaceId: string; kind: OperationKind; target?: Target; body: unknown;
  input?: {targetKey: string; text: string; mode: string; draftRevision: number; images?: DraftImage[]; differentMessage?: true}; retryUncertainNative?: boolean};
export type DispatchResult = {state: 'accepted' | 'completed' | 'rejected'; receipt?: OperationView['receipt']; error?: ErrorView};
export const nativeRequestId = (id: string): string => `ui:${id}`;

function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw new StateError('invalid_request', 'Operation body nesting exceeds its limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(',')}}`;
  }
  throw new StateError('invalid_request', 'Operation body must contain only JSON values');
}
function publicError(error: ErrorView): ErrorView {
  return {code: safeText(error.code, 256), message: safeText(error.message, 2048), retry: ['none', 'read', 'same-operation', 'manual'].includes(error.retry) ? error.retry : 'manual', ...(error.details ? {details: projectJson(error.details.value)} : {})};
}

function requestDigest(request: ExecuteRequest): string {
    const images = request.input ? normalizeDraftImages(request.input.images) : [];
    const digestInput = request.input ? {...request.input} : null;
    const digestBody = request.kind.endsWith('.input') && request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? {...request.body} as Record<string, unknown> : request.body;
    if (digestInput) { if (images.length) digestInput.images = images; else delete digestInput.images; }
    if (request.kind.endsWith('.input') && digestBody && typeof digestBody === 'object' && !Array.isArray(digestBody)) { if (images.length) (digestBody as Record<string, unknown>).images = images; else delete (digestBody as Record<string, unknown>).images; }
    const body = canonical(digestBody);
    if (Buffer.byteLength(body) > LIMITS.requestBytes) throw new StateError('payload_too_large', 'Operation body exceeds its limit', 413);
    return createHash('sha256').update(canonical({body: digestBody, input: digestInput})).digest('hex');
  }

export class Operations {
  private readonly now: () => number;
  readonly store: StateStore;
  private hooks?: {complete(record: OperationRecord, result: DispatchResult): Promise<void>; reconcile(record: OperationRecord): Promise<DispatchResult | undefined>; acknowledged?(record: OperationRecord): Promise<void>};
  constructor(store: StateStore, options: {now?: () => number} = {}) { this.store = store; this.now = options.now ?? Date.now; }
  retainWith(hooks: NonNullable<Operations['hooks']>) {this.hooks = hooks;}
  private stamp(): string { return new Date(this.now()).toISOString(); }
  private async prune(): Promise<void> {
    for (const record of this.store.operationMetadata()) {
      if (record.view.state === 'reserved' && this.now() - Date.parse(record.view.createdAt) >= LIMITS.reservationMs) await this.store.deleteOperation(record.view.id);
    }
  }
  reserve(workspaceId: string, kind: OperationKind, target?: Target): Promise<OperationView> {
    return this.store.transaction(async () => {
      if (!KINDS.includes(kind)) throw new StateError('invalid_request', 'Unknown operation kind');
      if (target) validateTarget(target);
      if (kind !== 'primary.open' && (!target || (kind.startsWith('primary.') ? target.kind !== 'primary' : target.kind !== 'agent'))) throw new StateError('invalid_request', 'Operation requires its exact target');
      // A workspace lookup uses the already-loaded bounded state, not directory enumeration.
      await this.store.getWorkspaceForOperation(workspaceId);
      await this.prune();
      if (this.store.operationMetadata().filter(record => record.workspaceId === workspaceId && record.view.state === 'reserved').length >= LIMITS.workspaceReservations) throw new StateError('capacity', 'Too many reserved operations in this workspace', 429);
      const at = this.stamp();
      const view: OperationView = {id: randomUUID(), kind, ...(target ? {target: structuredClone(target)} : {}), state: 'reserved', createdAt: at, updatedAt: at};
      const record: OperationRecord = {workspaceId, view};
      await this.makeRoom(1, Buffer.byteLength(JSON.stringify(record)));
      await this.store.writeOperation(record); return structuredClone(view);
    });
  }
  get(id: string): Promise<OperationView> {
    return this.store.transaction(async () => {
      const record = this.store.record(id);
      if (record.view.state === 'reserved' && this.now() - Date.parse(record.view.createdAt) >= LIMITS.reservationMs) {
        await this.store.deleteOperation(id); throw new StateError('unknown_operation', 'Operation reservation expired', 410);
      }
      return record.view;
    });
  }
  list(workspaceId: string): Promise<OperationView[]> {
    return this.store.transaction(async () => { this.store.getWorkspaceForOperation(workspaceId); await this.prune(); return this.store.operationMetadata().filter(record => record.workspaceId === workspaceId && !terminal(record)).map(record => this.store.record(record.view.id).view); });
  }
  async reconcile(id: string): Promise<OperationView> {
    const previous = await this.get(id);
    if (!['dispatched', 'uncertain'].includes(previous.state) || !this.hooks) return previous;
    const record = this.store.record(id), outcome = await this.hooks.reconcile(record);
    if (!outcome) return previous;
    this.validateOutcome(outcome, record);
    const saved = await this.store.transaction(async () => {
      const current = this.store.record(id);
      if (!['dispatched', 'uncertain'].includes(current.view.state)) return current.view;
      const submitted = current.input, clear = this.resolveInput(current, outcome);
      current.view.state = outcome.state; current.view.updatedAt = this.stamp();
      if (outcome.receipt) current.view.receipt = outcome.receipt;
      if (outcome.error) current.view.error = publicError(outcome.error); else delete current.view.error;
      await this.store.writeOperation(current);
      if (clear && submitted) await this.store.clearSubmittedDraft(current.workspaceId, submitted).catch(() => {});
      return current.view;
    });
    await this.hooks.acknowledged?.(this.store.record(id)).catch(() => {});
    return saved;
  }
  remove(id: string): Promise<void> {
    return this.store.transaction(async () => {
      const record = this.store.record(id);
      if (this.store.canDiscardUnknownQueueClear(id) && record.queueClear) { record.queueClear.rowBudget = 0; record.inputResolved = true; await this.store.writeOperation(record); }
      if (!terminal(record) && !(record.view.state === 'uncertain' && record.inputResolved)) throw new StateError('operation_conflict', 'Resolve this operation before removal', 409);
      await this.store.deleteOperation(id);
    });
  }
  async execute(id: string, request: ExecuteRequest, dispatch: () => Promise<DispatchResult>): Promise<OperationView> {
    const digest = requestDigest(request);
    request = structuredClone(request);
    const action = request.kind === 'primary.control' && request.body && typeof request.body === 'object' && 'action' in request.body && typeof request.body.action === 'string' ? request.body.action : undefined;
    const prepared = await this.store.transaction(async () => {
      const record = this.store.record(id);
      if (record.workspaceId !== request.workspaceId || record.view.kind !== request.kind || !sameTarget(record.view.target, request.target) || (record.digest && record.digest !== digest)) throw new StateError('operation_conflict', 'Operation key was issued for a different request', 409);
      if (record.view.state === 'reserved' && this.now() - Date.parse(record.view.createdAt) >= LIMITS.reservationMs) {
        await this.store.deleteOperation(id); throw new StateError('unknown_operation', 'Operation reservation expired', 410);
      }
      const retry = request.retryUncertainNative === true && record.view.state === 'uncertain' && record.view.kind === 'agent.input';
      if (record.view.state !== 'reserved' && !retry) return {send: false, record};
      if (request.kind.endsWith('.input')) this.prepareInput(record, request, retry);
      if (action !== undefined) record.view.action = action;
      record.digest = digest; record.view.state = 'dispatched'; record.view.updatedAt = this.stamp(); delete record.view.error;
      await this.store.writeOperation(record); return {send: true, record};
    });
    if (!prepared.send) return prepared.record.view;
    let outcome: DispatchResult;
    try {
      outcome = await withPrimaryOperation(id, digest, dispatch); this.validateOutcome(outcome, prepared.record);
      await this.hooks?.complete(prepared.record, outcome);
    } catch {
      return this.uncertain(prepared.record, 'Dispatch ended without a valid receipt');
    }
    try {
      const saved = await this.store.transaction(async () => {
        const record = this.store.record(id);
        record.view.state = outcome.state; record.view.updatedAt = this.stamp();
        if (outcome.receipt) record.view.receipt = outcome.receipt;
        if (outcome.error) record.view.error = publicError(outcome.error);
        else delete record.view.error;
        const submitted = record.input;
        if (request.retryUncertainNative === true && outcome.state === 'rejected') {
          record.view.state = 'uncertain'; record.inputResolved = false;
          record.view.error = {code: 'delivery_uncertain', message: `Retry was refused. Original admission remains unconfirmed. ${record.view.error?.message ?? ''}`, retry: 'manual'};
          if (record.input) record.input.reason = record.view.error.message;
          await this.store.writeOperation(record); return record.view;
        }
        const clearDraft = this.resolveInput(record, outcome);
        await this.store.writeOperation(record);
        if (clearDraft && submitted) {
          // Receipt publication precedes optional draft cleanup. A cleanup failure never loses the receipt.
          try { await this.store.clearSubmittedDraft(record.workspaceId, submitted); } catch { /* The acknowledged draft remains recoverable. */ }
        }
        return record.view;
      });
      await this.hooks?.acknowledged?.(this.store.record(id)).catch(() => {});
      return saved;
    } catch { return this.uncertain(prepared.record, 'Receipt persistence failed after possible delivery'); }
  }
  private retainRefusedInput(record: OperationRecord, outcome: DispatchResult): boolean {
    const input = record.input;
    if (outcome.state !== 'rejected' || !input) return false;
    const draft = this.store.draftForOperation(record.workspaceId, input.targetKey).draft;
    if (sameDraftTuple(draft, {...input, images: input.images ?? []})) return false;
    record.inputResolved = true; record.retainedInput = 'refused';
    input.reason = 'Input was refused; the submitted message remains for review';
    return true;
  }
  private resolveInput(record: OperationRecord, outcome: DispatchResult): boolean {
    if (this.retainRefusedInput(record, outcome)) return false;
    const submitted = record.input;
    const disposition = outcome.receipt?.kind === 'rpc' ? outcome.receipt.disposition : undefined;
    const retained = outcome.state === 'accepted' && submitted?.images?.length && ['queued', 'handled'].includes(disposition ?? '');
    record.inputResolved = true;
    if (retained) {
      record.retainedInput = disposition === 'queued' ? 'queued-image' : 'handled-image';
      if (record.input) record.input.reason = disposition === 'queued' ? 'Input was queued; this retained copy does not prove non-admission' : 'Input was handled; the complete submitted message remains for review';
    } else { delete record.input; delete record.retainedInput; }
    return outcome.state === 'accepted' && !!submitted && !(submitted.images?.length && disposition === 'handled');
  }
  private validateImageMessage(input: NonNullable<ExecuteRequest['input']>, target: Target, images: DraftImage[]): void {
    if (target.kind === 'primary' && images.length && /^\s*\//u.test(input.text)) throw new StateError('unsupported', 'Send the command and image message as separate actions', 409);
    if (input.differentMessage !== undefined && input.differentMessage !== true) throw new StateError('invalid_request', 'Explicit different-message confirmation is required');
  }
  private validateInput(input: NonNullable<ExecuteRequest['input']>, target: Target): void {
    if (typeof input.text !== 'string' || !input.text.trim() && !input.images?.length || Buffer.byteLength(input.text) > LIMITS.textBytes || !['prompt', 'steer', 'followUp'].includes(input.mode) || !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0 || (target.kind === 'agent' && input.mode === 'prompt')) throw new StateError('invalid_request', 'Invalid input text, mode, or revision');
  }
  private prepareInput(record: OperationRecord, request: ExecuteRequest, retry: boolean): void {
        if (!request.input || !request.target) throw new StateError('invalid_request', 'Input dispatch requires a saved target and draft revision');
        const input = request.input;
        this.validateInput(input, request.target);
        const target = this.store.draftForOperation(request.workspaceId, input.targetKey);
        if (!sameTarget(target.target, request.target)) throw new StateError('operation_conflict', 'Draft belongs to a different target', 409);
        const images = normalizeDraftImages(input.images);
        if (!retry && (target.draft.revision !== input.draftRevision || !sameDraftTuple(target.draft, {...input, images}))) throw new StateError('stale_revision', 'Save this complete input draft before submission', 409, target.draft);
        this.validateImageMessage(input, request.target, images);
        const origin = retry ? record.input?.recoveryOrigin : target.draft.recoveryOrigin;
        if (origin) this.store.assertRecoverySendAllowed(origin, input.differentMessage);
        this.store.validateDraftImageReferences(input.targetKey, images);
        if (!retry && this.store.unresolvedInputCount() >= LIMITS.unconfirmed) throw new StateError('capacity', 'Resolve unconfirmed input before another submission', 429);
        record.input = record.input ?? {operationId: record.view.id, target: structuredClone(request.target), targetKey: input.targetKey, text: input.text, mode: input.mode, images, submittedDraftRevision: input.draftRevision, createdAt: this.stamp(), reason: 'Dispatch has no receipt yet', ...(origin ? {recoveryOrigin: origin} : {}), ...(input.differentMessage === true ? {differentMessage: true as const} : {})};
  }
  private validateOutcome(outcome: DispatchResult, record: OperationRecord): void {
    if (!outcome || !['accepted', 'completed', 'rejected'].includes(outcome.state)) throw new Error('Invalid outcome');
    if (record.input && !['rejected', 'accepted'].includes(outcome.state)) throw new Error('Input needs admission receipt');
    if (record.input && outcome.state === 'accepted' && !outcome.receipt) throw new Error('Missing admission receipt');
    const receipt = outcome.receipt;
    if (receipt?.kind === 'durable') this.validateNativeReceipt(receipt, record);
    else if (receipt?.kind === 'rpc') this.validateRpcReceipt(receipt, record);
    else if (receipt) throw new Error('Wrong receipt kind');
  }
  private validateRpcReceipt(receipt: Extract<NonNullable<OperationView['receipt']>, {kind: 'rpc'}>, record: OperationRecord): void {
    if (record.view.target?.kind === 'agent') throw new Error('Wrong receipt kind');
    if (record.view.kind === 'primary.input' && !['started', 'queued', 'handled'].includes(receipt.disposition ?? '')) throw new Error('Missing or wrong input disposition');
    if (receipt.disposition && !['started', 'queued', 'handled'].includes(receipt.disposition)) throw new Error('Wrong disposition');
    if (receipt.result) receipt.result = projectJson(receipt.result.value);
  }
  private validateNativeReceipt(receipt: Extract<NonNullable<OperationView['receipt']>, {kind: 'durable'}>, record: OperationRecord): void {
    if (record.view.target?.kind !== 'agent' || receipt.identity !== record.view.target.identity || receipt.requestId !== nativeRequestId(record.view.id) || !Number.isSafeInteger(receipt.submissionId) || receipt.submissionId < 1 || typeof receipt.deduped !== 'boolean') throw new Error('Wrong native receipt');
  }
  private async uncertain(original: OperationRecord, reason: string): Promise<OperationView> {
    const record = structuredClone(original); record.view.state = 'uncertain'; record.view.updatedAt = this.stamp();
    record.view.error = {code: 'delivery_uncertain', message: reason, retry: record.view.kind === 'agent.input' ? 'same-operation' : 'manual', operationId: record.view.id, ...(record.view.target ? {target: record.view.target} : {})};
    if (record.input) record.input.reason = reason;
    try {
      return await this.store.transaction(async () => {
        const current = this.store.record(record.view.id);
        if (['accepted', 'completed', 'rejected'].includes(current.view.state) && current.inputResolved) return current.view;
        await this.store.writeOperation(record); return record.view;
      });
    } catch { return record.view; }
  }
  beginQueueClear(workspaceId: string, target: Extract<Target, {kind: 'primary'}>, pendingCount: number): Promise<string> {
    validateTarget(target);
    if (target.kind !== 'primary' || !Number.isSafeInteger(pendingCount) || pendingCount < 0 || pendingCount > LIMITS.unconfirmed) throw new StateError('invalid_request', 'Invalid queue clear target or count');
    return this.store.target(workspaceId, target).then(() => this.store.transaction(async () => {
      const imageCopies = await this.store.verifyImageCopiesBeforeQueueClear(target);
      if (this.store.retainedInputCount() + pendingCount > LIMITS.unconfirmed) throw new StateError('capacity', 'Resolve recovery copies before queue clearance', 429);
      const at = this.stamp(), id = randomUUID();
      const record: OperationRecord = {workspaceId, view: {id, kind: 'primary.control', action: 'clearQueue', target: structuredClone(target), state: 'dispatched', createdAt: at, updatedAt: at}, queueClear: {recoveryWorkspaceId: workspaceId, phase: 'prepared', rowBudget: pendingCount, imageCopies}};
      await this.makeRoom(1 + pendingCount, Buffer.byteLength(JSON.stringify(record)) + pendingCount * 128 * 1024);
      await this.store.writeOperation(record); return id;
    }));
  }
  async importOwnerQueue(id: string, workspaceId: string, target: Extract<Target, {kind: 'primary'}>, pendingCount: number, queue: {steering: string[]; followUp: string[]}) {
    if (!Number.isSafeInteger(pendingCount) || pendingCount < 0 || pendingCount > LIMITS.unconfirmed) throw new StateError('capacity', 'Owner queue reservation exceeds its bound', 429);
    if (!this.store.operationMetadata().some(record => record.view.id === id)) {
      await this.store.target(workspaceId, target);
      await this.store.transaction(async () => {
        const at = this.stamp();
        const record: OperationRecord = {workspaceId, view: {id, kind: 'primary.control', action: 'clearQueue', target, state: 'dispatched', createdAt: at, updatedAt: at}, queueClear: {recoveryWorkspaceId: workspaceId, phase: 'prepared', rowBudget: pendingCount, imageCopies: []}};
        await this.makeRoom(1 + pendingCount, Buffer.byteLength(JSON.stringify(record)) + pendingCount * 128 * 1024);
        await this.store.writeOperation(record);
      });
    }
    await this.retainQueue(id, queue);
  }
  async retainQueue(clearOperationId: string, queue: {steering: string[]; followUp: string[]}): Promise<void> {
    if (!Array.isArray(queue.steering) || !Array.isArray(queue.followUp) || queue.steering.length + queue.followUp.length > LIMITS.unconfirmed || Buffer.byteLength(JSON.stringify(queue)) > 1024 * 1024) throw new StateError('capacity', 'Recovered queue exceeds its retention bound', 429);
    await this.store.transaction(async () => {
      const anchor = this.store.record(clearOperationId), clear = anchor.queueClear, target = anchor.view.target;
      if (!clear || target?.kind !== 'primary' || clear.phase === 'refused') throw new StateError('queue_recovery_provenance', 'No usable clear event exists', 409);
      const counts = {steering: queue.steering.length, followUp: queue.followUp.length};
      if (clear.returned && (clear.returned.steering !== counts.steering || clear.returned.followUp !== counts.followUp)) throw new StateError('queue_recovery_provenance', 'Clear-event return counts changed', 409);
      if (!clear.returned && counts.steering + counts.followUp > clear.rowBudget) throw new StateError('capacity', 'Returned queue exceeds its pre-clear reservation', 429);
      const records = this.recoveredRows(anchor, target, queue);
      if (clear.phase === 'retained') { await this.publishRecoveredRows(records, target, true); return; }
      clear.returned = counts; clear.phase = 'retaining'; anchor.view.state = 'dispatched'; anchor.view.updatedAt = this.stamp(); await this.store.writeOperation(anchor);
      await this.publishRecoveredRows(records, target, false);
      clear.phase = 'retained'; clear.rowBudget = 0; anchor.view.state = 'completed'; anchor.view.updatedAt = this.stamp(); delete anchor.view.error;
      anchor.view.receipt = {kind: 'rpc', result: projectJson({action: 'clear_queue', ...counts})};
      await this.store.writeOperation(anchor);
    });
  }
  private recoveredRows(anchor: OperationRecord, target: Extract<Target, {kind: 'primary'}>, queue: {steering: string[]; followUp: string[]}): OperationRecord[] {
      const clearOperationId = anchor.view.id;
      const saved = this.store.snapshot(anchor.workspaceId, [target]).targets[0];
      if (!saved) throw new StateError('queue_recovery_provenance', 'Clear-event target is unavailable', 409);
      const texts = [...queue.steering.map((text, index) => ({text, mode: 'steer' as const, index})), ...queue.followUp.map((text, index) => ({text, mode: 'followUp' as const, index}))];
      const records = texts.map(({text, mode, index}): OperationRecord => {
        if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.textBytes) throw new StateError('payload_too_large', 'Recovered queue text exceeds its limit', 413);
        const hash = createHash('sha256').update(`ui:queue:${clearOperationId}:${mode}:${index}`).digest('hex').slice(0, 32);
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
        const reason = 'Queue cleared; this text copy does not prove non-admission', at = this.stamp();
        return {workspaceId: anchor.workspaceId, view: {id, kind: 'primary.input', target: structuredClone(target), state: 'uncertain', createdAt: at, updatedAt: at, error: {code: 'delivery_uncertain', message: reason, retry: 'manual'}}, queueRecovery: {clearOperationId, mode, index}, input: {operationId: id, target: structuredClone(target), targetKey: saved.targetKey, text, mode, images: [], submittedDraftRevision: saved.draft.revision, createdAt: at, reason}};
      });
      for (const record of records) if (Buffer.byteLength(JSON.stringify(record)) > 128 * 1024) throw new StateError('payload_too_large', 'Recovered queue copy exceeds its file limit', 413);
    return records;
  }
  private assertRecoveredRow(previous: OperationRecord, record: OperationRecord, target: Target): void {
    if (previous.workspaceId !== record.workspaceId || !sameTarget(previous.view.target, target) || canonical(previous.queueRecovery) !== canonical(record.queueRecovery) || previous.input && (previous.input.text !== record.input?.text || previous.input.mode !== record.input?.mode)) throw new StateError('queue_recovery_provenance', 'Recovered row conflicts with its source position', 409);
    if (!previous.input && !previous.inputResolved) throw new StateError('queue_recovery_provenance', 'Recovered row has no release evidence', 409);
  }
  private async publishRecoveredRows(records: OperationRecord[], target: Target, previouslyRetained: boolean): Promise<void> {
    const existing = new Set(this.store.operationMetadata().map(record => record.view.id));
    for (const record of records) {
      if (existing.has(record.view.id)) { this.assertRecoveredRow(this.store.record(record.view.id), record, target); continue; }
      if (previouslyRetained) throw new StateError('queue_recovery_provenance', 'A retained row disappeared', 409);
      await this.store.writeOperation(record);
    }
  }
  settleQueueClearFailure(id: string, uncertain: boolean): Promise<void> {
    return this.store.transaction(async () => {
      const record = this.store.record(id); if (!record.queueClear || record.queueClear.phase === 'retained') return;
      record.queueClear.phase = uncertain ? 'uncertain' : 'refused'; if (!uncertain) record.queueClear.rowBudget = 0;
      record.view.state = uncertain ? 'uncertain' : 'rejected'; record.view.updatedAt = this.stamp();
      record.view.error = {code: uncertain ? 'delivery_uncertain' : 'not_ready', message: uncertain ? 'Queue clearance or text retention is uncertain' : 'Queue clearance was refused before effects', retry: 'manual'};
      await this.store.writeOperation(record);
    });
  }
  private async makeRoom(count: number, bytes: number): Promise<void> {
    let records = this.store.operationMetadata();
    while (this.store.operationStoreCount() + count > LIMITS.operations || this.store.operationStoreBytes() + bytes > 32 * 1024 * 1024) {
      const candidate = records.filter(terminal).sort((a, b) => a.view.updatedAt.localeCompare(b.view.updatedAt))[0];
      if (!candidate) throw new StateError('capacity', 'Resolve unconfirmed operations before recovery', 429);
      await this.store.deleteOperation(candidate.view.id); records = this.store.operationMetadata();
    }
  }
  markUncertain(target?: Target): Promise<void> {
    return this.store.transaction(async () => {
      for (const metadata of this.store.operationMetadata()) {
        if (metadata.view.state !== 'dispatched' || (target && !sameTarget(metadata.view.target, target))) continue;
        const record = this.store.record(metadata.view.id);
        record.view.state = 'uncertain'; record.view.updatedAt = this.stamp();
        record.view.error = {code: 'delivery_uncertain', message: 'Target exited before a receipt arrived', retry: 'manual'};
        if (record.input) record.input.reason = record.view.error.message;
        await this.store.writeOperation(record);
      }
    });
  }
}
