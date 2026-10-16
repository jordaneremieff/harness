import {randomUUID, createHash} from 'node:crypto';
import {OWNER_PROTOCOL, OWNER_LIMITS, type OwnerAction, type OwnerBaseline, type OwnerCapture, type OwnerCapturePage, type OwnerDescriptor, type OwnerHello, type OwnerMutation, type OwnerNotice, type OwnerOutcome, type OwnerPrimary, type OwnerQueueReservation, type OwnerRecord, type OwnerReply} from '../shared/owner.ts';
import {OwnerWire, type WireEndpoint} from './owner-wire.mts';
import {RpcError, type PreparedLine, type RpcClientOptions} from '../rpc/client.mts';
import type {PrimaryTransport, TransportFactory} from '../rpc/transport.mts';
import {primaryMutation} from '../rpc/primary-operation.mts';
import {projectJson} from './projection.mts';
import type {DispatchResult} from './operations.mts';

export class OwnerConnection {
  readonly hello: OwnerHello;
  private wire: OwnerWire; private pending = new Map<string, {resolve: (v: unknown) => void; reject: (e: Error) => void}>();
  private listeners = new Map<string, (notice: OwnerNotice) => void>();
  private constructor(endpoint: WireEndpoint, hello: OwnerHello) {this.hello = hello; this.wire = new OwnerWire(endpoint, value => this.receive(value));}
  static fromProcess(hello: OwnerHello) {return new OwnerConnection(process as unknown as WireEndpoint, hello);}
  static connect(endpoint: WireEndpoint, hello: OwnerHello) {return new OwnerConnection(endpoint, hello);}
  private receive(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const v = value as {kind: string; id?: string; reply?: OwnerReply; notice?: OwnerNotice};
    if (v.kind === 'notice' && v.notice) {this.listeners.get(v.notice.primaryKey)?.(v.notice); return;}
    if (v.kind !== 'reply' || !v.id || !v.reply) return;
    const pending = this.pending.get(v.id); if (!pending) return; this.pending.delete(v.id);
    if (v.reply.ok) pending.resolve(v.reply.value); else pending.reject(new RpcError(v.reply.error.code, v.reply.error.message, v.reply.error.uncertain));
  }
  request<T>(action: OwnerAction): Promise<T> {
    if (this.pending.size >= 128) return Promise.reject(new RpcError('capacity', 'Owner request capacity is full.'));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {resolve: value => resolve(value as T), reject});
      if (!this.wire.send({kind: 'request', request: {...action, protocol: OWNER_PROTOCOL, ownerIncarnation: this.hello.ownerIncarnation, requestId}})) {this.pending.delete(requestId); reject(new RpcError('host_unavailable', 'The owner channel requires resynchronization.'));}
    });
  }
  observe(key: string, notify: (notice: OwnerNotice) => void) {this.listeners.set(key, notify); return () => this.listeners.delete(key);}
  factory(primary: OwnerPrimary, attach?: OwnerDescriptor): TransportFactory {return callbacks => new OwnerTransport(this, primary, callbacks, attach);}
  async complete(primaryKey: string, epoch: number, operationId: string, digest: string, result: DispatchResult) {
    await this.request({kind: 'operation-complete', primaryKey, epoch, mutation: {operationId, digest, step: 'result'}, result: JSON.parse(JSON.stringify(result))});
  }
  async acknowledge(primaryKey: string, epoch: number, operationId: string) {await this.request({kind:'ack',primaryKey,epoch,id:operationId});}
  async reconcile(primaryKey: string, epoch: number, operationId: string, digest: string): Promise<DispatchResult | undefined> {
    const retained = await this.request<DispatchResult | null>({kind: 'operation-result', primaryKey, epoch, operationId, digest});
    if (retained) return retained;
    // A prompt has one effectful step and its raw disposition is its exact admission receipt.
    const outcome = await this.request<OwnerOutcome | null>({kind: 'outcome', primaryKey, epoch, mutation: {operationId, digest, step: '1:prompt'}});
    const response = outcome?.response;
    if (outcome?.state === 'complete' && response?.success === true && response.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
      const disposition = response.data.disposition;
      if (disposition === 'started' || disposition === 'queued' || disposition === 'handled') return {state: 'accepted', receipt: {kind: 'rpc', disposition, result: projectJson(response.data)}};
    }
  }
  close() {this.wire.close(); for (const pending of this.pending.values()) pending.reject(new RpcError('host_unavailable', 'Backend owner delivery detached.', true)); this.pending.clear(); this.listeners.clear();}
}
class OwnerTransport implements PrimaryTransport {
  synchronized = true; private descriptor?: OwnerDescriptor; private pending = 0; private stopped = false;
  private connection: OwnerConnection; private primary: OwnerPrimary; private callbacks: Pick<RpcClientOptions, 'onEvent'|'onExit'|'onProtocolError'|'measure'>; private unobserve: () => void;
  private reservation?: OwnerQueueReservation;
  constructor(connection: OwnerConnection, primary: OwnerPrimary, callbacks: OwnerTransport['callbacks'], descriptor?: OwnerDescriptor) {
    this.connection = connection; this.primary = primary; this.callbacks = callbacks; this.descriptor = descriptor;
    this.unobserve = connection.observe(primary.key, notice => {
      if (this.stopped) return;
      if (notice.kind === 'record' && notice.epoch === this.primary.epoch) this.callbacks.onEvent?.({...notice.event.record, __ownerSequence: notice.event.seq, __ownerStartSequence: notice.event.messageStartSequence, __ownerAt: notice.event.at, __ownerIdentity: `${connection.hello.ownerIncarnation}:${primary.key}:${notice.epoch}`} as never);
      else if (notice.kind === 'exit') {this.descriptor = notice.descriptor; this.callbacks.onExit?.(notice.descriptor.exited && notice.descriptor.synchronized ? undefined : new RpcError('delivery_uncertain', 'The owned Pi process exited.', true));}
      else if (notice.kind === 'resync') this.protocolLost(notice.reason);
    });
  }
  private protocolLost(reason:string){this.synchronized=false;this.callbacks.onProtocolError?.(new RpcError(reason==='delivery-backpressure'?'owner_delivery_lost':'protocol_error',reason,true));}
  get child() {return this.descriptor ? {pid: this.descriptor.pid} : undefined;}
  get exited() {return this.descriptor?.exited ?? false;}
  get available() {return !this.stopped && (this.descriptor?.available ?? false);}
  get stderrTail() {return this.descriptor?.stderr ?? '';}
  get pendingCount() {return this.pending;}
  private address() {return {primaryKey: this.primary.key, epoch: this.primary.epoch};}
  async start(sessionFile?: string) {if (this.descriptor) return; this.primary.sessionFile = sessionFile; this.descriptor = await this.connection.request<OwnerDescriptor>({kind: 'open', primary: this.primary});}
  private mutation(command: string, fields: unknown): OwnerMutation {
    return primaryMutation(command) ?? {operationId: `backend:${randomUUID()}`, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex'), step: command};
  }
  private result(outcome: OwnerOutcome): unknown {
    if (outcome.state !== 'complete' || !outcome.response) throw new RpcError('delivery_uncertain', outcome.error ?? 'The owner retains an unresolved command.', outcome.written);
    const response = outcome.response;
    if (response.success !== true) throw new RpcError('rpc_rejected', String(response.error ?? 'Pi refused the command.'));
    return response.data;
  }
  async request(type: string, fields: Record<string, unknown> = {}, beforeEntryId?: string) {
    this.pending++;
    try {
      const outcome = await this.connection.request<OwnerOutcome>({kind: 'command', ...this.address(), record: {type, ...fields} as OwnerRecord, ...(!type.startsWith('get_') ? {mutation: this.mutation(type, fields)} : {}), ...(type === 'clear_queue' && this.reservation ? {recovery: this.reservation} : {})});
      let result: unknown;
      try {result = this.result(outcome);}
      finally {if(type.startsWith('get_')&&['complete','refused'].includes(outcome.state))await this.connection.request({kind:'ack',...this.address(),id:outcome.id});}
      if (type === 'get_entries' && beforeEntryId !== undefined) {
        // The backend retains the existing bounded branch projection and history-page semantics.
        const {EventProjection} = await import('../rpc/events.mts');
        const projection = new EventProjection({key: this.primary.key, epoch: this.primary.epoch} as never, () => {}, () => {}); projection.snapshot(result, beforeEntryId); return projection.exportSnapshot();
      }
      return result;
    } finally {this.pending--;}
  }
  async requestPrepared(_type: 'prompt', prepare: (id: string) => Promise<PreparedLine>, beforeWrite: () => void) {
    beforeWrite(); const mutation = this.mutation('prompt', 'prepared');
    const reserved = await this.connection.request<OwnerOutcome>({kind: 'prepare', ...this.address(), mutation, bytes: OWNER_LIMITS.inputBytes});
    const line = await prepare(reserved.id); beforeWrite();
    if (line.bytes !== Buffer.byteLength(line.line) || line.bytes > OWNER_LIMITS.inputBytes) throw new RpcError('payload_too_large', 'Prepared input exceeds its bound.');
    return this.result(await this.connection.request<OwnerOutcome>({kind: 'prepared', ...this.address(), id: reserved.id, line: line.line}));
  }
  async sendUI(record: Record<string, unknown>) {await this.connection.request({kind: 'ui-response', ...this.address(), record: {type: 'extension_ui_response', ...record} as OwnerRecord});}
  async markSynchronized(token?:string) {
    if(this.connection.hello.capabilities?.includes('capture-resynchronize/1')) {
      if(!token)throw new RpcError('not_ready','Owner resynchronization requires its capture token.');
      this.descriptor=await this.connection.request<OwnerDescriptor>({kind:'resynchronize',...this.address(),token});
      this.synchronized=this.descriptor.synchronized;
    }else if(!this.synchronized)throw new RpcError('unsupported','This running owner cannot clear a protocol loss.');
  }
  async close() {if (!this.descriptor || this.descriptor.exited) return; this.descriptor = await this.connection.request({kind: 'close-primary', ...this.address()}); this.callbacks.onExit?.(); this.unobserve();}
  async detach() {this.stopped = true; this.unobserve();}
  captureBegin() {return this.connection.request<{token: string; from: number}>({kind: 'capture-begin', ...this.address()});}
  async captureFinish(token: string) {
    const capture = await this.connection.request<OwnerCapture>({kind: 'capture-finish', ...this.address(), token});
    const pages: Buffer[] = []; let bytes = 0;
    for (let index = 0; index < capture.pages; index++) {const page = await this.connection.request<OwnerCapturePage>({kind: 'capture-page', ...this.address(), token, index}); const data = Buffer.from(page.data, 'base64'); bytes += data.length; if (bytes > OWNER_LIMITS.captureBytes) throw new RpcError('capacity', 'Owner baseline exceeds its bound.'); pages.push(data);}
    if (bytes !== capture.bytes) throw new RpcError('protocol_error', 'Owner baseline byte count differs.');
    return JSON.parse(Buffer.concat(pages).toString('utf8')) as OwnerBaseline;
  }
  async captureAck(token: string) {await this.connection.request({kind: 'capture-ack', ...this.address(), token});}
  setQueueReservation(reservation: OwnerQueueReservation) {this.reservation = reservation;}
  async queueAcknowledged(id: string) {await this.connection.request({kind: 'recovery-ack', id}); this.reservation = undefined;}
  async setEpoch(next: number, sessionFile?: string) {this.descriptor = await this.connection.request({kind: 'epoch', ...this.address(), next, sessionFile}); this.primary.epoch = next;}
}
