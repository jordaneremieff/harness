import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposerOverlay } from './composer-overlay.ts';
class NodeFake extends EventTarget {
  parentElement: NodeFake | null = null;
  value = 'prose `code`\n```ts\nconst x=1\n```'; hidden = false; isConnected = true; scrollTop = 0; scrollLeft = 0;
  clientWidth = 320; clientHeight = 96; scrollWidth = 320; scrollHeight = 96; offsetWidth = 320; offsetHeight = 96;
  fractionalHeight = 0;
  getBoundingClientRect() {return {width: this.offsetWidth, height: this.offsetHeight + this.fractionalHeight};}
  getContext() {return {font: '', measureText: (text: string) => ({width: text.length * 8})};} style: Record<string, string> = {}; dataset: Record<string, string> = {};
  children: NodeFake[] = []; textContent = ''; attributes = new Map<string, string>();
  append(...nodes: NodeFake[]) {this.children.push(...nodes);}
  replaceChildren(...nodes: NodeFake[]) {this.children = nodes;}
  removeAttribute(name: string) {if (name === 'data-decorated') delete this.dataset.decorated; this.attributes.delete(name);}
  setAttribute(name: string, value: string) {this.attributes.set(name, value);}
  getAttribute(name: string) {return this.attributes.get(name) ?? null;}
  closest() {return null;}
}
test('overlay installs exact inert source, invalidates immediately and restores measured scroll and metrics', t => {
  const names = ['CSS', 'Highlight', 'document', 'window', 'ResizeObserver', 'MutationObserver', 'matchMedia', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const original = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => {for (const [name, descriptor] of original) {if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);}});
  const frames = new Map<number, () => void>(); let id = 0; let forced = false; const observers: ((records?: unknown[]) => void)[] = [];
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, {configurable: true, value});
  class RangeFake {source?: NodeFake; start = 0; end = 0; setStart(source: NodeFake, at: number) {this.source = source; this.start = at;} setEnd(source: NodeFake, at: number) {assert.equal(source, this.source); this.end = at;}}
  const registry = new Map<string, Set<RangeFake>>(); define('CSS', {highlights: registry}); define('Highlight', Set);
  define('document', {createRange: () => new RangeFake(), documentElement: new NodeFake(), fonts: new EventTarget(), createElement: () => new NodeFake(), createDocumentFragment: () => new NodeFake(), createTextNode: (text: string) => {const node = new NodeFake(); node.textContent = text; return node;}});
  const view = Object.assign(new EventTarget(), {devicePixelRatio: 1, visualViewport: Object.assign(new EventTarget(), {scale: 1})}); define('window', view);
  const media = new Map<string, EventTarget>();
  class Observer {constructor(callback: () => void) {observers.push(callback);} observe() {} disconnect() {}}
  define('ResizeObserver', Observer); define('MutationObserver', Observer);
  define('matchMedia', (query: string) => {const result = Object.assign(new EventTarget(), {matches: query.includes('forced-colors') && forced}); media.set(query, result); return result;});
  define('getComputedStyle', (node: NodeFake) => ({transform: node.style.transform ?? 'none', zoom: node.style.zoom ?? '1', lineHeight: '24px', fontFamily: 'sans-serif', writingMode: 'horizontal-tb', textAlign: 'start', paddingLeft: '0px', paddingRight: '0px', fontStyle: 'normal', fontWeight: '400', fontSize: '15px', fontKerning: 'none', fontVariantLigatures: 'none'}));
  define('requestAnimationFrame', (callback: () => void) => {frames.set(++id, callback); return id;}); define('cancelAnimationFrame', (key: number) => frames.delete(key));
  const flush = () => {const ready = [...frames.values()]; frames.clear(); for (const frame of ready) frame();};
  const editor = new NodeFake(), layer = new NodeFake(); const overlay = new ComposerOverlay(editor as unknown as HTMLTextAreaElement, layer as unknown as HTMLElement);
  overlay.invalidate(); overlay.invalidate(); assert.equal(frames.size, 1); flush(); assert.equal(editor.dataset.decorated, 'true'); assert.equal(layer.hidden, false);
  const source = (node: NodeFake): string => node.textContent + node.children.map(source).join(''); assert.equal(source(layer), `${editor.value}\n`); assert.equal(layer.children[0]?.children.length, 1); assert.ok(registry.size > 0);
  editor.value = 'latest `edit`'; editor.dispatchEvent(new Event('input')); assert.equal(layer.hidden, true); assert.equal(editor.dataset.decorated, undefined); assert.equal(registry.size, 0); flush(); assert.equal(source(layer), `${editor.value}\n`);
  editor.scrollTop = 24; editor.scrollLeft = 7; editor.dispatchEvent(new Event('scroll')); assert.equal(layer.hidden, true); flush();
  assert.equal(layer.scrollLeft, 7); assert.equal(layer.scrollTop, 24); assert.equal(layer.children[0]?.style.transform, undefined); assert.equal(layer.style.width, '320px'); assert.equal(layer.children[0]?.style.fontFamily, 'sans-serif'); assert.equal(layer.children[0]?.style.fontKerning, 'none'); assert.equal(layer.children[0]?.style.fontVariantLigatures, 'none');
  observers[1]?.([{attributeName: 'data-appearance', oldValue: null}]); assert.equal(frames.size, 0); assert.equal(layer.hidden, false);
  document.documentElement.setAttribute('data-appearance', 'light');
  observers[0]?.(); observers[1]?.([{attributeName: 'data-appearance', oldValue: 'dark'}]); assert.equal(frames.size, 1); assert.equal(layer.hidden, true); flush(); assert.equal(editor.dataset.decorated, 'true');
  forced = true; overlay.invalidate(); flush(); assert.equal(layer.hidden, true); forced = false;
  editor.dispatchEvent(new Event('compositionstart')); flush(); assert.equal(layer.hidden, true);
  editor.dispatchEvent(new Event('compositionend')); flush(); assert.equal(layer.hidden, false);
  editor.value = ''; overlay.invalidate(); flush(); assert.equal(layer.hidden, true);
  editor.value = 'plain prose'; overlay.invalidate(); flush(); assert.equal(layer.hidden, true); editor.value = '`code`';
  editor.scrollHeight = 120; overlay.invalidate(); flush(); assert.equal(layer.hidden, false); assert.equal(layer.scrollTop, 24); editor.scrollHeight = 96;
  editor.fractionalHeight = -0.25; overlay.invalidate(); flush(); assert.equal(layer.style.height, '95.75px'); editor.fractionalHeight = 0;
  view.devicePixelRatio = 2; media.get('(resolution: 1dppx)')?.dispatchEvent(new Event('change')); assert.equal(layer.hidden, true); flush(); assert.equal(layer.hidden, false);
  view.devicePixelRatio = 1.25; media.get('(resolution: 2dppx)')?.dispatchEvent(new Event('change')); flush(); assert.equal(layer.hidden, true); view.devicePixelRatio = 1;
  view.visualViewport.scale = 1.2; overlay.invalidate(); flush(); assert.equal(layer.hidden, true); view.visualViewport.scale = 1;
  const parent = new NodeFake(); editor.parentElement = parent;
  parent.style.transform = 'matrix(1.0001, 0, 0, 1.0001, 0, 0)'; overlay.invalidate(); flush(); assert.equal(layer.hidden, true);
  parent.style.transform = 'none'; parent.style.zoom = '1.0001'; overlay.invalidate(); flush(); assert.equal(layer.hidden, true);
  parent.style.zoom = '1'; overlay.invalidate(); flush(); assert.equal(layer.hidden, false);
  editor.value = `\`${'x'.repeat(80)}\``; overlay.invalidate(); flush(); assert.equal(layer.hidden, true);
  define('CSS', undefined); editor.value = '`code`'; overlay.invalidate(); flush(); assert.equal(layer.hidden, true); define('CSS', {highlights: registry});
  editor.value = 'x'.repeat(16385); overlay.invalidate(); flush(); assert.equal(layer.hidden, true);
  editor.value = '`first`'; overlay.invalidate(); flush();
  const otherEditor = new NodeFake(), otherLayer = new NodeFake(); otherEditor.value = '`other`';
  const other = new ComposerOverlay(otherEditor as unknown as HTMLTextAreaElement, otherLayer as unknown as HTMLElement); other.invalidate(); flush();
  const marks = registry.get('composer-string'); assert.ok(marks); assert.equal(marks.size, 2);
  overlay.invalidate(); overlay.destroy(); assert.equal(frames.size, 0); assert.equal(editor.dataset.decorated, undefined); assert.equal(marks.size, 1); assert.equal(otherEditor.dataset.decorated, 'true');
  other.destroy(); assert.equal(registry.size, 0);
});
