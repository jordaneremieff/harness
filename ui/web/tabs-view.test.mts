import assert from 'node:assert/strict';
import test from 'node:test';
import type {ConversationTab} from '../shared/api.ts';
import {TabStrip, revealTabScroll, type TabHooks} from './tabs-view.ts';
import {tabKey} from './tabs.ts';
import {activatePaneTab, closePaneTab, createPaneLayout, movePaneTab, paneLeaves, splitPane, type PaneLayout} from './pane-layout.ts';

class Node extends EventTarget {
  children: Node[] = []; parent?: Node; ownerDocument: Doc; className = ''; textContent = ''; title = ''; type = ''; tabIndex = 0; draggable = false; hidden = false; dataset: Record<string,string> = {};
  attributes = new Map<string,string>(); scrollLeft = 0; offsetLeft = 0; clientWidth = 230; offsetWidth = 130; scrollWidth = 54;
  styleValues = new Map<string,string>(); style = {setProperty: (name: string, value: string) => this.styleValues.set(name, value)};
  classes = new Set<string>(); classList = {add: (...names: string[]) => {for (const name of names) this.classes.add(name);}, remove: (...names: string[]) => {for (const name of names) this.classes.delete(name);}};
  constructor(doc: Doc) {super(); this.ownerDocument = doc;}
  setAttribute(name: string, value: string): void {this.attributes.set(name, value);}
  append(...nodes: Node[]): void {for (const node of nodes) this.insertBefore(node, null);}
  replaceChildren(...nodes: Node[]): void {for (const child of [...this.children]) child.remove(); this.textContent = ''; this.append(...nodes);}
  insertBefore(node: Node, next: Node | null): void {node.remove(); node.parent = this; this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node);}
  remove(): void {if (this.parent) {this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined;}}
  contains(node?: Node): boolean {return !!node && (node === this || this.children.some(child => child.contains(node)));}
  querySelector(selector: string): Node | null {return this.children.find(node => node.className === selector.slice(1)) ?? null;}
  getBoundingClientRect(): {left: number} {return {left: (this.parent?.getBoundingClientRect().left ?? 0) + this.offsetLeft - (this.parent?.scrollLeft ?? 0)};}
  focus(): void {this.ownerDocument.activeElement = this;}
}
class Doc {activeElement?: Node; createElementNS(): Node {return new Node(this);} createElement(): Node {return new Node(this);}}
class Observer {
  static instances: Observer[] = []; observed = new Set<unknown>(); callback: () => void;
  constructor(callback: () => void) {this.callback = callback; Observer.instances.push(this);}
  observe(node: unknown): void {this.observed.add(node);} unobserve(node: unknown): void {this.observed.delete(node);} disconnect(): void {this.observed.clear();} resize(): void {this.callback();}
}
Object.defineProperty(globalThis, 'ResizeObserver', {value: Observer, configurable: true});
Object.defineProperty(globalThis, 'getComputedStyle', {value: () => ({paddingLeft:'14px', paddingRight:'8px', columnGap:'8px', minWidth:'64px'}), configurable: true});
function event(node: Node | null | undefined, type: string, fields: Record<string,unknown> = {}): Event {
  assert.ok(node); const e = new Event(type, {cancelable:true}); const {target, ...rest} = fields; Object.assign(e, rest); if (target) Object.defineProperty(e, 'target', {value:target}); node.dispatchEvent(e); return e;
}
function fixture(tabs: ConversationTab[] = [{kind:'primary'}, {kind:'agent',identity:'a'}, {kind:'agent',identity:'b'}, {kind:'agent',identity:'c'}], options: Partial<Pick<TabHooks,'label'|'status'>> = {}) {
  const doc = new Doc(); const conversations = new Node(doc); const hosts = new Map<string,Node>(); const overflow = new Map<string,boolean>();
  let layout = createPaneLayout(tabs); const calls: string[] = []; const moves: string[] = [];
  const regions = () => paneLeaves(layout.root).map(pane => {let host = hosts.get(pane.id); if (!host) {host = new Node(doc); host.clientWidth = 760; hosts.set(pane.id, host);} return {id:pane.id,tabs:host as unknown as HTMLElement,controls:`content-${pane.id}`};});
  const strip = new TabStrip({layout:()=>layout, label:tab=>tabKey(tab), status:()=>({label:'Ready',glyph:'✓'}), ...options,
    activate:(pane,key)=>{calls.push(`${pane}:${key}`); layout=activatePaneTab(layout,pane,key); strip.render();},
    close:key=>{layout=closePaneTab(layout,key); strip.render();},
    move:(key,pane,index)=>{moves.push(`${key}:${pane}:${index}`); layout=movePaneTab(layout,key,pane,index); strip.render();}, overflow:(value,pane)=>overflow.set(pane,value),
  }, {panes:regions, conversations:conversations as unknown as HTMLElement});
  strip.render(); const root = (id='pane-1') => {const host=hosts.get(id); assert.ok(host); return host;};
  const set = (next:PaneLayout) => {layout=next; strip.render();};
  const split = (id='pane-1',axis:'x'|'y'='x',key?:string) => set(splitPane(layout,id,axis,{width:1400,height:1000,divider:4},key));
  const rows = () => conversations.children.filter(node=>node.className==='conversation-group').flatMap(group=>group.querySelector('.conversation-list')?.children ?? []);
  return {doc,strip,root,hosts,conversations,overflow,calls,moves,rows,layout:()=>layout,set,split};
}
test('retained tabs preserve identity, accessible target controls and selected state through repaint', () => {
  const f=fixture(); const nodes=[...f.root().children]; nodes[0]?.focus(); f.strip.render(); assert.deepEqual(f.root().children,nodes); assert.equal(f.doc.activeElement,nodes[0]);
  assert.equal(nodes[0]?.attributes.get('role'),'tab'); assert.equal(nodes[0]?.attributes.get('aria-controls'),'content-pane-1'); assert.equal(nodes[0]?.attributes.get('aria-selected'),'true');
  assert.equal(nodes[1]?.tabIndex,-1); assert.equal(nodes[1]?.querySelector('.tab-state'),null); assert.equal(nodes[1]?.querySelector('.tab-dot')?.children[0]?.attributes.get('class'),'card-icon card-icon-success'); assert.equal(nodes[1]?.querySelector('.tab-close')?.attributes.get('aria-label'),'Close agent:a tab');
});
test('mixed split axes move the same keyed nodes into any target-independent group', () => {
  const f=fixture(); const original=[...f.root().children]; f.split('pane-1','x','agent:b'); f.split('pane-1','y','primary');
  assert.equal(f.root('pane-2').children[0],original[2]); assert.equal(f.root('pane-3').children[0],original[0]);
  assert.equal(original[0]?.attributes.get('aria-controls'),'content-pane-3'); assert.equal(original[2]?.attributes.get('aria-controls'),'content-pane-2');
  assert.equal(original[0]?.attributes.get('aria-selected'),'true'); assert.equal(original[2]?.attributes.get('aria-selected'),'true'); assert.equal(original[1]?.attributes.get('aria-selected'),'true');
  assert.equal(new Set([...f.hosts.values()].flatMap(host=>host.children)).size,4);
});
test('explicit tab and sidebar activation invoke exact pane/key even for its already-selected target', () => {
  const f=fixture(); f.split('pane-1','x','agent:b'); event(f.root().children[0],'click'); assert.equal(f.layout().focusedPane,'pane-1');
  event(f.root().children[0],'click'); assert.deepEqual(f.calls.slice(-2),['pane-1:primary','pane-1:primary']);
  const row=f.rows().find(row=>row.dataset.tabKey==='agent:b'); assert.ok(row); event(row,'click'); assert.equal(f.layout().focusedPane,'pane-2');
  assert.equal(row.attributes.get('aria-current'),'true'); assert.equal(f.root('pane-2').dataset.focused,'true'); assert.equal(f.root().dataset.focused,'false');
});
test('sidebar rows retain nodes and exact routing when tabs cross groups', () => {
  const f=fixture(); const original=f.rows(); const b=original[2]; f.split('pane-1','x','agent:b'); assert.ok(b);
  assert.ok(f.rows().includes(b)); assert.equal(b.dataset.paneId,'pane-2'); assert.equal(b.attributes.get('aria-controls'),'content-pane-2');
  f.set(movePaneTab(f.layout(),'agent:b','pane-1',0)); assert.ok(f.rows().includes(b)); assert.equal(b.dataset.paneId,'pane-1');
  event(b,'click'); assert.deepEqual(f.calls.at(-1),'pane-1:agent:b'); assert.equal(f.conversations.children.filter(node=>node.className==='conversation-group').length,1);
});
test('close-button and sidebar focus survive a move of their retained nodes', () => {
  const f=fixture(); const node=f.root().children[2]; const close=node?.querySelector('.tab-close'); assert.ok(node); assert.ok(close); close.focus();
  f.split('pane-1','x','agent:b'); assert.equal(f.doc.activeElement,close); assert.equal(node.parent,f.root('pane-2'));
  const row=f.rows().find(row=>row.dataset.tabKey==='agent:b'); assert.ok(row); row.focus(); f.set(movePaneTab(f.layout(),'agent:b','pane-1',0));
  assert.equal(f.doc.activeElement,row); assert.equal(f.root().children[0],node); assert.equal(node.querySelector('.tab-close'),close);
});
test('close and middle click remove only the addressed stable tab, release its observer and choose adjacent focus', () => {
  const f=fixture(); const node=f.root().children[1]; assert.ok(node); event(node.querySelector('.tab-close'),'click');
  assert.equal(f.layout().root.kind==='pane' && f.layout().root.tabs.some(tab=>tabKey(tab)==='agent:a'),false); assert.equal(Observer.instances.at(-1)?.observed.has(node),false);
  const b=f.root().children[1]; assert.equal(event(b,'auxclick',{button:1}).defaultPrevented,true); assert.equal(f.root().children.length,2);
});
test('close-button activation keys stay native and never activate their parent', () => {
  for (const key of ['Enter',' ']) {const f=fixture(); const node=f.root().children[1]; const close=node?.querySelector('.tab-close'); assert.ok(close);
    assert.equal(event(node,'keydown',{key,target:close}).defaultPrevented,false); assert.equal(f.calls.length,0); event(close,'click'); assert.equal(f.root().children.length,3);}
});
test('pane-local arrows/endpoints and existing reorder keys never navigate another group', () => {
  const f=fixture(); f.split('pane-1','x','agent:b'); const root=f.root();
  event(root.children[0],'keydown',{key:'End'}); assert.deepEqual(f.calls.at(-1),'pane-1:agent:c');
  event(root.children[2],'keydown',{key:'Home'}); assert.deepEqual(f.calls.at(-1),'pane-1:primary');
  event(root.children[2],'keydown',{key:'ArrowLeft',altKey:true,shiftKey:true}); assert.deepEqual(f.moves.at(-1),'agent:c:pane-1:1');
  assert.equal(f.layout().root.kind==='split' && f.layout().root.first.kind==='pane' && f.layout().root.first.active,'primary');
  assert.equal(event(root.children[0],'keydown',{key:'End',isComposing:true}).defaultPrevented,false);
  assert.equal(event(root.children[0],'keydown',{key:'End',ctrlKey:true}).defaultPrevented,false);
});
test('toolbar steps address only the requested pane and stop at its tab boundaries', () => {
  const f = fixture(); f.split('pane-1', 'x', 'agent:b');
  f.strip.step('pane-1', 1); assert.equal(f.calls.at(-1), 'pane-1:agent:a'); assert.equal(f.doc.activeElement, f.root().children[1]);
  const count = f.calls.length; f.strip.step('pane-2', 1); f.strip.step('missing-pane', -1); assert.equal(f.calls.length, count);
  f.strip.step('pane-1', -1); assert.equal(f.calls.at(-1), 'pane-1:primary');
  const before = f.calls.length; f.strip.step('pane-1', -1); assert.equal(f.calls.length, before);
});
test('shared sidebar status SVGs keep authored labels and retained nodes through repaint', () => {
  let status = {label: 'Ready', glyph: '✓'}; const f = fixture(undefined, {status: () => status});
  const row = f.rows()[0]; const state = row?.querySelector('.conversation-state'); assert.ok(row); assert.ok(state);
  const ready = state.children[0]; assert.equal(ready?.attributes.get('class'), 'card-icon card-icon-success');
  f.strip.render(); assert.equal(state.children[0], ready);
  status = {label: 'Working · Read', glyph: '●'}; f.strip.render();
  assert.equal(f.rows()[0], row); assert.equal(state.children.length, 1); assert.equal(state.children[0]?.attributes.get('class'), 'card-icon card-icon-working');
  assert.equal(state.title, 'Working · Read'); assert.match(row.attributes.get('aria-label') ?? '', /Working · Read/);
  assert.equal(f.root().children[0]?.querySelector('.tab-dot')?.dataset.state, 'working');
});
test('owned drag moves across panes, retains the target node and does not accept an external drag', () => {
  const f=fixture(); f.split('pane-1','x','agent:b'); const source=f.root().children[1]; const target=f.root('pane-2').children[0]; assert.ok(source); assert.ok(target);
  assert.equal(event(target,'dragover').defaultPrevented,false); event(source,'dragstart'); assert.equal(event(target,'dragover').defaultPrevented,true);
  event(target,'drop'); assert.equal(f.root('pane-2').children[0],source); assert.equal(source.classes.has('tab-dragging'),false);
  assert.deepEqual(f.moves.at(-1),'agent:a:pane-2:0'); assert.equal(source.attributes.get('aria-controls'),'content-pane-2');
});
test('empty provisional strip accepts an owned drop and old strip listeners disappear on collapse', () => {
  const f=fixture([{kind:'primary'},{kind:'agent',identity:'a'}]); f.split('pane-1','x','agent:a'); f.split('pane-2','y');
  const empty=f.root('pane-3'); const source=f.root().children[0]; const old=f.root(); assert.ok(source);
  event(source,'dragstart'); assert.equal(event(empty,'dragover').defaultPrevented,true); event(empty,'drop'); assert.equal(empty.children[0],source);
  assert.equal(Observer.instances.at(-1)?.observed.has(old),false); assert.equal(event(old,'dragover').defaultPrevented,false);
});
test('each group fits its own status/width and overflow; narrowness does not remove the name', () => {
  const f=fixture(undefined,{label:()=> 'A very long conversation name',status:()=>({label:'Custom activity',glyph:'?'} )}); f.split('pane-1','x','agent:b');
  f.root().clientWidth=335; f.root().scrollWidth=900; f.root('pane-2').clientWidth=440; f.root('pane-2').scrollWidth=440;
  for (const node of f.root().children) node.clientWidth=130; f.strip.render();
  assert.equal(f.root().styleValues.has('--tab-share'),false); assert.equal(f.root('pane-2').styleValues.has('--tab-share'),false);
  assert.equal(f.overflow.get('pane-1'),true); assert.equal(f.overflow.get('pane-2'),false);
  for (const node of f.root().children) {assert.equal(node.querySelector('.tab-state'),null); assert.equal(node.querySelector('.tab-dot')?.title,'Custom activity'); assert.equal(node.querySelector('.tab-dot')?.children[0]?.attributes.get('class'),'card-icon card-icon-unknown'); assert.equal(node.querySelector('.tab-label')?.textContent,'A very long conversation name'); assert.match(node.attributes.get('aria-label')??'',/Custom activity/);}
});
test('repeated resize retains full exceptional status instead of erasing it', () => {
  const f=fixture([{kind:'primary'},{kind:'agent',identity:'a'}], {label:tab=>tab.kind==='primary'?'Primary':'Parser',status:()=>({label:'Working · bash',glyph:'○'})});
  const node=f.root().children[0]; const state=node?.querySelector('.tab-dot'); assert.ok(node); assert.ok(state);
  const mark=state.children[0]; assert.equal(mark?.attributes.get('class'),'card-icon card-icon-disconnected');
  node.clientWidth=280; const observer=Observer.instances.at(-1); assert.ok(observer);
  for (let i=0;i<3;i++) {observer.resize(); assert.equal(state.children[0],mark); assert.equal(state.title,'Working · bash');}
  assert.equal(node.querySelector('.tab-label')?.textContent,'Primary');
  assert.equal(f.root().children[1]?.querySelector('.tab-label')?.textContent,'Parser');
  assert.equal(node.attributes.get('aria-label'),'Primary, Working · bash'); assert.match(node.title,/Working · bash/);
  assert.equal(node.querySelector('.tab-state'),null);
  node.clientWidth=400; observer.resize(); assert.equal(state.children[0],mark);
  node.clientWidth=280; observer.resize(); observer.resize(); assert.equal(state.children[0],mark);
});
test('full status labels stay authoritative and status repaint preserves retained focus', () => {
  let status={label:'Custom',glyph:'●'}; const f=fixture(undefined,{status:()=>status}); const node=f.root().children[1]; assert.ok(node); node.focus();
  assert.equal(node.querySelector('.tab-dot')?.title,'Custom'); assert.equal(node.querySelector('.tab-dot')?.children[0]?.attributes.get('class'),'card-icon card-icon-working'); status={label:'Working',glyph:'○'}; f.strip.render();
  assert.equal(node.querySelector('.tab-dot')?.title,'Working'); assert.equal(node.querySelector('.tab-dot')?.children[0]?.attributes.get('class'),'card-icon card-icon-disconnected'); assert.equal(f.doc.activeElement,node); assert.match(node.attributes.get('aria-label')??'',/Working/);
});
test('active reveal scrolls only its local host and repaint preserves manual strip position and draft selection', () => {
  const f=fixture(Array.from({length:11},(_,i)=>({kind:'agent',identity:String(i)}))); f.set(activatePaneTab(f.layout(),'pane-1','agent:10'));
  const root=f.root(); root.clientWidth=500; root.scrollWidth=1600; root.children.forEach((node,index)=>{node.offsetLeft=index*130; node.offsetWidth=130;});
  const editor=Object.assign(new Node(f.doc),{value:'retained draft',selectionStart:2,selectionEnd:7}); editor.focus();
  f.strip.requestReveal(); f.strip.render(); assert.equal(root.scrollLeft,930); assert.equal(f.doc.activeElement,editor); assert.equal(editor.value,'retained draft'); assert.deepEqual([editor.selectionStart,editor.selectionEnd],[2,7]);
  root.scrollLeft=20; f.strip.render(); assert.equal(root.scrollLeft,20); const observer=Observer.instances.at(-1); assert.ok(observer); observer.resize();
  root.clientWidth=400; observer.resize(); assert.equal(root.scrollLeft,1030); assert.equal(f.doc.activeElement,editor);
});
test('zero-width hidden groups retain tabs without scroll/focus theft and reveal after they reappear', () => {
  const f=fixture(); f.split('pane-1','x','agent:b'); const node=f.root().children[0]; const editor=new Node(f.doc); editor.focus(); f.root().clientWidth=0;
  f.strip.render(); f.strip.revealActive('pane-1'); assert.equal(f.root().children[0],node); assert.equal(f.doc.activeElement,editor); assert.equal(f.overflow.get('pane-1'),false);
  f.root().clientWidth=760; f.strip.render(); assert.equal(f.root().children[0],node);
});
test('destroy releases observer and strip drop handlers exactly once and never clears unrelated sidebar children', () => {
  const f=fixture(); const unrelated=new Node(f.doc); f.conversations.append(unrelated); const observer=Observer.instances.at(-1); assert.ok(observer);
  const root=f.root(); f.strip.destroy(); f.strip.destroy(); assert.equal(observer.observed.size,0); assert.deepEqual(f.conversations.children,[unrelated]);
  assert.equal(event(root,'dragover').defaultPrevented,false); observer.resize(); f.strip.render(); assert.equal(root.children.length,0);
});
test('Open conversations stays separate from catalogs and empty pane groups have no visible heading', () => {
  const f = fixture([]), heading = f.conversations.querySelector('.conversation-heading'); assert.ok(heading);
  assert.equal(heading.textContent, 'Open conversations'); assert.equal(heading.hidden, true);
  assert.ok(f.conversations.children.filter(node => node.className === 'conversation-group').every(node => node.hidden));
  f.set(createPaneLayout([{kind: 'primary'}])); assert.equal(heading.hidden, false); assert.equal(f.rows().length, 1);
  assert.equal(f.conversations.attributes.get('aria-label'), 'Open conversations');
});
test('strip reveal uses only the nearest hidden edge', () => {
  assert.equal(revealTabScroll(0,200,0,1500),0); assert.equal(revealTabScroll(300,200,0,1500),0);
  assert.equal(revealTabScroll(200,500,300,130),200); assert.equal(revealTabScroll(200,500,100,130),100); assert.equal(revealTabScroll(0,500,1300,130),930);
});

test('a sole oversized tab exposes strip overflow without erasing its name or exceptional status', () => {
  const name = 'Long named conversation with its complete caption retained';
  const f = fixture([{kind: 'primary'}], {label: () => name, status: () => ({label: 'Failed', glyph: '!'})});
  const host = f.root(), node = host.children[0]; assert.ok(node);
  host.clientWidth = 200; host.scrollWidth = 1600; host.scrollLeft = 300; node.offsetWidth = 1600; node.offsetLeft = 0;
  f.strip.requestReveal(); f.strip.render();
  assert.equal(host.dataset.sole, 'true'); assert.equal(f.overflow.get('pane-1'), true); assert.equal(host.scrollLeft, 0);
  assert.equal(node.querySelector('.tab-label')?.textContent, name); assert.equal(node.querySelector('.tab-dot')?.title, 'Failed');
  assert.equal(node.querySelector('.tab-dot')?.children[0]?.attributes.get('class'), 'card-icon card-icon-error'); assert.equal(node.querySelector('.tab-state'), null); assert.ok(node.querySelector('.tab-close'));
  assert.match(node.attributes.get('aria-label') ?? '', /complete caption retained, Failed/);
});
test('a sole tab fills the strip and Ready never competes with its name', () => {
  const f = fixture([{kind:'primary'}], {label:()=> 'Long named conversation'});
  const node = f.root().children[0]; assert.ok(node); assert.equal(f.root().dataset.sole,'true');
  assert.equal(node.querySelector('.tab-label')?.textContent,'Long named conversation'); assert.equal(node.querySelector('.tab-state'),null); assert.equal(node.querySelector('.tab-dot')?.children[0]?.attributes.get('class'),'card-icon card-icon-success');
  assert.match(node.attributes.get('aria-label') ?? '', /Long named conversation, Ready/);
  assert.equal(node.querySelector('.tab-close')?.children[0]?.attributes.get('class'),'card-icon card-icon-close');
});
