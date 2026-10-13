import assert from 'node:assert/strict';
import test from 'node:test';
import {StableViews} from './stable-views.ts';
class NodeFake {
  parentElement: NodeFake | null = null; children: NodeFake[] = []; hidden = false; inert = false; id = ''; className = ''; dataset: Record<string,string> = {};
  style = {position: '',left: '',top: '',width: '',height: '',margin: '',removeProperty: (key: string) => {Reflect.set(this.style,key,'');}};
  clientHeight = 300; connected = false; box = {left: 0,top: 0,width: 200,height: 300}; listeners = new Map<string,EventListener[]>();
  get isConnected(): boolean {return this.connected || !!this.parentElement?.isConnected;}
  append(node: NodeFake): void {node.remove(); this.children.push(node); node.parentElement = this;}
  remove(): void {if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n=>n!==this); this.parentElement = null;}
  contains(node: NodeFake): boolean {return this===node || this.children.some(n=>n.contains(node));}
  closest(): NodeFake | null {return this.hidden || this.inert ? this : this.parentElement?.closest() ?? null;}
  getBoundingClientRect() {return this.box;}
  addEventListener(name: string,listener: EventListener) {this.listeners.set(name,[...(this.listeners.get(name)??[]),listener]);}
  removeEventListener(name: string,listener: EventListener) {this.listeners.set(name,(this.listeners.get(name)??[]).filter(n=>n!==listener));}
}
function fixture() {
  const frames = new Map<number,FrameRequestCallback>(), observed = new Set<Element>(); let serial = 0;
  Object.assign(globalThis,{document:{createElement:()=>new NodeFake()},window:{addEventListener(){},removeEventListener(){}},requestAnimationFrame:(fn: FrameRequestCallback)=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:(id:number)=>frames.delete(id),ResizeObserver:class{observe(n:Element){observed.add(n);}unobserve(n:Element){observed.delete(n);}disconnect(){observed.clear();}}});
  const parent = new NodeFake(); parent.connected = true; const views = new StableViews(parent as unknown as HTMLElement); const root = new NodeFake(),part = new NodeFake();root.append(part);
  const left = new NodeFake(),right = new NodeFake();parent.append(left);parent.append(right);right.box.left=280;right.id='right';
  const e=(n:NodeFake)=>n as unknown as HTMLElement;
  return {views,parent,root,part,left,right,e,frames,observed};
}
test('logical pane placement preserves every native ancestor and mounts each root only once',()=>{
  const f=fixture(); f.views.mount(f.e(f.root));const parent=f.root.parentElement;f.views.place(f.e(f.root),f.e(f.left));f.views.sync();f.views.place(f.e(f.root),f.e(f.right));f.views.sync();
  assert.equal(f.root.parentElement,parent);assert.equal(f.part.parentElement,f.root);assert.equal(f.root.style.left,'280px');assert.equal(f.views.slot(f.e(f.part)),f.right);assert.equal(f.views.host.children.length,1);
  f.views.place(f.e(f.root));f.views.sync();assert.equal(f.root.hidden,true);assert.equal(f.root.parentElement,parent);f.views.place(f.e(f.root),f.e(f.left));f.views.sync();assert.equal(f.root.hidden,false);
});
test('nested projection preserves parent, restores flow and releases its observers',()=>{
  const f=fixture();f.views.place(f.e(f.root),f.e(f.left));f.part.style.margin='8px';f.views.project(f.e(f.part),f.e(f.right));f.views.sync();assert.equal(f.part.parentElement,f.root);assert.equal(f.views.slot(f.e(f.part)),f.right);assert.equal(f.views.height(f.e(f.part)),300);
  f.views.project(f.e(f.part));assert.equal(f.part.style.position,'');assert.equal(f.part.style.margin,'8px');assert.equal(f.observed.has(f.e(f.part)),false);assert.equal(f.views.slot(f.e(f.part)),f.left);
  f.views.forget(f.e(f.root));assert.equal(f.observed.has(f.e(f.root)),false);f.views.destroy();assert.equal(f.frames.size,0);
});
test('geometry requests coalesce and reject physical host or native root changes',()=>{
  const f=fixture();f.views.place(f.e(f.root),f.e(f.left));f.views.request();f.views.request();assert.equal(f.frames.size,1);
  f.right.append(f.root);assert.throws(()=>f.views.sync(),/changed its host/);assert.throws(()=>f.views.mount(f.e(f.right)),/before editing/);
});
