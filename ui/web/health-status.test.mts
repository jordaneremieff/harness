import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {readBackendHealth, readHealthSnapshot, type HealthSnapshot} from '../shared/health.ts';
import {HealthStatus} from './health-status.ts';
import {Modal} from './modal.ts';
const snapshot = (): HealthSnapshot => ({startedAt:'2026-10-15T00:00:00.000Z',supervisorRestarts:2,
  services:[{name:'files',state:'ready'},{name:'agents',state:'unavailable',reason:'Catalog directory is absent'},{name:'rpc',state:'stopped'}],build:{state:'held'},
  process:{pid:123,uptimeMs:61000,rssBytes:64*1024*1024},requests:{active:1,limit:64},identity:{iteration:'0.8',commit:'a'.repeat(40)},userStylesheet:{state:'applied'}});
function deferred<T>() {let resolve!: (value:T)=>void, reject!: (error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle() {await Promise.resolve();await Promise.resolve();}
function host(context:TestContext) {
  let active:Node | undefined;
  class Node extends EventTarget {
    id='';textContent='';className='';type='';title='';disabled=false;open=false;isConnected=true;
    parentElement:Node|null=null;children:Node[]=[];attributes=new Map<string,string>();dataset:Record<string,string>={};
    append(...nodes:Node[]) {for(const node of nodes){node.parentElement=this;this.children.push(node);}}
    replaceChildren(...nodes:Node[]) {this.children=[];this.textContent='';this.append(...nodes);}
    insertBefore(node:Node,before:Node) {const index=this.children.indexOf(before);assert(index>=0);node.parentElement=this;this.children.splice(index,0,node);}
    setAttribute(name:string,value:string) {this.attributes.set(name,value);}
    showModal() {this.open=true;}
    close() {this.open=false;this.dispatchEvent(new Event('close'));}
    focus() {active=this;}
  }
  const nodes=new Map(['modal','modal-body','modal-close','modal-title','modal-error','workbench-version'].map(id=>[id,new Node()]));
  const version=nodes.get('workbench-version');assert.ok(version);const footer=new Node();footer.append(version);const body=nodes.get('modal-body');assert.ok(body);
  const document={get activeElement(){return active;},getElementById:(id:string)=>nodes.get(id),createElement:()=>new Node()};
  for(const [name,value] of [['document',document],['HTMLElement',Node]] as const) {const previous=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});context.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else Reflect.deleteProperty(globalThis,name);});}
  const modal=new Modal(), texts=(node:Node):string=>[node.textContent,...node.children.map(texts)].join('\n');
  return {modal,version,footer,body,Node,text:()=>texts(body),get active(){return active;},button:(label:string)=>{const node=body.children.flatMap(node=>node.children).find(node=>node.textContent===label);assert.ok(node);return node;}};
}
test('health has one footer control, no startup read and one snapshot per explicit open or refresh',async context=>{
  const h=host(context);let reads=0;const status=new HealthStatus(h.modal,h.version as unknown as HTMLElement,async()=>{reads++;return snapshot();});
  assert.equal(reads,0);assert.equal(h.footer.children.length,2);assert.equal(h.footer.children[0] as unknown,status.node);assert.equal(h.footer.children[1],h.version);
  assert.equal(status.node.textContent,'Health');assert.equal((status.node as unknown as InstanceType<typeof h.Node>).attributes.get('aria-label'),'Read backend health');
  status.node.focus();status.node.dispatchEvent(new Event('click'));assert.equal(reads,1);assert.equal(h.button('Refresh health').disabled,true);status.open();assert.equal(reads,1);await settle();
  assert.match(h.text(),/Supervisor restarts\n2/);assert.match(h.text(),/61 s/);assert.match(h.text(),/64 MiB/);assert.match(h.text(),/File worker\nready/);assert.match(h.text(),/Agent worker\nunavailable: Catalog directory is absent/);assert.match(h.text(),/Primary RPC\nidle \(no primary running\)/);assert.match(h.text(),/User stylesheet\nApplied/);
  assert.equal(h.button('Refresh health').disabled,false);await settle();assert.equal(reads,1);
  h.button('Refresh health').dispatchEvent(new Event('click'));await settle();assert.equal(reads,2);
  h.button('Close').dispatchEvent(new Event('click'));assert.equal(h.modal.openNow,false);assert.equal(h.active as unknown,status.node);
});
test('closing or replacing the health dialog aborts its read and rejects stale results',async context=>{
  const h=host(context), pending=deferred<unknown>();let signal:AbortSignal|undefined;
  const status=new HealthStatus(h.modal,h.version as unknown as HTMLElement,async current=>{signal=current;return pending.promise;});
  status.open();assert.equal(signal?.aborted,false);h.modal.open('Another dialog').append(document.createElement('p'));assert.equal(signal?.aborted,true);
  const text=h.text();pending.resolve(snapshot());await settle();assert.equal(h.text(),text);assert.equal(h.modal.openNow,true);
  h.modal.close();const next=deferred<unknown>();let nextSignal:AbortSignal|undefined;const second=new HealthStatus(h.modal,h.version as unknown as HTMLElement,async current=>{nextSignal=current;return next.promise;});
  second.open();h.modal.close();assert.equal(nextSignal?.aborted,true);next.reject(new Error('late failure'));await settle();assert.equal(h.modal.openNow,false);
});
test('unavailable and malformed health reads show a fixed error, allow explicit retry and expose no error content',async context=>{
  const h=host(context);let reads=0;const status=new HealthStatus(h.modal,h.version as unknown as HTMLElement,async()=>{reads++;if(reads===1)throw new Error('/private/token prompt');if(reads===2)return {...snapshot(),services:[{name:'private/path',state:'ready'}]};return snapshot();});
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
