import { createHash, randomUUID } from 'node:crypto';
import { LIMITS } from '../shared/api.ts';
import type { ErrorView, OperationKind, OperationView, Target } from '../shared/api.ts';
import { StateError, sameTarget, validateTarget } from './state.mts';
import type { StateStore } from './state.mts';
import type { OperationRecord } from './state.mts';
import { projectJson, safeText } from './projection.mts';

const KINDS: OperationKind[] = ['primary.open', 'primary.input', 'primary.stop', 'primary.session', 'primary.control', 'primary.dialog', 'primary.handoff', 'agent.input', 'agent.abort', 'agent.configure'];
const terminal = (record: {view: {state: string}; input?: unknown; inputResolved?: boolean}) => ['accepted', 'rejected', 'completed'].includes(record.view.state) && (!record.input || record.inputResolved);
export type ExecuteRequest = {workspaceId: string; kind: OperationKind; target?: Target; body: unknown;
  input?: {targetKey: string; text: string; mode: string; draftRevision: number}; retryUncertainNative?: boolean};
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

export class Operations {
  private readonly now: () => number;
  readonly store: StateStore;
  constructor(store: StateStore, options: {now?: () => number} = {}) { this.store = store; this.now = options.now ?? Date.now; }
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
  reconcile(id: string): Promise<OperationView> { return this.get(id); }
  remove(id: string): Promise<void> {
    return this.store.transaction(async () => { const record = this.store.record(id); if (!terminal(record) && !(record.view.state === 'uncertain' && record.inputResolved)) throw new StateError('operation_conflict', 'Resolve this operation before removal', 409); await this.store.deleteOperation(id); });
  }
  async execute(id: string, request: ExecuteRequest, dispatch: () => Promise<DispatchResult>): Promise<OperationView> {
    const body = canonical(request.body);
    if (Buffer.byteLength(body) > LIMITS.requestBytes) throw new StateError('payload_too_large', 'Operation body exceeds its limit', 413);
    const digest = createHash('sha256').update(canonical({body: request.body, input: request.input ?? null})).digest('hex');
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
      outcome = await dispatch(); this.validateOutcome(outcome, prepared.record);
    } catch {
      return this.uncertain(prepared.record, 'Dispatch ended without a valid receipt');
    }
    try {
      return await this.store.transaction(async () => {
        const record = this.store.record(id);
        record.view.state = outcome.state; record.view.updatedAt = this.stamp();
        if (outcome.receipt) record.view.receipt = outcome.receipt;
        if (outcome.error) record.view.error = publicError(outcome.error);
        else delete record.view.error;
        const submitted = record.input;
        record.inputResolved = true; delete record.input;
        await this.store.writeOperation(record);
        if (outcome.state === 'accepted' && submitted) {
          // Receipt publication precedes optional draft cleanup. A cleanup failure never loses the receipt.
          try { await this.store.clearSubmittedDraft(record.workspaceId, submitted); } catch { /* The acknowledged draft remains recoverable. */ }
        }
        return record.view;
      });
    } catch { return this.uncertain(prepared.record, 'Receipt persistence failed after possible delivery'); }
  }
  private validateInput(input: NonNullable<ExecuteRequest['input']>, target: Target): void {
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > LIMITS.textBytes || !['prompt', 'steer', 'followUp'].includes(input.mode) || !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0 || (target.kind === 'agent' && input.mode === 'prompt')) throw new StateError('invalid_request', 'Invalid input text, mode, or revision');
  }
  private prepareInput(record: OperationRecord, request: ExecuteRequest, retry: boolean): void {
        if (!request.input || !request.target) throw new StateError('invalid_request', 'Input dispatch requires a saved target and draft revision');
        const input = request.input;
        this.validateInput(input, request.target);
        const target = this.store.draftForOperation(request.workspaceId, input.targetKey);
        if (!sameTarget(target.target, request.target)) throw new StateError('operation_conflict', 'Draft belongs to a different target', 409);
        if (!retry && (target.draft.revision !== input.draftRevision || target.draft.text !== input.text || target.draft.mode !== input.mode)) throw new StateError('stale_revision', 'Save this input draft before submission', 409, target.draft);
        if (!retry && this.store.unresolvedInputCount() >= LIMITS.unconfirmed) throw new StateError('capacity', 'Resolve unconfirmed input before another submission', 429);
        record.input = record.input ?? {operationId: record.view.id, target: structuredClone(request.target), targetKey: input.targetKey, text: input.text, mode: input.mode, submittedDraftRevision: input.draftRevision, createdAt: this.stamp(), reason: 'Dispatch has no receipt yet'};
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
        if (terminal(current)) return current.view;
        await this.store.writeOperation(record); return record.view;
      });
    } catch { return record.view; }
  }
  async retainQueue(workspaceId: string, target: Extract<Target, {kind: 'primary'}>, queue: {steering: string[]; followUp: string[]}): Promise<void> {
    validateTarget(target);
    if (!Array.isArray(queue.steering) || !Array.isArray(queue.followUp)) throw new StateError('invalid_request', 'Invalid recovered input queue');
    if (target.kind !== 'primary') throw new StateError('invalid_request', 'Queue recovery requires a primary target');
    if (queue.steering.length + queue.followUp.length > LIMITS.unconfirmed) throw new StateError('capacity', 'Recovered queue exceeds the recovery copy limit', 429);
    const texts = [...queue.steering.map(text => ({text, mode: 'steer'})), ...queue.followUp.map(text => ({text, mode: 'followUp'}))];
    if (texts.length === 0) return;
    if (texts.length > LIMITS.unconfirmed) throw new StateError('capacity', 'Recovered queue exceeds the recovery copy limit', 429);
    const saved = await this.store.target(workspaceId, target);
    await this.store.transaction(async () => {
      if (this.store.unresolvedInputCount() + texts.length > LIMITS.unconfirmed) throw new StateError('capacity', 'Resolve unconfirmed input before queue removal', 429);
      const draft = this.store.draftForOperation(workspaceId, saved.targetKey).draft;
      const reason = 'Queue cleared; this copy does not prove non-admission';
      const records: OperationRecord[] = texts.map(({text, mode}) => {
        if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.textBytes) throw new StateError('payload_too_large', 'Recovered queue text exceeds its limit', 413);
        const at = this.stamp(), id = randomUUID();
        return {workspaceId, view: {id, kind: 'primary.input', target: structuredClone(target), state: 'uncertain', createdAt: at, updatedAt: at, error: {code: 'delivery_uncertain', message: reason, retry: 'manual'}},
          input: {operationId: id, target: structuredClone(target), targetKey: saved.targetKey, text, mode, submittedDraftRevision: draft.revision, createdAt: at, reason}};
      });
      const incomingBytes = records.reduce((bytes, record) => {
        const size = Buffer.byteLength(JSON.stringify(record));
        if (size > 128 * 1024) throw new StateError('payload_too_large', 'Recovered queue copy exceeds its file limit', 413);
        return bytes + size;
      }, 0);
      await this.makeRoom(records.length, incomingBytes);
      for (const record of records) await this.store.writeOperation(record);
    });
  }
  private async makeRoom(count: number, bytes: number): Promise<void> {
    let records = this.store.operationMetadata();
    while (records.length + count > LIMITS.operations || this.store.operationStoreBytes() + bytes > 32 * 1024 * 1024) {
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
