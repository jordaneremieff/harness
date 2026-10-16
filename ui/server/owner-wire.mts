import {randomUUID} from 'node:crypto';
export type WireEndpoint = {send(message: unknown, callback: (error: Error | null) => void): boolean; on(event: 'message', listener: (message: unknown) => void): unknown; off(event: 'message', listener: (message: unknown) => void): unknown};
const PAGE = 192 * 1024, TOTAL = 64 * 1024 * 1024, QUEUE = 8 * 1024 * 1024;
/** One bounded framing lane carries owner traffic independently of backend lifecycle control. */
export class OwnerWire {
  private endpoint: WireEndpoint; private receive: (value: unknown) => void;
  private pieces = new Map<string, {next: number; count: number; parts: string[]; bytes: number}>();
  private retained = 0; private queued = 0; private stopped = false; private congested=false; private drainScheduled=false; private onDrain?:()=>void;
  constructor(endpoint: WireEndpoint, receive: (value: unknown) => void,onDrain?:()=>void) {this.endpoint = endpoint; this.receive = receive;this.onDrain=onDrain; endpoint.on('message', this.message);}
  private drained() {
    if(this.stopped||!this.congested||this.queued>QUEUE||this.drainScheduled)return;
    this.drainScheduled=true;queueMicrotask(()=>{this.drainScheduled=false;if(this.stopped||!this.congested||this.queued>QUEUE)return;this.congested=false;this.onDrain?.();});
  }
  private message = (value: unknown) => {
    if (this.stopped || !value || typeof value !== 'object') return;
    const v = value as {kind?: string; id?: string; index?: number; count?: number; data?: string};
    if (v.kind !== 'owner-frame') return;
    if (typeof v.id !== 'string' || v.id.length > 64 || typeof v.data !== 'string' || v.data.length > PAGE || !Number.isInteger(v.index) || !Number.isInteger(v.count) || !v.count || v.count > Math.ceil(TOTAL / (PAGE / 4)) || Number(v.index) < 0 || Number(v.index) >= v.count) {this.clear(); return;}
    let item = this.pieces.get(v.id);
    if (!item && v.index === 0 && this.pieces.size < 64) {item = {next: 0, count: v.count, parts: [], bytes: 0}; this.pieces.set(v.id, item);}
    if (!item || item.next !== v.index || item.count !== v.count) {this.clear(); return;}
    const bytes = Buffer.byteLength(v.data); item.next++; item.bytes += bytes; this.retained += bytes;
    if (this.retained > TOTAL) {this.clear(); return;}
    item.parts.push(v.data);
    if (item.next === item.count) {
      this.pieces.delete(v.id); this.retained -= item.bytes;
      try {this.receive(JSON.parse(item.parts.join('')));} catch { /* Invalid owner frames never escape the IPC boundary. */ }
    }
  };
  send(value: unknown): boolean {
    if (this.stopped) return false;
    const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
    if (bytes > TOTAL || this.queued > QUEUE) {this.congested=true;this.drained();return false;}
    // UTF-16 slices preserve all bytes after concatenation and remain below the IPC page ceiling.
    const width = PAGE / 4, count = Math.max(1, Math.ceil(json.length / width)), id = randomUUID();
    this.queued += bytes; let pending = count,released=false;
    const release=()=>{if(released)return;released=true;this.queued-=bytes;this.drained();};
    for (let index = 0; index < count; index++) {
      try {this.endpoint.send({kind: 'owner-frame', id, index, count, data: json.slice(index * width, (index + 1) * width)}, () => {if (!--pending) release();});}
      catch {this.congested=true;release();return false;}
    }
    return true;
  }
  private clear() {this.pieces.clear(); this.retained = 0;}
  close() {this.stopped = true; this.endpoint.off('message', this.message); this.clear();}
}
