import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { LIMITS, type EventData, type EventEnvelope, type EventName, type NoticeView, type Target } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import { safeText } from './projection.mts';

export type JournalRecord = {id: string; name: EventName; envelope: EventEnvelope; wire: string; bytes: number};
type Client = {response: ServerResponse; workspace: string; session: string; queue: {wire:string;id:string}[]; bytes: number; blocked: boolean; closed: boolean; onClose?: () => void};
/** Optional monotonic instrumentation is consumer-owned; it never records prompt text. */
export type Measure = (stage: string, id: string, at: number, bytes?: number) => void;
function control(name: 'ready' | 'resync', data: unknown) { return `event: ${name}\ndata: ${JSON.stringify({at: new Date().toISOString(), data})}\n\n`; }
function isNotice(name: EventName, data: EventData[EventName]) {
  if(name === 'notice') return 'level' in data;
  return name === 'extension.request' && 'method' in data && data.method === 'notify';
}

/** One reducer boundary owns ordered replay. Browser queues never backpressure producers. */
export class Journal {
  readonly bootId = randomUUID();
  private sequence = 0;
  private records: JournalRecord[] = [];
  private recent: {notice:NoticeView;bytes:number}[] = [];
  private noticeBytes = 0;
  private bytes = 0;
  private clients = new Set<Client>();
  private bounds: {events:number;bytes:number;queue:number};
  private measure?:Measure;
  constructor(bounds: {events: number; bytes: number; queue: number} = {events: LIMITS.journalEvents, bytes: LIMITS.journalBytes, queue: LIMITS.clientQueueBytes}, measure?: Measure) {this.bounds=bounds;this.measure=measure;}
  get cursor() { return `${this.bootId}:${this.sequence}`; }
  get connectionCount() { return this.clients.size; }
  publish<N extends EventName>(name: N, target: Target | undefined, data: EventData[N], workspaceId?: string) {
    if (name === 'ready' || name === 'resync') throw new ApiError('invalid_request', 'Connection metadata is not journaled.');
    const envelope: EventEnvelope<N> = {at: new Date().toISOString(), ...(workspaceId ? {workspaceId} : {}), ...(target ? {target} : {}), data};
    const json = JSON.stringify(envelope);
    if (Buffer.byteLength(json) > LIMITS.displayBytes) throw new ApiError('payload_too_large', 'The event exceeds the display bound.', 413);
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new ApiError('capacity', 'The replay sequence is exhausted.', 503);
    const id = `${this.bootId}:${++this.sequence}`;
    const wire = `id: ${id}\nevent: ${name}\ndata: ${json}\n\n`;
    const record: JournalRecord = {id, name, envelope, wire, bytes: Buffer.byteLength(wire)};
    this.records.push(record); this.bytes += record.bytes;
    this.retainNotice(name, data, id, target, workspaceId);
    while (this.records.length > this.bounds.events || this.bytes > this.bounds.bytes) {
      const first = this.records.shift(); if (first) this.bytes -= first.bytes;
    }
    this.measure?.('sse.enqueue', id, performance.now(), record.bytes);
    for (const client of this.clients) if (!workspaceId || workspaceId === client.workspace) this.enqueue(client, wire, id);
    return id;
  }
  notices(workspace: string): NoticeView[] { return structuredClone(this.recent.filter(item=>!item.notice.workspaceId || item.notice.workspaceId===workspace).map(item=>item.notice)); }
  private retainNotice(name: EventName, data: EventData[EventName], id: string, target?: Target, workspaceId?: string) {
    if (!isNotice(name,data) || !('message' in data) || typeof data.message !== 'string') return;
    const level = 'level' in data ? data.level : 'notifyType' in data ? data.notifyType : 'info';
    const notice: NoticeView = {id, ...(target ? {target} : {}), ...(workspaceId ? {workspaceId} : {}),
      level: level === 'error' || level === 'warning' ? level : 'info', message:safeText(data.message,2048),
      ...('code' in data && typeof data.code === 'string' ? {code:safeText(data.code,128)} : {})};
    const bytes = Buffer.byteLength(JSON.stringify(notice)); this.recent.push({notice,bytes}); this.noticeBytes += bytes;
    while(this.recent.length>32 || this.noticeBytes>16*1024) {const oldest=this.recent.shift(); if(oldest) this.noticeBytes-=oldest.bytes;}
  }
  replay(after: string | undefined, workspace: string): {reason?: EventData['resync']['reason']; records: JournalRecord[]} {
    if (!after) return {reason: 'initial', records: []};
    const split = after.lastIndexOf(':'); const boot = after.slice(0, split); const number = after.slice(split + 1);
    if (split < 1 || !/^\d+$/.test(number)) return {reason: 'invalid-cursor', records: []};
    if (boot !== this.bootId) return {reason: 'boot-changed', records: []};
    const sequence = Number(number);
    if (!Number.isSafeInteger(sequence) || sequence > this.sequence) return {reason: 'invalid-cursor', records: []};
    const oldest = this.records[0];
    const floor = oldest ? Number(oldest.id.slice(oldest.id.lastIndexOf(':') + 1)) - 1 : this.sequence;
    if (sequence < floor) return {reason: 'expired', records: []};
    return {records: this.records.filter(record => Number(record.id.slice(record.id.lastIndexOf(':') + 1)) > sequence && (!record.envelope.workspaceId || record.envelope.workspaceId === workspace))};
  }
  attach(response: ServerResponse, workspace: string, session: string, after?: string, onClose?: () => void) {
    response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
    response.flushHeaders();
    const replay = this.replay(after, workspace);
    if (replay.reason) {
      response.end(control('resync', {reason: replay.reason, snapshotUrl: `/api/snapshot?workspace=${encodeURIComponent(workspace)}`, cursor: this.cursor}));
      onClose?.(); return;
    }
    const client: Client = {response, workspace, session, queue: [], bytes: 0, blocked: false, closed: false, onClose};
    response.on('close', () => this.detach(client));
    response.on('error', () => this.detach(client));
    response.on('drain', () => { client.blocked = false; this.flush(client); });
    // Replay admission and live registration are synchronous on the same event-loop boundary.
    for (const record of replay.records) this.enqueue(client, record.wire, record.id);
    if (client.closed) return;
    this.enqueue(client, control('ready', {bootId: this.bootId, cursor: this.cursor}));
    if (!client.closed) this.clients.add(client);
  }
  workspaceClients(workspace: string) { return [...this.clients].filter(client => client.workspace === workspace).length; }
  revoke(session: string) { for (const client of this.clients) if (client.session === session) { client.response.end(); this.detach(client); } }
  close() { for (const client of [...this.clients]) { client.response.end(); this.detach(client); } }
  private enqueue(client: Client, wire: string, id = this.cursor) {
    if (client.closed) return;
    const bytes = Buffer.byteLength(wire);
    if (client.bytes + client.response.writableLength + bytes > this.bounds.queue) {
      client.response.end(control('resync', {reason: 'slow-client', snapshotUrl: `/api/snapshot?workspace=${encodeURIComponent(client.workspace)}`, cursor: this.cursor}));
      this.detach(client); return;
    }
    client.queue.push({wire,id}); client.bytes += bytes;
    this.flush(client);
  }
  private flush(client: Client) {
    while (!client.closed && !client.blocked && client.queue.length) {
      const next = client.queue.shift(); if (!next) break;
      const {wire,id}=next;
      client.bytes -= Buffer.byteLength(wire);
      client.blocked = !client.response.write(wire);
      this.measure?.('sse.write', id, performance.now(), Buffer.byteLength(wire));
    }
  }
  private detach(client: Client) {
    if (client.closed) return;
    client.closed = true; client.queue = []; client.bytes = 0;
    this.clients.delete(client); client.onClose?.();
  }
}
