import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {ContextMenu, menuPosition, nativeEditingTarget, paneMenuItems, type PaneMenuHooks} from './context-menu.ts';
import {createPaneLayout, paneById, paneLeaves, splitPane} from './pane-layout.ts';

type Handler = (event: Record<string, unknown>) => void;
class Node {
  children: Node[] = []; parent?: Node; className = ''; textContent = ''; type = ''; tabIndex = 0; title = '';
  attrs = new Map<string, string>(); style: Record<string, string> = {}; tag: string;
  handlers = new Map<string, Handler[]>(); ownerDocument: Doc; scrolled = false;
  constructor(doc: Doc, tag = 'div') { this.ownerDocument = doc; this.tag = tag; }
  get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parent?.isConnected; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null {return this.attrs.get(name) ?? null;}
  classList = {add: (name: string) => {this.className = `${this.className} ${name}`.trim();}};
  prepend(node: Node): void {node.remove(); node.parent = this; this.children.unshift(node);}
  append(...nodes: Node[]): void { for (const node of nodes) {node.remove(); node.parent = this; this.children.push(node);} }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
  contains(node?: Node): boolean { return !!node && (this === node || this.children.some(child => child.contains(node))); }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  fire(name: string, extra: Record<string, unknown> = {}) {
    const event = {target: this, defaultPrevented: false, stopped: false, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, ...extra};
    for (const handler of this.handlers.get(name) ?? []) handler(event); return event;
  }
  click(): void { this.fire('click'); }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void { this.scrolled = true; }
  getBoundingClientRect() { return {width: 260, height: 96}; }
  popover = ''; popoverShown = false;
  showPopover(): void { this.popoverShown = true; }
  closest(selector: string): Node | null {
    if (selector === 'dialog:modal') return this.tag === 'dialog' && this.attrs.has('modal') ? this : this.parent?.closest(selector) ?? null;
    return ['input', 'textarea', 'select', 'editable'].includes(this.tag) ? this : this.parent?.closest(selector) ?? null;
  }
}
class Events {
  handlers = new Map<string, Handler[]>();
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  removeEventListener(name: string, handler: Handler): void { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); }
  fire(name: string, target?: Node): void { for (const handler of [...this.handlers.get(name) ?? []]) handler({target}); }
}
class Doc extends Events {
  body = new Node(this); activeElement?: Node; announcements = new Node(this);
  defaultView = Object.assign(new Events(), {innerWidth: 320, innerHeight: 240});
  createElementNS(_ns: string, tag: string): Node {return new Node(this, tag);}
  createElement(tag: string): Node { return new Node(this, tag); }
  getElementById(): Node { return this.announcements; }
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function fixture() {
  const doc = new Doc(); Object.defineProperty(globalThis, 'document', {configurable: true, value: doc});
  const origin = new Node(doc); doc.body.append(origin); origin.focus();
  const controller = new ContextMenu(); const runs: string[] = []; let valid = true;
  controller.open(origin as unknown as HTMLElement, {x: 315, y: 235}, 'Tab actions', [
    {label: 'Activate', run: () => runs.push('activate')}, {label: 'Close', enabled: false, run: () => runs.push('close')}, {label: 'Close others', run: () => runs.push('others')},
  ], () => valid);
  const menu = doc.body.children.at(-1); assert.ok(menu);
  const key = (key: string, extra: Record<string, unknown> = {}) => menu.fire('keydown', {key, ...extra});
  return {doc, origin, controller, runs, menu, key, invalidate: () => {valid = false;}};
}
test('a modal-owned menu stays in the dialog and escapes transformed clipping through the top layer', () => {
  const doc = new Doc(); Object.defineProperty(globalThis, 'document', {configurable: true, value: doc});
  const dialog = new Node(doc, 'dialog'); dialog.attrs.set('modal', ''); doc.body.append(dialog);
  const origin = new Node(doc, 'button'); origin.setAttribute('aria-haspopup', 'menu'); dialog.append(origin); origin.focus();
  const controller = new ContextMenu(); const runs: string[] = [];
  controller.open(origin as unknown as HTMLElement, {x: 315, y: 235}, 'Saved session options', [
    {key: 'details', label: 'List details', run: () => runs.push('details')},
    {key: 'file', label: 'Session file…', run: () => runs.push('file')},
  ]);
  const menu = dialog.children.at(-1); assert.ok(menu); assert.equal(menu.parent, dialog);
  assert.equal(doc.body.children.length, 1); assert.equal(menu.popover, 'manual'); assert.equal(menu.popoverShown, true);
  assert.equal(menu.style.margin, '0'); assert.equal(menu.style.inset, 'auto');
  assert.equal(menu.style.left, '56px'); assert.equal(menu.style.top, '140px');
  assert.equal(doc.activeElement, menu.children[0]); menu.fire('keydown', {key: 'ArrowDown'});
  assert.equal(doc.activeElement, menu.children[1]); menu.fire('keydown', {key: 'Enter'});
  assert.deepEqual(runs, ['file']); assert.equal(doc.activeElement, origin); assert.equal(controller.openNow, false);
  controller.open(origin as unknown as HTMLElement, {x: 10, y: 10}, 'Saved session options', [{label: 'List details', run: () => runs.push('details')}]);
  dialog.children.at(-1)?.fire('keydown', {key: 'Escape'});
  assert.equal(controller.openNow, false); assert.equal(doc.activeElement, origin); assert.equal(origin.getAttribute('aria-expanded'), 'false');
  assert.ok([...doc.handlers.values(), ...doc.defaultView.handlers.values()].every(list => list.length === 0));
});

test('same-trigger repaint retains a focused action key across insertion and description changes', () => {
  const f = fixture(); f.origin.setAttribute('aria-haspopup', 'menu');
  const origin = f.origin as unknown as HTMLElement; const point = {x: 10, y: 10};
  f.controller.open(origin, point, 'Projects', [
    {key: 'project:/one', label: 'Same name', run() {}},
    {key: 'folder', label: 'Other folder…', run: () => f.runs.push('folder')},
    {key: 'refresh', label: 'Refresh recent projects', run() {}},
  ]);
  f.doc.body.children.at(-1)?.fire('keydown', {key: 'ArrowDown'});
  f.controller.open(origin, point, 'Projects', [
    {key: 'project:/one', label: 'Same name', run() {}},
    {key: 'project:/two', label: 'Same name', run() {}},
    {key: 'folder', label: 'Other folder…', run: () => f.runs.push('folder')},
    {key: 'refresh', label: 'Refresh recent projects', description: 'Saved list · now', run() {}},
  ]);
  const menu = f.doc.body.children.at(-1); assert.ok(menu);
  assert.equal(f.doc.activeElement, menu.children[2]);
  menu.fire('keydown', {key: 'Enter'}); assert.deepEqual(f.runs, ['folder']);
  assert.equal(f.doc.activeElement, f.origin);
  assert.ok([...f.doc.handlers.values(), ...f.doc.defaultView.handlers.values()].every(list => list.length === 0));
});
test('repaint clamps a removed choice and a different trigger starts at the first row', () => {
  const f = fixture(); f.origin.setAttribute('aria-haspopup', 'menu');
  const origin = f.origin as unknown as HTMLElement; const point = {x: 10, y: 10};
  f.controller.open(origin, point, 'Projects', [{key: 'a', label: 'A', run() {}}, {key: 'b', label: 'B', run() {}}]);
  f.doc.body.children.at(-1)?.fire('keydown', {key: 'End'});
  f.controller.open(origin, point, 'Projects', [{key: 'a', label: 'A', run() {}}]);
  assert.equal(f.doc.activeElement, f.doc.body.children.at(-1)?.children[0]);
  const other = new Node(f.doc); f.doc.body.append(other); other.setAttribute('aria-haspopup', 'menu');
  f.controller.open(other as unknown as HTMLElement, point, 'Actions', [{key: 'b', label: 'B', run() {}}, {key: 'a', label: 'A', run() {}}]);
  assert.equal(f.doc.activeElement, f.doc.body.children.at(-1)?.children[0]); f.controller.close();
});
test('menu focus, ARIA, arrow wrapping and endpoints include disabled items without activating them', () => {
  const f = fixture(); assert.equal(f.menu.attrs.get('role'), 'menu'); assert.equal(f.menu.attrs.get('aria-label'), 'Tab actions');
  assert.equal(f.doc.activeElement, f.menu.children[0]); assert.ok(f.menu.children.every(node => node.attrs.get('role') === 'menuitem' && node.tabIndex === -1));
  assert.equal(f.menu.children[1]?.attrs.get('aria-disabled'), 'true');
  const down = f.key('ArrowDown'); assert.equal(down.defaultPrevented, true); assert.equal(down.stopped, true);
  assert.equal(f.doc.activeElement, f.menu.children[1]); f.key('Enter'); assert.deepEqual(f.runs, []); assert.equal(f.controller.openNow, true);
  f.key('End'); assert.equal(f.doc.activeElement, f.menu.children[2]); f.key('ArrowDown'); assert.equal(f.doc.activeElement, f.menu.children[0]);
  f.key('ArrowUp'); assert.equal(f.doc.activeElement, f.menu.children[2]); f.key('Home'); assert.equal(f.doc.activeElement, f.menu.children[0]);
  f.key(' ', {repeat: true}); assert.deepEqual(f.runs, []); f.key(' '); assert.deepEqual(f.runs, ['activate']); assert.equal(f.controller.openNow, false); assert.equal(f.doc.activeElement, f.origin);
});
test('Escape, outside dismissal, viewport changes and focus departure release listeners and restore context', () => {
  for (const dismiss of ['escape', 'outside', 'resize', 'blur', 'focus']) {
    const f = fixture();
    if (dismiss === 'escape') f.key('Escape');
    else if (dismiss === 'outside') f.doc.fire('pointerdown', f.origin);
    else if (dismiss === 'focus') {const other = new Node(f.doc); f.doc.body.append(other); other.focus(); f.doc.fire('focusin', other); assert.equal(f.doc.activeElement, other);}
    else f.doc.defaultView.fire(dismiss);
    assert.equal(f.controller.openNow, false); assert.equal(f.menu.isConnected, false);
    if (dismiss !== 'focus') assert.equal(f.doc.activeElement, f.origin);
    assert.ok([...f.doc.handlers.values(), ...f.doc.defaultView.handlers.values()].every(list => list.length === 0));
  }
});
test('an action never dispatches after its captured target changes', () => {
  const f = fixture(); f.invalidate(); f.key('End'); f.key('Enter');
  assert.deepEqual(f.runs, []); assert.equal(f.controller.openNow, false); assert.match(f.doc.announcements.textContent, /This item changed. Choose the action again./);
});
test('menus clamp to both viewport edges and retain a scrollable size in very narrow viewports', () => {
  assert.deepEqual(menuPosition({x: 315, y: 235}, {width: 260, height: 96}, {width: 320, height: 240}), {x: 56, y: 140});
  assert.deepEqual(menuPosition({x: -20, y: -20}, {width: 100, height: 100}, {width: 320, height: 240}), {x: 4, y: 4});
  const f = fixture(); assert.equal(f.menu.style.left, '56px'); assert.equal(f.menu.style.top, '140px');
  assert.equal(f.menu.style.maxWidth, '312px'); assert.equal(f.menu.style.maxHeight, '232px'); f.controller.close();
  f.doc.defaultView.innerWidth = 180; f.doc.defaultView.innerHeight = 80;
  f.controller.open(f.origin as unknown as HTMLElement, {x: 180, y: 80}, 'Actions', [{label: 'A', run() {}}]);
  const narrow = f.doc.body.children.at(-1); assert.equal(narrow?.style.maxWidth, '172px'); assert.equal(narrow?.style.maxHeight, '72px'); assert.equal(narrow?.style.left, '4px');
  f.controller.close();
});
test('text inputs and editable descendants retain native editing menus', () => {
  const doc = new Doc();
  for (const tag of ['input', 'textarea', 'select', 'editable']) {const editor = new Node(doc, tag); const child = new Node(doc); editor.append(child); assert.equal(nativeEditingTarget(child as unknown as EventTarget), true);}
  assert.equal(nativeEditingTarget(new Node(doc) as unknown as EventTarget), false); assert.equal(nativeEditingTarget(null), false);
});

test('checked radio state, separators and Copy source descriptions remain accessible without label noise', () => {
  const doc = new Doc(); Object.defineProperty(globalThis, 'document', {configurable: true, value: doc}); const origin = new Node(doc); doc.body.append(origin); origin.focus(); origin.setAttribute('aria-haspopup', 'menu');
  const menu = new ContextMenu(); menu.open(origin as unknown as HTMLElement, {x: 10, y: 10}, 'Actions', [
    {label: 'Copy', description: 'Copies available unverified transport text. Some text is withheld.', run() {}},
    {label: 'View: Conversation', checked: true, separatorBefore: true, run() {}}, {label: 'View: Grouped', checked: false, run() {}},
    {label: 'Split right', enabled: false, disabledReason: 'Four panes maximum', run() {}},
  ]);
  const popup = doc.body.children.at(-1); assert.ok(popup); const rows = popup.children.filter(node => node.className === 'context-menu-item');
  assert.equal(rows[0]?.textContent, 'Copy'); assert.equal(rows[0]?.attrs.get('aria-description'), 'Copies available unverified transport text. Some text is withheld.'); assert.equal(rows[0]?.title, rows[0]?.attrs.get('aria-description'));
  assert.equal(rows[1]?.attrs.get('role'), 'menuitemradio'); assert.equal(rows[1]?.attrs.get('aria-checked'), 'true'); assert.equal(rows[2]?.attrs.get('aria-checked'), 'false');
  assert.equal(rows[3]?.children[0]?.textContent, 'Four panes maximum'); assert.equal(popup.children.filter(node => node.attrs.get('role') === 'separator').length, 1);
  assert.equal(origin.attrs.get('aria-expanded'), 'true'); menu.close(); assert.equal(origin.attrs.get('aria-expanded'), 'false'); assert.equal(doc.activeElement, origin);
});
function paneFixture() {
  let layout = createPaneLayout([{kind:'primary'}, {kind:'agent',identity:'a'}, {kind:'agent',identity:'b'}, {kind:'agent',identity:'c'}]);
  let valid = true; let space = {width: 1400, height: 1000, divider: 4}; const calls: string[] = [];
  const hooks: PaneMenuHooks = {layout:()=>layout, valid:()=>valid, space:()=>space, label:key=>key, change:next=>{layout=next; calls.push('change');},
    newTab:pane=>calls.push(`new:${pane}`), split:(pane,axis,key)=>calls.push(`split:${pane}:${axis}:${key}`), closeTab:key=>calls.push(`close:${key}`),
    activate:(pane,key)=>calls.push(`activate:${pane}:${key}`), view:key=>key==='agent:b'?'grouped':'chronological', setView:(key,mode)=>calls.push(`view:${key}:${mode}`)};
  return {hooks,calls,layout:()=>layout,set:(next:typeof layout)=>{layout=next;}, invalidate:()=>{valid=false;}, small:()=>{space={...space,width:335,height:240};}};
}
test('plus and right-click use one action vocabulary, checked state, eligibility and exact captured target', () => {
  const f = paneFixture(); const target = {paneId:'pane-1',tabKey:'agent:b'};
  const plus = paneMenuItems(target,f.hooks); const right = paneMenuItems(target,f.hooks);
  const signature = (items:typeof plus) => items.map(({label,enabled,checked})=>({label,enabled,checked})); assert.deepEqual(signature(plus),signature(right));
  assert.deepEqual(plus.slice(0,3).map(item=>item.label),['New tab…','Split right','Split down']);
  assert.equal(plus.find(item=>item.label==='View: Grouped')?.checked,true); plus.find(item=>item.label==='Split down')?.run(); plus.find(item=>item.label==='View: Conversation')?.run();
  assert.deepEqual(f.calls,['split:pane-1:y:agent:b','view:agent:b:chronological']);
  assert.deepEqual(paneMenuItems({paneId:'missing'},f.hooks),[]); assert.deepEqual(paneMenuItems({paneId:'pane-1',tabKey:'missing'},f.hooks),[]);
});
test('split refusal reasons appear only inside menus and never change topology', () => {
  const f = paneFixture(); f.small(); const original = f.layout(); const small = paneMenuItems({paneId:'pane-1'},f.hooks);
  assert.equal(small.find(item=>item.label==='Split right')?.enabled,false); assert.equal(small.find(item=>item.label==='Split down')?.disabledReason,'Not enough space'); assert.equal(f.layout(),original);
  let four = f.layout(); for (let i=0;i<3;i++) four=splitPane(four,'pane-1','x',{width:1400,height:1000,divider:4}); f.set(four);
  const full = paneMenuItems({paneId:'pane-1'},f.hooks); assert.equal(full.find(item=>item.label==='Split right')?.disabledReason,'Four panes maximum'); assert.equal(full.find(item=>item.label==='Split down')?.enabled,false);
});
test('move, close and Tabs rows route captured stable keys, not current selection or position', () => {
  const f = paneFixture(); f.set(splitPane(f.layout(),'pane-1','x',{width:1400,height:1000,divider:4},'agent:c'));
  const items = paneMenuItems({paneId:'pane-1',tabKey:'agent:b'},{...f.hooks,overflow:true});
  const tabs = items.filter(item=>item.label.includes('(pane') && !item.label.startsWith('Move')); assert.equal(tabs.length,4); assert.equal(tabs[0]?.heading,'Tabs'); tabs.at(-1)?.run();
  assert.deepEqual(f.calls,['activate:pane-2:agent:c']); items.find(item=>item.label==='Close tab')?.run(); assert.deepEqual(f.calls.at(-1),'close:agent:b');
  items.find(item=>item.label.startsWith('Move tab to'))?.run(); assert.equal(paneById(f.layout(),'pane-2')?.active,'agent:b'); assert.equal(paneLeaves(f.layout().root).flatMap(pane=>pane.tabs).length,4);
});
test('captured pane actions and session actions refuse stale root or recipient revision', () => {
  const doc = new Doc(); Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  for (const cause of ['root','recipient']) {
    const f=paneFixture(); const items=paneMenuItems({paneId:'pane-1'}, {...f.hooks,sessionItems:[{label:'Session action',run:()=>f.calls.push('session')}]});
    if (cause==='root') f.set(splitPane(f.layout(),'pane-1','x',{width:1400,height:1000,divider:4})); else f.invalidate();
    items[0]?.run(); items.find(item=>item.label==='Close tab')?.run(); items.find(item=>item.label==='Session action')?.run(); assert.deepEqual(f.calls,[]); assert.match(doc.announcements.textContent,/This item changed/);
  }
});

test('the small plus contains only new conversation and split actions', () => {
  const f = paneFixture(); const items = paneMenuItems({paneId:'pane-1'}, {...f.hooks, purpose:'add', overflow:true, sessionItems:[{label:'Compact…',run(){}}]});
  assert.deepEqual(items.map(item => item.label), ['New tab…', 'Split right', 'Split down']);
  items[0]?.run(); items[2]?.run(); assert.deepEqual(f.calls,['new:pane-1','split:pane-1:y:primary']);
  const context = paneMenuItems({paneId:'pane-1'}, {...f.hooks, purpose:'context', sessionItems:[{label:'Compact…',run(){}}]});
  for (const label of ['Close tab','Close pane','View: Conversation','View: Grouped','Compact…']) assert.ok(context.some(item => item.label === label));
});
