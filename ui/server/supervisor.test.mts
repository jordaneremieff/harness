import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {fork,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {supervise,type BackendReady} from './supervisor.mts';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const options={cwd:'/fixture',port:0,pi:'pi'};
class Child extends EventEmitter {
  pid=101;stdout=new EventEmitter();stderr=new EventEmitter();sent:unknown[]=[];killed:string[]=[];
  send(value:unknown,callback?:(error?:Error)=>void) {this.sent.push(value);callback?.();}
  kill(signal:string) {this.killed.push(signal);queueMicrotask(()=>this.emit('exit',0,null));return true;}
}
function fake(children:Child[]) {
  return (()=>{const child=new Child();child.pid+=children.length;children.push(child);queueMicrotask(()=>child.emit('spawn'));return child as unknown as ChildProcess;}) as typeof fork;
}
const childAt=(children:Child[],index:number)=>{const child=children[index];assert.ok(child);return child;};
const absent=()=>{throw Object.assign(new Error('Absent'),{code:'ESRCH'});};

test('crashes have a bounded rolling budget and replacements use one-shot delays',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const children:Child[]=[];
  const parent=supervise(options,{spawn:fake(children),signal:absent,restartDelayMs:10});await turn();
  for(let i=0;i<3;i++) {childAt(children,i).emit('exit',1,null);await turn();if(i<2) {context.mock.timers.tick(10*2**i);await turn();}}
  assert.equal(parent.status().state,'backend-unavailable');assert.equal(children.length,3);assert.equal(parent.restartCount(),2);
  let settled=false;void parent.closed.then(()=>{settled=true;});await turn();assert.equal(settled,false);parent.stop();assert.equal(await parent.closed,0);
});
test('stop cancels a pending replacement and does not create another child',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const children:Child[]=[];
  const parent=supervise(options,{spawn:fake(children),signal:absent});await turn();childAt(children,0).emit('exit',1,null);await turn();
  parent.stop();assert.equal(await parent.closed,0);context.mock.timers.tick(60000);await turn();assert.equal(children.length,1);
});
test('an unknown process group refuses restart rather than risking another owner',async()=> {
  const children:Child[]=[];
  const parent=supervise(options,{spawn:fake(children),signal:()=>{throw Object.assign(new Error('Unknown'),{code:'EPERM'});}});
  await turn();childAt(children,0).emit('exit',1,null);await turn();assert.equal(parent.status().state,'backend-unavailable');assert.equal(children.length,1);
});
test('readiness pins the ephemeral port, defaults development, and diagnostic chunks redact before relay',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const children:Child[]=[],output:string[]=[];
  const parent=supervise(options,{spawn:fake(children),signal:absent,output:line=>output.push(line),restartDelayMs:1});await turn();
  const child=childAt(children,0);
  child.stdout.emit('data',Buffer.from('http://127.0.0.1:1234/#lau'));
  child.stdout.emit('data',Buffer.from('nch=private\ntoken=hidden\n'));
  child.emit('message',{kind:'ready',url:'http://127.0.0.1:1234/'});
  child.emit('exit',1,null);await turn();context.mock.timers.tick(1);await turn();
  const sent=childAt(children,1).sent[0] as {options:typeof options&{devReload:boolean}};assert.equal(sent.options.port,1234);assert.equal(sent.options.devReload,true);
  assert.equal(output.join('').includes('private'),false);assert.equal(output.join('').includes('hidden'),false);
  childAt(children,1).emit('message',{kind:'ready',url:'http://127.0.0.1:80/'});
  childAt(children,1).emit('exit',1,null);await turn();context.mock.timers.tick(2);await turn();
  const defaultPort=childAt(children,2).sent[0] as {options:typeof options};assert.equal(defaultPort.options.port,80);
  parent.stop();assert.equal(await parent.closed,0);
});
test('terminal relay has a lifetime byte bound even when a child floods diagnostics',async()=> {
  const children:Child[]=[],lines:string[]=[];const parent=supervise(options,{spawn:fake(children),signal:absent,output:line=>lines.push(line)});await turn();
  const child=childAt(children,0);for(let i=0;i<256;i++)child.stderr.emit('data',Buffer.from(`${'x'.repeat(512)}\n`));
  assert.ok(Buffer.byteLength(`${lines.join('\n')}\n`)<=64*1024);assert.match(lines.at(-1)??'',/omitted/);
  parent.stop();assert.equal(await parent.closed,0);
});

test('graceful stop signals the backend first and escalates only its recorded group',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const children:Child[]=[],signals:{pid:number;signal:NodeJS.Signals|0}[]=[];let alive=true;
  const parent=supervise(options,{spawn:fake(children),graceMs:20,signal:(pid,signal)=> {
    signals.push({pid,signal});if(!alive) absent();if(signal==='SIGKILL') {alive=false;childAt(children,0).emit('exit',null,'SIGKILL');}
  }});await turn();const child=childAt(children,0);child.kill=signal=>{child.killed.push(signal);return true;};
  parent.stop();assert.deepEqual(child.killed,['SIGTERM']);assert.equal(signals.length,0);context.mock.timers.tick(20);
  assert.equal(await parent.closed,0);assert.ok(signals.every(item=>item.pid===-child.pid));
});
test('a source restart has a finite grace deadline and does not consume the crash budget',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const children:Child[]=[];let alive=true;
  const parent=supervise(options,{spawn:fake(children),graceMs:20,signal:(pid,signal)=> {
    if(pid!==-101||!alive)absent();
    if(signal==='SIGKILL') {alive=false;childAt(children,0).emit('exit',null,'SIGKILL');}
  }});await turn();childAt(children,0).emit('message',{kind:'restart'});context.mock.timers.tick(20);await turn();context.mock.timers.tick(0);await turn();
  assert.equal(children.length,2);assert.equal(parent.restartCount(),1);parent.stop();assert.equal(await parent.closed,0);
});

test('an actual crash removes an owned descendant before a replacement starts', {timeout:15000},async context=> {
  const root=await mkdtemp(join(tmpdir(),'ui-supervisor-'));await mkdir(join(root,'project'));
  const module=join(root,'child.mjs');const groups:number[]=[];let descendant=0;let ready:(value:BackendReady)=>void;
  const replacement=new Promise<BackendReady>(resolve=>{ready=resolve;});
  await writeFile(module,`import {spawn} from 'node:child_process';
process.once('message',m=>{let descendant;if(m.restarts===0){descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}).pid;}
process.send({kind:'ready',url:'http://127.0.0.1:1234/',identity:{},descendant});
if(m.restarts===0)process.exit(1);else process.on('SIGTERM',()=>process.exit(0));});`);
  const parent=supervise({cwd:join(root,'project'),port:0,pi:'pi'},{module,restartDelayMs:1,
    spawn:((...args:Parameters<typeof fork>)=>{const child=fork(...args);if(child.pid)groups.push(child.pid);return child;}) as typeof fork,
    ready:message=>{const value=message as BackendReady&{descendant?:number};if(value.descendant) descendant=value.descendant;else ready(message);}});
  context.after(async()=>{parent.stop();for(const pid of groups){try{process.kill(-pid,'SIGKILL');}catch{}}await parent.closed;await rm(root,{recursive:true,force:true});});
  await replacement;assert.ok(descendant>0);assert.throws(()=>process.kill(descendant,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH');
  assert.equal(groups.length,2);parent.stop();assert.equal(await parent.closed,0);
});
