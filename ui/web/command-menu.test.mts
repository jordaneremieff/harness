import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CommandMenu } from './command-menu.ts';
import type { CommandInventory } from './command-menu-state.ts';
type FakeEvent = {key: string; defaultPrevented: boolean; isComposing: boolean; keyCode: number; shiftKey: boolean; preventDefault(): void};
class FakeNode {
  id = ''; tag = ''; className = ''; value = ''; disabled = false; hidden = true;
  selectionStart = 0; selectionEnd = 0; offsetTop = 0; offsetHeight = 40; clientHeight = 80; scrollTop = 0;
  children: FakeNode[] = []; attrs = new Map<string, string>(); writes = 0;
  rect: () => {top: number; bottom: number} = () => ({top: 0, bottom: 0});
  getBoundingClientRect(): {top: number; bottom: number} { return this.rect(); }
  private text = ''; private listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; this.writes++; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  append(...nodes: FakeNode[]): void { this.children.push(...nodes); this.children.forEach((node, index) => {node.offsetTop = index * 40;}); }
  replaceChildren(...nodes: FakeNode[]): void { this.text = ''; this.children = []; this.append(...nodes); }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
  addEventListener(name: string, listener: (event: FakeEvent) => void): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  fire(name: string, extra: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {key: '', defaultPrevented: false, isComposing: false, keyCode: 0, shiftKey: false, preventDefault() {this.defaultPrevented = true;}, ...extra};
    for (const listener of this.listeners.get(name) ?? []) listener(event); return event;
  }
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function fixture() {
  const editor = new FakeNode(); const menu = new FakeNode(); menu.id = 'primary-command-menu'; const announcements = new FakeNode(); const changed: string[] = [];
  let inventory: CommandInventory = {state: 'ready', items: ['compact', 'model', 'thinking'].map(name => ({name, description: `${name} description`, source: 'app'}))};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => {const node = new FakeNode(); node.tag = tag; return node;}, getElementById: () => announcements}});
  const controller = new CommandMenu(editor as unknown as HTMLTextAreaElement, menu as unknown as HTMLElement, () => inventory, text => {changed.push(text); controller.update();});
  const text = (value: string, caret = value.length, end = caret) => {editor.value = value; editor.setSelectionRange(caret, end); editor.fire('focus'); controller.update();};
  const key = (value: string, extra: Partial<FakeEvent> = {}) => {
    const event = editor.fire('none', {key: value, ...extra}); const handled = controller.key(event as unknown as KeyboardEvent); return {event, handled};
  };
  return {editor, menu, announcements, changed, controller, text, key, inventory: (value: CommandInventory) => {inventory = value; controller.update();}};
}
test('rows expose listbox semantics, stable name IDs, descriptions, sources, and safe name marks', () => {
  const f = fixture(); f.text('/mo');
  assert.equal(f.menu.attrs.get('role'), 'listbox'); assert.equal(f.menu.attrs.get('aria-label'), 'Commands');
  assert.equal(f.editor.attrs.has('role'), false); assert.equal(f.editor.attrs.get('aria-autocomplete'), 'list');
  const row = f.menu.children[0]; assert.ok(row); assert.equal(row.className, 'command-option');
  assert.equal(row.attrs.get('role'), 'option'); assert.equal(row.attrs.get('aria-selected'), 'true');
  assert.equal(f.editor.attrs.get('aria-activedescendant'), row.id);
  assert.deepEqual(row.children.map(child => child.className), ['command-name', 'command-desc', 'command-source']);
  assert.deepEqual(row.children[0]?.children.filter(child => child.tag === 'mark').map(child => child.textContent), ['m', 'o']);
  assert.equal(row.attrs.get('aria-describedby'), `${row.id}-desc ${row.id}-source`);
  const id = row.id; f.controller.update(); assert.equal(f.menu.children[0]?.id, id);
  f.inventory({state: 'ready', items: [{name: '<script>', description: '<img src=x>', source: '<unsafe>'}]}); f.text('/<');
  assert.equal(f.menu.children[0]?.attrs.get('aria-label'), '/<script>');
  assert.equal(f.menu.children[0]?.children[1]?.textContent, '<img src=x>');
  assert.equal(f.menu.children[0]?.children[0]?.children.some(node => node.tag === 'script'), false);
});
test('keyboard selection scrolls only the list and leaves textarea focus ownership intact', () => {
  const f = fixture(); f.text('/'); f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown');
  assert.equal(f.menu.children[2]?.attrs.get('aria-selected'), 'true'); assert.equal(f.menu.scrollTop, 80);
  assert.equal(f.editor.attrs.get('aria-activedescendant'), f.menu.children[2]?.id);
  assert.equal(f.changed.length, 0); f.key('ArrowUp'); assert.equal(f.menu.children[1]?.attrs.get('aria-selected'), 'true');
});
test('pointerdown preserves focus, hover never changes keyboard selection, and click only inserts', () => {
  const f = fixture(); f.text('/'); const row = f.menu.children[1]; assert.ok(row);
  row.fire('pointerenter'); assert.equal(f.menu.children[0]?.attrs.get('aria-selected'), 'true');
  assert.equal(row.fire('pointerdown').defaultPrevented, true); f.controller.update(); assert.equal(f.menu.children[1], row); row.fire('click');
  assert.deepEqual(f.changed, ['/model ']); assert.equal(f.menu.hidden, true); assert.equal(f.editor.selectionStart, 7);
  assert.equal(f.editor.attrs.has('aria-activedescendant'), false);
});
test('exact-name Enter accepts and a subsequent Enter returns to normal composer handling', () => {
  const f = fixture(); f.text('/model'); assert.equal(f.key('Enter').handled, true);
  assert.deepEqual(f.changed, ['/model ']); assert.equal(f.key('Enter').handled, false);
  f.text('/mo keep\nthese', 3); f.key('Tab'); assert.equal(f.editor.value, '/model keep\nthese');
});
test('loading and empty states are not options and consume Enter without edits', () => {
  const f = fixture(); f.inventory({state: 'loading', items: []}); f.text('/');
  assert.equal(f.menu.children[0]?.textContent, 'Loading commands…'); assert.equal(f.menu.children[0]?.attrs.has('role'), false);
  assert.equal(f.key('Enter').handled, true); assert.equal(f.changed.length, 0);
  f.inventory({state: 'ready', items: []}); f.text('/nothing');
  assert.equal(f.menu.children[0]?.textContent, 'No commands match /nothing · Esc to keep typing'); assert.equal(f.key('Enter').event.defaultPrevented, true);
  f.inventory({state: 'unavailable', items: []}); assert.equal(f.menu.hidden, true); assert.equal(f.editor.attrs.has('aria-activedescendant'), false);
});
test('Escape persists across inventory updates; ShiftEnter, blur and composition clear active references', () => {
  const f = fixture(); f.text('/mo'); f.key('Escape'); f.controller.update(); assert.equal(f.menu.hidden, true);
  f.editor.fire('blur'); f.editor.fire('focus'); assert.equal(f.menu.hidden, true);
  f.text('/mod'); assert.equal(f.menu.hidden, false);
  const enter = f.key('Enter', {shiftKey: true}); assert.equal(enter.handled, false); assert.equal(enter.event.defaultPrevented, false); assert.equal(f.menu.hidden, true);
  f.text('/mo'); f.editor.fire('compositionstart'); assert.equal(f.menu.hidden, true);
  assert.equal(f.key('Enter').handled, true); assert.equal(f.changed.length, 0);
  f.editor.fire('compositionend'); assert.equal(f.menu.hidden, false); f.editor.fire('blur'); assert.equal(f.editor.attrs.has('aria-activedescendant'), false);
});
test('each settled query announces at most once and never announces each arrow or inventory paint', () => {
  const f = fixture(); f.inventory({state: 'loading', items: []}); f.text('/'); assert.equal(f.announcements.writes, 0);
  f.inventory({state: 'ready', items: ['a', 'b'].map(name => ({name, description: '', source: 'app'}))});
  assert.equal(f.announcements.textContent, '2 commands'); const writes = f.announcements.writes;
  f.key('ArrowDown'); f.controller.update(); f.key('Escape'); f.controller.update(); assert.equal(f.announcements.writes, writes);
  f.text('/a'); assert.equal(f.announcements.textContent, '1 command for /a');
});
test('incomplete inventories explain their limit instead of claiming no command matches', () => {
  const f = fixture(); f.inventory({state: 'ready', items: [], incomplete: true}); f.text('/missing');
  assert.equal(f.menu.children[0]?.textContent, 'Command list is incomplete · Open Commands (⌘K) to discover more');
  assert.doesNotMatch(f.menu.children[0]?.textContent ?? '', /No commands match/);
  assert.equal(f.menu.children[0]?.attrs.has('role'), false); assert.equal(f.key('Enter').handled, true);
  f.inventory({state: 'ready', items: []}); assert.equal(f.menu.children[0]?.textContent, 'No commands match /missing · Esc to keep typing');
});
test('a shorter list after a viewport resize scrolls the active row back above the hint', () => {
  const f = fixture(); f.menu.clientHeight = 160; f.text('/'); f.key('ArrowDown'); f.key('ArrowDown'); const active = f.menu.children[2]; const footer = f.menu.children.at(-1); assert.ok(active); assert.ok(footer);
  assert.equal(f.menu.scrollTop, 0); footer.offsetHeight = 28; f.menu.clientHeight = 100; f.controller.keepActiveVisible();
  assert.ok(f.menu.scrollTop > 0); assert.ok(active.offsetTop + active.offsetHeight <= f.menu.scrollTop + f.menu.clientHeight - footer.offsetHeight);
  f.key('Escape'); const scrolled = f.menu.scrollTop; f.controller.keepActiveVisible(); assert.equal(f.menu.scrollTop, scrolled);
});
test('rendered list padding cannot leave the active row partly behind the sticky hint', () => {
  const f = fixture(); f.menu.clientHeight = 100; f.text('/'); f.key('ArrowDown'); f.key('ArrowDown');
  const active = f.menu.children[2]; const hint = f.menu.children.at(-1); assert.ok(active); assert.ok(hint); hint.offsetHeight = 28;
  active.rect = () => ({top: 4 + active.offsetTop - f.menu.scrollTop, bottom: 4 + active.offsetTop + active.offsetHeight - f.menu.scrollTop});
  hint.rect = () => ({top: f.menu.clientHeight - hint.offsetHeight, bottom: f.menu.clientHeight});
  f.controller.keepActiveVisible();
  assert.ok(active.getBoundingClientRect().bottom <= hint.getBoundingClientRect().top, `${active.getBoundingClientRect().bottom} > ${hint.getBoundingClientRect().top}`);
});
test('each open menu has a non-option key hint and active scrolling reserves its measured height', () => {
  const f = fixture(); f.text('/'); const hint = f.menu.children.at(-1); assert.ok(hint);
  assert.equal(hint.className, 'command-hint'); assert.equal(hint.attrs.get('aria-hidden'), 'true'); assert.equal(hint.attrs.has('role'), false);
  assert.equal(hint.textContent, '↑↓ to choose · Enter or Tab to insert · Esc to close');
  f.key('ArrowDown'); f.key('ArrowDown'); const active = f.menu.children[2]; const footer = f.menu.children.at(-1); assert.ok(active); assert.ok(footer);
  assert.ok(active.offsetTop + active.offsetHeight <= f.menu.scrollTop + f.menu.clientHeight - footer.offsetHeight);
  f.key('Escape'); assert.equal(f.menu.children.length, 0); assert.equal(f.menu.hidden, true);
  f.inventory({state: 'loading', items: []}); f.text('/pending'); assert.equal(f.menu.children.at(-1)?.className, 'command-hint');
});
