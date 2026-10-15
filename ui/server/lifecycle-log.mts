import {constants} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';

export const LIFECYCLE_BYTES=64*1024;
/** Diagnostic text never carries URLs or authentication material into retained output. */
export function redactLifecycle(text:string):string {
  return text.replace(/https?:\/\/[^\s"'<>]*/gi,'[url omitted]')
    .replace(/(?:authorization|cookie|capability|session|token|api[_-]?key)\s*[:=]\s*[^\s,;}]+/gi,'[credential omitted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').slice(0,512);
}
/** The caller holds the state lock; one writer retains a fixed byte and record window. */
export class LifecycleLog {
  private rows:string[]=[];
  private pending?:Promise<void>;
  private dirty=false;
  private stopped=false;
  private failed=false;
  private file:FileHandle;
  private constructor(file:FileHandle) {this.file=file;}
  static async open(directory:string) {
    const file=await open(join(directory,'lifecycle.log'),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    try {
      const stat=await file.stat();
      if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0) throw new Error('Private lifecycle log is unavailable.');
      const log=new LifecycleLog(file);
      if(stat.size<=LIFECYCLE_BYTES) {
        const buffer=Buffer.alloc(LIFECYCLE_BYTES+1),read=await file.read(buffer,0,buffer.length,0);
        log.rows=buffer.subarray(0,read.bytesRead).toString('utf8').split('\n').filter(Boolean).slice(-128).flatMap(row=> {
          try {const item=JSON.parse(row);if(typeof item.at!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(item.at)||!['start','restart','shutdown','fatal','unavailable','control'].includes(item.event)||typeof item.detail!=='string') return [];return [JSON.stringify({at:item.at.slice(0,40),event:item.event,detail:redactLifecycle(item.detail)})];} catch {return [];}
        });
      }
      log.record('start','Backend resources opened.');return log;
    } catch(error) {await file.close();throw error;}
  }
  async control(detail:string):Promise<void> {
    if(this.stopped||this.failed)throw new Error('Retained control logging is unavailable.');
    this.record('control',detail);while(this.pending)await this.pending;
    if(this.failed||this.stopped)throw new Error('Retained control logging is unavailable.');
    try {await this.file.sync();}catch {this.failed=true;throw new Error('Retained control logging is unavailable.');}
  }
  record(event:'start'|'restart'|'shutdown'|'fatal'|'unavailable'|'control',detail:string) {
    if(this.stopped||this.failed) return;
    this.rows.push(JSON.stringify({at:new Date().toISOString(),event,detail:redactLifecycle(detail)}));
    this.trimControls();
    while(this.rows.length>128||Buffer.byteLength(this.rows.join('\n'))+1>LIFECYCLE_BYTES) this.rows.shift();
    this.dirty=true;this.flush();
  }
  private trimControls() {
    let count=this.rows.filter(row=>JSON.parse(row).event==='control').length;
    while(count>64) {this.rows.splice(this.rows.findIndex(row=>JSON.parse(row).event==='control'),1);count--;}
  }
  private flush() {
    this.pending??=this.publish().catch(()=>{this.failed=true;}).finally(()=>{this.pending=undefined;if(this.dirty&&!this.failed) this.flush();});
  }
  private async publish() {
    while(this.dirty) {
      this.dirty=false;const buffer=Buffer.from(`${this.rows.join('\n')}\n`);let offset=0;
      while(offset<buffer.length) {const write=await this.file.write(buffer,offset,buffer.length-offset,offset);if(!write.bytesWritten) throw new Error('Log write stopped.');offset+=write.bytesWritten;}
      await this.file.truncate(buffer.length);
    }
  }
  async close() {this.stopped=true;while(this.pending) await this.pending;await this.file.close();}
}
