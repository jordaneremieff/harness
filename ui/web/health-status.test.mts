import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {readBackendHealth, readHealthSnapshot, type HealthSnapshot} from '../shared/health.ts';
import {identityText, type UiIdentity} from '../shared/version.ts';
import {HealthStatus, uptimeText} from './health-status.ts';
import {localDateTime} from './format.ts';
import {Modal} from './modal.ts';
const snapshot = (): HealthSnapshot => ({startedAt:'2026-10-15T00:00:00.000Z',supervisorRestarts:2,
  services:[{name:'files',state:'ready'},{name:'agents',state:'unavailable',reason:'Catalog directory is absent'},{name:'rpc',state:'stopped'}],build:{state:'held'},
  process:{pid:123,uptimeMs:61000,rssBytes:64*1024*1024},requests:{active:1,limit:64},identity:{iteration:'0.8',commit:'a'.repeat(40)},userStylesheet:{state:'applied'}});
const identity: UiIdentity = {iteration:'1.10',git:{commit:'a'.repeat(40),shortCommit:'aaaaaaa',branch:'feature/ui',modified:false,committedAt:'2026-10-12T00:00:00.000Z'},
  assets:{digest:'b'.repeat(64),builtAt:'2026-10-12T01:00:00.000Z'},startedAt:'2026-10-12T02:00:00.000Z',pi:'1.1.0',durable:'1.1.0'};
function deferred<T>() {let resolve!: (value:T)=>void, reject!: (error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle() {await Promise.resolve();await Promise.resolve();}
function host(context:TestContext, refused = false) {
  let active:Node | undefined; const copied:string[] = [];
  class Node extends EventTarget {
    id='';textContent='';className='';type='';title='';disabled=false;open=false;isConnected=true;
    value='';readOnly=false;selectionStart=0;selectionEnd=0;
    parentElement:Node|null=null;children:Node[]=[];attributes=new Map<string,string>();dataset:Record<string,string>={};
    append(...nodes:Node[]) {for(const node of nodes){node.parentElement=this;this.children.push(node);}}
    replaceChildren(...nodes:Node[]) {this.children=[];this.textContent='';this.append(...nodes);}
    insertBefore(node:Node,before:Node) {const index=this.children.indexOf(before);assert(index>=0);node.parentElement=this;this.children.splice(index,0,node);}
    setAttribute(name:string,value:string) {this.attributes.set(name,value);}
    showModal() {this.open=true;}
    close() {this.open=false;this.dispatchEvent(new Event('close'));}
    focus() {active=this;}
    select() {this.selectionStart=0;this.selectionEnd=this.value.length;}
  }
  const nodes=new Map(['modal','modal-body','modal-close','modal-title','modal-error','announcements','workbench-version'].map(id=>[id,new Node()]));
  const version=nodes.get('workbench-version');assert.ok(version);const footer=new Node();footer.append(version);const body=nodes.get('modal-body');assert.ok(body);
  const document={get activeElement(){return active;},getElementById:(id:string)=>nodes.get(id),querySelector:()=>null,createElement:()=>new Node()};
  const navigator={clipboard:{writeText:async(text:string)=>{copied.push(text);if(refused)throw new Error('Clipboard refused');}}};
  for(const [name,value] of [['document',document],['navigator',navigator],['HTMLElement',Node]] as const) {const previous=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});context.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else Reflect.deleteProperty(globalThis,name);});}
  const modal=new Modal(), texts=(node:Node):string=>[node.textContent,...node.children.map(texts)].join('\n');
  return {modal,version,footer,body,Node,copied,text:()=>texts(body),get active(){return active;},button:(label:string)=>{const node=body.children.flatMap(node=>node.children).find(node=>node.textContent===label);assert.ok(node);return node;}};
}
test('the version control opens the health dialog, which reads one snapshot per explicit open or refresh and copies the version identity',async context=>{
  const h=host(context);let reads=0;const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async()=>{reads++;return snapshot();});
  assert.equal(reads,0);assert.equal(h.footer.children.length,1,'no separate Health control joins the footer');assert.equal(h.footer.children[0],h.version);
  h.version.focus();h.version.dispatchEvent(new Event('click'));assert.equal(reads,1);assert.equal(h.button('Refresh health').disabled,true);status.open();assert.equal(reads,1);await settle();
  assert.match(h.text(),/Supervisor restarts\n2/);assert.match(h.text(),/Uptime\n1 min 1 s/);assert.match(h.text(),/64 MiB/);assert.match(h.text(),/File worker\nready/);assert.match(h.text(),/Agent worker\nunavailable: Catalog directory is absent/);assert.match(h.text(),/Primary RPC\nidle \(no primary running\)/);assert.match(h.text(),/User stylesheet\nApplied/);
  assert.equal(h.button('Refresh health').disabled,false);await settle();assert.equal(reads,1);
  h.button('Refresh health').dispatchEvent(new Event('click'));await settle();assert.equal(reads,2);
  const actions=h.body.children.find(node=>node.className==='dialog-actions');assert.ok(actions);assert.deepEqual(actions.children.map(node=>node.textContent),['Copy version','Refresh health']);
  h.button('Copy version').dispatchEvent(new Event('click'));await settle();assert.deepEqual(h.copied,[identityText(identity)]);
  globalThis.document.getElementById('modal-close')?.dispatchEvent(new Event('click'));assert.equal(h.modal.openNow,false);assert.equal(h.active as unknown,h.version);
});
test('the dialog title names version and health',async context=>{
  const h=host(context);const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async()=>snapshot());
  status.open();await settle();assert.equal(globalThis.document.getElementById('modal-title')?.textContent,'Version and health');
});
test('a refused Copy version offers the selected identity inside the open dialog',async context=>{
  const h=host(context,true);const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async()=>snapshot());
  status.open();await settle();
  h.button('Copy version').dispatchEvent(new Event('click'));await settle();await settle();
  assert.deepEqual(h.copied,[identityText(identity)]);assert.equal(h.modal.openNow,true);
  const field=[...h.body.children,...h.body.children.flatMap(node=>node.children)].find(node=>node.className==='copy-fallback');assert.ok(field);
  assert.equal(field.value,identityText(identity));assert.equal(field.readOnly,true);assert.equal(field.attributes.get('aria-label'),'Select and copy text');
  assert.equal(h.active as unknown,field);assert.equal(field.selectionStart,0);assert.equal(field.selectionEnd,field.value.length);
});
test('closing or replacing the health dialog aborts its read and rejects stale results',async context=>{
  const h=host(context), pending=deferred<unknown>();let signal:AbortSignal|undefined;
  const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async current=>{signal=current;return pending.promise;});
  status.open();assert.equal(signal?.aborted,false);h.modal.open('Another dialog').append(document.createElement('p'));assert.equal(signal?.aborted,true);
  const text=h.text();pending.resolve(snapshot());await settle();assert.equal(h.text(),text);assert.equal(h.modal.openNow,true);
  h.modal.close();const next=deferred<unknown>();let nextSignal:AbortSignal|undefined;const second=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async current=>{nextSignal=current;return next.promise;});
  second.open();h.modal.close();assert.equal(nextSignal?.aborted,true);next.reject(new Error('late failure'));await settle();assert.equal(h.modal.openNow,false);
});
test('unavailable and malformed health reads show a fixed error, allow explicit retry and expose no error content',async context=>{
  const h=host(context);let reads=0;const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async()=>{reads++;if(reads===1)throw new Error('/private/token prompt');if(reads===2)return {...snapshot(),services:[{name:'private/path',state:'ready'}]};return snapshot();});
  status.open();await settle();assert.match(h.text(),/Backend health is unavailable/);assert.equal(h.text().includes('/private/token'),false);
  h.button('Refresh health').dispatchEvent(new Event('click'));await settle();assert.match(h.text(),/Backend health is unavailable/);assert.equal(h.text().includes('private/path'),false);
  h.button('Refresh health').dispatchEvent(new Event('click'));await settle();assert.match(h.text(),/Supervisor restarts/);assert.equal(reads,3);
});
test('health projection rejects unsafe enums, strings and resource counts and drops unrelated properties',()=>{
  const current=snapshot();assert.deepEqual(readHealthSnapshot({...current,privatePath:'secret',userStylesheet:{state:'applied',path:'/private/path'},identity:{...current.identity,branch:'secret'}}),current);
  for(const value of [{...current,process:{...current.process,rssBytes:Infinity}},{...current,requests:{active:65,limit:64}},
    {...current,identity:{iteration:'<script>'}},{...current,identity:{iteration:'0.8',commit:'private/path'}},{...current,identity:{iteration:'0.8',assetDigest:'token'}},
    {...current,supervisorRestarts:1.5},{...current,startedAt:'secret'},{...current,build:{state:'secret'}},{...current,userStylesheet:{state:'/private/path'}},{...current,userStylesheet:undefined}]) assert.throws(()=>readHealthSnapshot(value),/unavailable/);
  assert.throws(()=>readBackendHealth({...current,services:Array(4).fill(current.services[0])}),/unavailable/);
  for(const reason of ['',42,'x'.repeat(161),'line\nbreak'])assert.throws(()=>readBackendHealth({...current,services:[{name:'agents',state:'unavailable',reason}]}),/unavailable/);
  assert.throws(()=>readBackendHealth({...current,services:[{name:'agents',state:'ready',reason:'Not a failure.'}]}),/unavailable/);
});
test('a reason cut to the bound with an ellipsis parses and shows in the dialog after the service state',async context=>{
  const reason=`${'Catalog scan failed: '.repeat(8).slice(0,159)}…`;assert.equal(reason.length,160);
  const h=host(context);const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async()=>({...snapshot(),services:[{name:'files',state:'ready'},{name:'agents',state:'unavailable',reason},{name:'rpc',state:'stopped'}]}));
  status.open();await settle();assert(h.text().includes(`Agent worker\nunavailable: ${reason}`));assert(h.text().includes('…'));
});
test('uptime shows its largest two units and leaves out a zero smaller unit',()=>{
  for(const [ms,text] of [[0,'0 s'],[38_000,'38 s'],[274_000,'4 min 34 s'],[7_500_000,'2 h 5 min'],[7_200_000,'2 h'],[2*86_400_000,'2 d'],[(86_400+5*3600+30*60)*1000,'1 d 5 h'],[999,'0 s']] as const)assert.equal(uptimeText(ms),text);
});
test('a local start time reads day, month and 12-hour time with seconds',()=>{
  assert.equal(localDateTime('2026-10-20T04:29:23.852Z','Australia/Brisbane'),'20 Oct, 2:29:23 PM');
  assert.equal(localDateTime('2026-10-15T00:00:00.000Z','UTC'),'15 Oct, 12:00:00 AM');assert.equal(localDateTime('secret'),'');
});
test('started, uptime and assets read in plain units with exact values in titles and the dialog closes on the window control and Escape',async context=>{
  const digest='0123456789abcdef'.repeat(4), started='2026-10-15T00:00:00.000Z';
  const h=host(context);const status=new HealthStatus(h.modal,identity,h.version as unknown as HTMLElement,async()=>({...snapshot(),startedAt:started,process:{pid:123,uptimeMs:274_000,rssBytes:64*1024*1024},identity:{iteration:'0.8',commit:'a'.repeat(40),assetDigest:digest}}));
  status.open();await settle();
  const field=(name:string)=>{const list=h.body.children.flatMap(node=>node.children).flatMap(node=>node.children);const index=list.findIndex(node=>node.textContent===name);assert.ok(index>=0);const value=list[index+1];assert.ok(value);return value;};
  assert.equal(field('Started').textContent,localDateTime(started));assert.equal(field('Started').title,started);
  assert.equal(field('Uptime').textContent,'4 min 34 s');
  assert.equal(field('Assets').textContent,digest);assert.equal(field('Assets').title,digest);
  const labels=[...h.body.children.flatMap(node=>node.children).flatMap(node=>node.children)].filter(node=>node.textContent&&['Process','Started','Uptime','Supervisor restarts','UI','Commit','Assets','User stylesheet'].includes(node.textContent)).map(node=>node.textContent);
  assert.deepEqual(labels,['Process','Started','Uptime','Supervisor restarts','UI','Commit','Assets','User stylesheet']);
  const actions=h.body.children.find(node=>node.className==='dialog-actions');assert.ok(actions);assert.deepEqual(actions.children.map(node=>node.textContent),['Copy version','Refresh health']);
  globalThis.document.getElementById('modal-close')?.dispatchEvent(new Event('click'));assert.equal(h.modal.openNow,false);
  status.open();await settle();assert.equal(h.modal.openNow,true);h.modal.node.dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(h.modal.openNow,false);
});
