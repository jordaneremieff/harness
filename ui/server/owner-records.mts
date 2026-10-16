import {randomUUID} from 'node:crypto';
import {OWNER_LIMITS, type OwnerBaseline, type OwnerCapture, type OwnerCapturePage, type OwnerDescriptor, type OwnerDialog, type OwnerEvent, type OwnerLimits, type OwnerRecord} from '../shared/owner.ts';

type Stored = {seq: number; at: number; bytes: Buffer; messageStartSequence?: number};
type Capture = {attachment: string; from: number; overlap: Stored[]; bytes: number; lost: boolean; sealed?: Buffer; cursor?: number};
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const decode = (value: Stored): OwnerEvent => ({seq:value.seq,at:value.at,record:JSON.parse(value.bytes.toString('utf8')) as OwnerRecord,...(value.messageStartSequence===undefined?{}:{messageStartSequence:value.messageStartSequence})});

/** Retains wire records, never browser projections or a permanent transcript. */
export class OwnerRecords {
  private sequence = 0;
  private ring: Stored[] = [];
  private ringBytes = 0;
  private droppedThrough = 0;
  private tape: {start: number; items: Stored[]; bytes: number; complete: boolean} | null = null;
  private tools = new Map<string,{start:Stored;latest?:Stored}>();
  private states = new Map<string,Stored>();
  private dialogs = new Map<string,{event:Stored;expiresAt?:number}>();
  private captures = new Map<string,Capture>();
  private lost = new Set<string>();
  readonly limits: OwnerLimits;
  private now:()=>number;
  constructor(limits: Partial<OwnerLimits> = {}, now: () => number = Date.now, sequence=0) {this.limits={...OWNER_LIMITS,...limits};this.now=now;this.sequence=sequence;this.droppedThrough=sequence;}
  get cursor() {return this.sequence;}
  advance(record: OwnerRecord): OwnerEvent {
    const stored:Stored={seq:++this.sequence,at:this.now(),bytes:Buffer.from(JSON.stringify(record))};
    if(record.type === 'response') return decode(stored);
    this.ring.push(stored);this.ringBytes+=stored.bytes.length;
    while(this.ring.length>this.limits.ringRecords || this.ringBytes>this.limits.ringBytes) {
      const old=this.ring.shift();if(!old) break;this.ringBytes-=old.bytes.length;this.droppedThrough=old.seq;
    }
    for(const capture of this.captures.values()) if(!capture.sealed) {
      if(capture.bytes+stored.bytes.length>this.limits.ringBytes || capture.overlap.length>=this.limits.ringRecords) {capture.lost=true;continue;}
      capture.overlap.push(stored);capture.bytes+=stored.bytes.length;
    }
    this.retain(stored,record);return decode(stored);
  }
  incomplete(reason: string) {this.lost.add(reason);}
  private retain(stored:Stored,record:OwnerRecord) {
    this.retainMessage(stored,record);this.retainTool(stored,record);this.retainState(stored,record);
    if(record.type==='extension_ui_request' && typeof record.id==='string' && ['select','confirm','input','editor'].includes(String(record.method))) this.dialog(stored,record);
    const bytes=[...this.states.values()].reduce((sum,item)=>sum+item.bytes.length,0)+[...this.tools.values()].reduce((sum,item)=>sum+item.start.bytes.length+(item.latest?.bytes.length??0),0);
    if(bytes>this.limits.slotBytes) {this.states.clear();this.tools.clear();this.lost.add('slot-byte-limit');}
  }
  private retainMessage(stored:Stored,record:OwnerRecord) {
    const raw=object(record.message);
    if(record.type==='message_start' && raw?.role==='assistant') {
      this.tape={start:stored.seq,items:[],bytes:0,complete:true};this.tapeRecord(stored);
    } else if(record.type==='message_update') {
      if(this.tape) this.tapeRecord(stored);else this.lost.add('message-start-unavailable');
    } else if(record.type==='message_end' && raw?.role==='assistant') {
      if(this.tape)stored.messageStartSequence=this.tape.start;
      this.tape=null;this.lost.delete('message-start-unavailable');
    }
  }
  private retainTool(stored:Stored,record:OwnerRecord) {
    if(record.type==='tool_execution_start' && typeof record.toolCallId==='string') {
      if(this.tools.size>=this.limits.toolSlots&&!this.tools.has(record.toolCallId)) this.lost.add('tool-slot-limit');
      else this.tools.set(record.toolCallId,{start:stored});
    }
    if(record.type==='tool_execution_update' && typeof record.toolCallId==='string') {
      const tool=this.tools.get(record.toolCallId);if(tool) tool.latest=stored;else this.lost.add('tool-start-unavailable');
    }
    if(record.type==='tool_execution_end' && typeof record.toolCallId==='string') this.tools.delete(record.toolCallId);
    if(record.type==='agent_settled') {this.tools.clear();this.lost.delete('tool-slot-limit');this.lost.delete('tool-start-unavailable');this.lost.delete('slot-byte-limit');}
  }
  private retainState(stored:Stored,record:OwnerRecord) {
    const state=this.stateKey(record);
    if(state) {
      if(record.type==='extension_ui_request' && ((record.method==='setStatus' && record.statusText===undefined) || (record.method==='setWidget' && record.widgetLines===undefined))) this.states.delete(state);
      else this.states.set(state,stored);
    }
  }
  private tapeRecord(stored:Stored) {
    const tape=this.tape;if(!tape?.complete)return;
    if(tape.bytes+stored.bytes.length>this.limits.tapeBytes||tape.items.length>=this.limits.tapeRecords) {
      tape.complete=false;tape.items=tape.items.slice(0,1);tape.bytes=tape.items[0]?.bytes.length??0;return;
    }
    tape.items.push(stored);tape.bytes+=stored.bytes.length;
  }
  private stateKey(record:OwnerRecord):string|undefined {
    if(['agent_start','agent_settled'].includes(record.type))return 'activity';
    if(['compaction_start','compaction_end'].includes(record.type))return 'compaction';
    if(['auto_retry_start','auto_retry_end'].includes(record.type))return 'retry';
    if(['summarization_retry_scheduled','summarization_retry_attempt_start','summarization_retry_finished'].includes(record.type))return 'summarization';
    if(['queue_update','session_info_changed','thinking_level_changed'].includes(record.type))return record.type;
    if(record.type!=='extension_ui_request')return;
    if(record.method==='setStatus'&&typeof record.statusKey==='string')return `status:${record.statusKey}`;
    if(record.method==='setWidget'&&typeof record.widgetKey==='string')return `widget:${record.widgetKey}`;
    if(['setTitle','set_editor_text'].includes(String(record.method)))return String(record.method);
  }
  private dialog(stored:Stored,record:OwnerRecord) {
    this.expireDialogs();
    const id=String(record.id);const bytes=[...this.dialogs.values()].reduce((sum,item)=>sum+item.event.bytes.length,stored.bytes.length);
    if(this.dialogs.has(id)||this.dialogs.size>=this.limits.dialogs||bytes>this.limits.dialogBytes) {this.lost.add('dialog-limit');return;}
    const timeout=record.timeout;
    if(timeout!==undefined&&(typeof timeout!=='number'||!Number.isFinite(timeout)||timeout<0||timeout>2147483647)) {this.lost.add('invalid-dialog-timeout');return;}
    this.dialogs.set(id,{event:stored,...(typeof timeout==='number'&&timeout>0?{expiresAt:stored.at+timeout}:{})});
  }
  private expireDialogs() {for(const [id,value] of this.dialogs)if(value.expiresAt!==undefined&&value.expiresAt<=this.now())this.dialogs.delete(id);}
  pendingDialogs():OwnerDialog[] {this.expireDialogs();return [...this.dialogs.values()].map(value=>({event:decode(value.event),...(value.expiresAt===undefined?{}:{expiresAt:value.expiresAt})}));}
  hasDialog(id:string) {this.expireDialogs();return this.dialogs.has(id);}
  answered(id:string) {this.dialogs.delete(id);}
  reset() {this.tape=null;this.tools.clear();this.states.clear();this.dialogs.clear();this.lost.clear();this.ring=[];this.ringBytes=0;this.droppedThrough=this.sequence;this.captures.clear();}
  begin(attachment:string):{token:string;from:number} {
    for(const [token,value]of this.captures)if(value.attachment===attachment)this.captures.delete(token);
    if(this.captures.size>=2)throw new Error('capture-capacity');
    const token=randomUUID(),from=this.sequence;this.captures.set(token,{attachment,from,overlap:[],bytes:0,lost:false});return {token,from};
  }
  private capture(attachment:string,token:string):Capture {const value=this.captures.get(token);if(!value||value.attachment!==attachment)throw new Error('capture-unavailable');return value;}
  finish(attachment:string,token:string,descriptor:OwnerDescriptor):OwnerCapture {
    const capture=this.capture(attachment,token);
    if(!capture.sealed) {
      const reasons=[...this.lost];if(capture.lost)reasons.push('capture-overflow');if(this.tape&&!this.tape.complete)reasons.push('active-message-overflow');
      const baseline:OwnerBaseline={descriptor,from:capture.from,cursor:this.sequence,complete:!reasons.length,reasons,
        overlap:capture.overlap.map(decode),activeMessage:this.tape?{startSequence:this.tape.start,complete:this.tape.complete,events:this.tape.items.map(decode)}:null,
        tools:[...this.tools].map(([callId,value])=>({callId,start:decode(value.start),...(value.latest?{latest:decode(value.latest)}:{})})),
        state:[...this.states.values()].sort((a,b)=>a.seq-b.seq).map(decode),dialogs:this.pendingDialogs()};
      let bytes=Buffer.from(JSON.stringify(baseline));
      if(bytes.length>this.limits.captureBytes) {baseline.complete=false;baseline.reasons.push('capture-byte-limit');baseline.overlap=[];baseline.activeMessage=null;baseline.tools=[];baseline.state=[];baseline.dialogs=[];bytes=Buffer.from(JSON.stringify(baseline));}
      if(bytes.length>this.limits.captureBytes)throw new Error('capture-capacity');
      capture.sealed=bytes;capture.cursor=this.sequence;capture.overlap=[];capture.bytes=0;
    }
    const baseline=JSON.parse(capture.sealed.toString('utf8')) as OwnerBaseline;
    return {token,from:capture.from,cursor:capture.cursor??this.sequence,complete:baseline.complete,reasons:baseline.reasons,bytes:capture.sealed.length,pages:Math.ceil(capture.sealed.length/this.limits.capturePageBytes)};
  }
  page(attachment:string,token:string,index:number):OwnerCapturePage {
    const capture=this.capture(attachment,token);const bytes=capture.sealed;
    if(!bytes||!Number.isSafeInteger(index)||index<0||index>=Math.ceil(bytes.length/this.limits.capturePageBytes))throw new Error('capture-page-unavailable');
    return {token,index,encoding:'base64',data:bytes.subarray(index*this.limits.capturePageBytes,(index+1)*this.limits.capturePageBytes).toString('base64')};
  }
  ack(attachment:string,token:string):OwnerEvent[] {
    const capture=this.capture(attachment,token);if(!capture.sealed||capture.cursor===undefined)throw new Error('capture-unavailable');
    const records=this.after(capture.cursor);this.captures.delete(token);return records;
  }
  after(cursor:number):OwnerEvent[] {if(cursor<this.droppedThrough)throw new Error('suffix-expired');return this.ring.filter(item=>item.seq>cursor).map(decode);}
  detach(attachment:string) {for(const [token,value]of this.captures)if(value.attachment===attachment)this.captures.delete(token);}
}
