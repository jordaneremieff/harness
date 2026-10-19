import assert from 'node:assert/strict';
import test from 'node:test';
import { createResizer, type ResizerOptions } from './resize.ts';
import { createPaneLayout, paneSplitGeometry, splitPane } from './pane-layout.ts';

class Handle {
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<EventListener>>();
  captures = new Set<number>();
  frames = new Map<number, FrameRequestCallback>();
  frameId = 0;
  tabIndex = -1;
  focused = false;
  style = {touchAction: 'pan-y'};
  rootClasses = new Set<string>();
  ownerDocument = {documentElement: {classList: {toggle: (name: string, enabled: boolean) => {if (enabled) this.rootClasses.add(name); else this.rootClasses.delete(name);}}}, defaultView: {
    requestAnimationFrame: (callback: FrameRequestCallback) => {const id = ++this.frameId; this.frames.set(id, callback); return id;},
    cancelAnimationFrame: (id: number) => {this.frames.delete(id);},
  }};
  setAttribute(key: string, value: string): void {this.attrs.set(key, value);}
  getAttribute(key: string): string | null {return this.attrs.get(key) ?? null;}
  removeAttribute(key: string): void {this.attrs.delete(key);}
  focus(): void {this.focused = true;}
  setPointerCapture(id: number): void {this.captures.add(id);}
  hasPointerCapture(id: number): boolean {return this.captures.has(id);}
  releasePointerCapture(id: number): void {this.captures.delete(id); this.emit('lostpointercapture', {pointerId: id});}
  addEventListener(name: string, callback: EventListener): void {
    const listeners = this.listeners.get(name) ?? new Set(); listeners.add(callback); this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, callback: EventListener): void {this.listeners.get(name)?.delete(callback);}
  emit(type: string, fields: Record<string, unknown> = {}): boolean {
    let prevented = false;
    const event = {type, isPrimary: true, button: 0, pointerId: 1, clientX: 0, clientY: 0, ...fields, preventDefault: () => {prevented = true;}};
    for (const callback of this.listeners.get(type) ?? []) callback(event as unknown as Event);
    return prevented;
  }
  frame(): void {const pending = [...this.frames.values()]; this.frames.clear(); for (const callback of pending) callback(0);}
}
function setup(options: Partial<Omit<ResizerOptions, 'handle' | 'read' | 'write' | 'onCommit'>> = {}, initial = 264) {
  const handle = new Handle(); const writes: number[] = []; const commits: number[] = []; let reads = 0; let saved = initial;
  const resizer = createResizer({handle: handle as unknown as HTMLElement, axis: 'x', min: 200, max: 480, defaultValue: 264,
    read: () => {reads++; return saved;}, write: value => {writes.push(value); saved = value;}, onCommit: value => {commits.push(value); saved = value;}, ...options});
  return {handle, writes, commits, resizer, get reads() {return reads;}, external(value: number) {saved = value;}};
}

test('split pointer and keyboard motion stop at both content minimums for fine and coarse dividers', () => {
  for (const divider of [5, 44]) for (const width of [640, 800, 1600]) {
    const layout = splitPane(createPaneLayout([{kind: 'primary'}, {kind: 'agent', identity: 'other'}]), 'pane-1', 'x', {width: width + divider, height: 640, divider});
    assert.equal(layout.root.kind, 'split'); if (layout.root.kind === 'split') layout.root.ratio = 80;
    const size = paneSplitGeometry(layout.root, {width: width + divider, height: 640, divider}); assert.ok(size);
    const f = setup({min: size.min, max: size.max, defaultValue: Math.round(width / 2)}, width * .8); f.handle.frame();
    f.handle.emit('pointerdown', {clientX: 0}); f.handle.emit('pointermove', {clientX: -10000}); f.handle.frame();
    assert.equal(f.resizer.value, size.min); f.handle.emit('pointerup', {clientX: -10000});
    f.handle.emit('pointerdown', {clientX: 0}); f.handle.emit('pointermove', {clientX: 10000}); f.handle.frame();
    assert.equal(f.resizer.value, size.max); f.handle.emit('pointerup', {clientX: 10000});
    f.handle.emit('keydown', {key: 'Home'}); f.handle.frame(); assert.equal(f.resizer.value, size.min);
    f.handle.emit('keydown', {key: 'End'}); f.handle.frame(); assert.equal(f.resizer.value, size.max);
    f.handle.emit('dblclick'); f.handle.frame(); assert.equal(f.resizer.value, Math.round(width / 2));
    for (const value of [...f.writes, ...f.commits]) {assert.ok(value >= 320); assert.ok(width - value >= 320);}
    f.resizer.destroy();
  }
});

test('separator exposes its axis, range, current value and label', () => {
  const f = setup({label: 'Resize sidebar'});
  assert.equal(f.handle.tabIndex, 0);
  assert.deepEqual(Object.fromEntries(f.handle.attrs), {'data-axis': 'x', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', 'aria-valuemin': '200', 'aria-valuemax': '480', 'aria-valuenow': '264'});
  assert.equal(f.handle.style.touchAction, 'none'); assert.deepEqual(f.writes, []);
  f.handle.frame(); assert.deepEqual(f.writes, [264]); assert.deepEqual(f.commits, []);
  const vertical = setup({axis: 'y'}); assert.equal(vertical.handle.getAttribute('aria-orientation'), 'horizontal');
});

test('captured pointer motion reads no layout, batches writes, clamps and commits once at release', () => {
  const f = setup(); f.handle.frame(); f.writes.length = 0;
  assert.equal(f.handle.emit('pointerdown', {clientX: 100}), true);
  assert.equal(f.handle.focused, true); assert.equal(f.handle.hasPointerCapture(1), true);
  assert.equal(f.handle.getAttribute('data-dragging'), 'true'); assert.equal(f.handle.rootClasses.has('resizing'), true);
  f.handle.emit('pointermove', {clientX: 120}); f.handle.emit('pointermove', {clientX: 145});
  assert.equal(f.handle.frames.size, 1); assert.deepEqual(f.writes, []); assert.equal(f.reads, 2);
  f.handle.frame(); assert.deepEqual(f.writes, [309]); assert.deepEqual(f.commits, []);
  f.handle.emit('pointermove', {clientX: 1000}); f.handle.frame(); assert.equal(f.resizer.value, 480);
  f.handle.emit('pointermove', {clientX: -1000}); f.handle.frame(); assert.equal(f.resizer.value, 200);
  f.handle.emit('pointerup', {clientX: 200});
  assert.deepEqual(f.commits, [364]); assert.equal(f.handle.hasPointerCapture(1), false);
  assert.equal(f.handle.getAttribute('data-dragging'), null); assert.equal(f.handle.rootClasses.has('resizing'), false);
  f.handle.emit('pointerup'); f.handle.emit('lostpointercapture'); assert.deepEqual(f.commits, [364]);
  f.handle.frame(); assert.equal(f.writes.at(-1), 364);
});

test('non-primary pointers, extra buttons and foreign pointer events do not resize', () => {
  const f = setup(); f.handle.frame(); f.writes.length = 0;
  f.handle.emit('pointerdown', {isPrimary: false}); f.handle.emit('pointerdown', {button: 2});
  assert.equal(f.handle.captures.size, 0);
  f.handle.emit('pointerdown', {clientX: 10});
  f.handle.emit('pointerdown', {pointerId: 2}); f.handle.emit('pointermove', {pointerId: 2, clientX: 500}); f.handle.emit('pointerup', {pointerId: 2});
  assert.equal(f.resizer.value, 264); assert.deepEqual(f.commits, []); assert.deepEqual(f.writes, []);
  f.handle.emit('pointercancel'); assert.deepEqual(f.commits, [264]);
});

test('cancel and lost capture commit the last dimension once, without interpreting cancel coordinates', () => {
  for (const end of ['pointercancel', 'lostpointercapture']) {
    const f = setup(); f.handle.frame();
    f.handle.emit('pointerdown', {clientX: 10}); f.handle.emit('pointermove', {clientX: 30});
    f.handle.emit(end, {clientX: 0}); f.handle.emit('pointercancel');
    assert.deepEqual(f.commits, [284]); f.handle.frame(); assert.equal(f.writes.at(-1), 284);
  }
});

test('horizontal keyboard commands use normal and Shift steps, endpoints and bounded commits', () => {
  const f = setup(); f.handle.frame();
  assert.equal(f.handle.emit('keydown', {key: 'ArrowRight'}), true);
  assert.equal(f.resizer.value, 280); assert.deepEqual(f.commits, [280]);
  f.handle.emit('keydown', {key: 'ArrowLeft', shiftKey: true}); assert.equal(f.resizer.value, 216);
  f.handle.emit('keydown', {key: 'Home'}); assert.equal(f.resizer.value, 200);
  f.handle.emit('keydown', {key: 'ArrowLeft'}); assert.deepEqual(f.commits, [280, 216, 200]);
  f.handle.emit('keydown', {key: 'End'}); assert.equal(f.resizer.value, 480);
  for (const key of ['ArrowUp', 'ArrowDown', 'Escape']) assert.equal(f.handle.emit('keydown', {key}), false);
  assert.equal(f.handle.emit('keydown', {key: 'ArrowLeft', ctrlKey: true}), false);
  f.handle.frame(); assert.deepEqual(f.writes, [264, 480]); assert.equal(f.handle.getAttribute('aria-valuenow'), '480');
});

test('Enter and Space reset the focused separator without repeated or modified activation', () => {
  for (const key of ['Enter', ' ']) {
    const f = setup({}, 320); f.handle.frame();
    assert.equal(f.handle.emit('keydown', {key}), true); f.handle.frame();
    assert.equal(f.resizer.value, 264); assert.deepEqual(f.commits, [264]);
    assert.equal(f.handle.getAttribute('aria-valuenow'), '264');
    assert.equal(f.handle.emit('keydown', {key, repeat: true}), true);
    for (const fields of [{shiftKey: true}, {altKey: true}, {ctrlKey: true}, {metaKey: true}, {isComposing: true}, {keyCode: 229}]) {
      assert.equal(f.handle.emit('keydown', {key, ...fields}), false);
    }
    assert.deepEqual(f.commits, [264]);
    f.resizer.destroy();
  }
});

test('top-edge panes grow upwards for pointers and keys, double-click resets', () => {
  const f = setup({axis: 'y', direction: -1, min: 96, max: 480, defaultValue: 144}, 144); f.handle.frame();
  f.handle.emit('pointerdown', {clientY: 200}); f.handle.emit('pointermove', {clientY: 160});
  f.handle.emit('pointerup', {clientY: 150}); assert.deepEqual(f.commits, [194]);
  f.handle.emit('keydown', {key: 'ArrowUp'}); assert.equal(f.resizer.value, 210);
  f.handle.emit('keydown', {key: 'ArrowDown', shiftKey: true}); assert.equal(f.resizer.value, 146);
  f.handle.emit('dblclick'); assert.equal(f.resizer.value, 144); assert.equal(f.commits.at(-1), 144);
  f.handle.frame(); assert.equal(f.writes.at(-1), 144);
});

test('external values clamp, refresh waits for drag completion and teardown cancels all work', () => {
  const f = setup({}, NaN); assert.equal(f.resizer.value, 264); f.handle.frame();
  f.external(999); f.resizer.refresh(); f.handle.frame(); assert.equal(f.resizer.value, 480);
  f.handle.emit('pointerdown', {clientX: 0}); f.external(200); f.resizer.refresh();
  assert.equal(f.resizer.value, 480); assert.equal(f.reads, 3);
  f.handle.emit('keydown', {key: 'Home'}); f.handle.emit('dblclick'); assert.deepEqual(f.commits, []);
  f.handle.emit('pointermove', {clientX: -30}); f.resizer.destroy(); f.resizer.destroy();
  assert.equal(f.handle.frames.size, 0); assert.equal(f.handle.captures.size, 0);
  assert.equal(f.handle.style.touchAction, 'pan-y'); assert.equal(f.handle.getAttribute('data-dragging'), null); assert.equal(f.handle.rootClasses.has('resizing'), false);
  f.handle.emit('keydown', {key: 'Home'}); f.handle.emit('pointerup'); f.handle.emit('dblclick'); f.resizer.refresh(); f.handle.frame();
  assert.deepEqual(f.commits, []); assert.deepEqual(f.writes, [264, 480]);
});

test('automatic panes avoid an initial write and reset cancels a queued manual size', () => {
  let resets = 0;
  const f = setup({applyInitial: false, onReset: () => {resets++; f.external(240);}});
  f.handle.frame(); assert.deepEqual(f.writes, []);
  f.external(300); f.handle.emit('keydown', {key: 'ArrowRight'});
  assert.deepEqual(f.commits, [316]); assert.equal(f.handle.frames.size, 1);
  f.handle.emit('dblclick'); f.handle.frame();
  assert.equal(resets, 1); assert.deepEqual(f.writes, []); assert.equal(f.resizer.value, 240);
  assert.equal(f.handle.getAttribute('aria-valuenow'), '240');
  f.handle.emit('keydown', {key: 'ArrowRight'}); f.handle.frame(); assert.deepEqual(f.writes, [256]);
});

test('automatic reset measures the callback frame without a manual write or commit', () => {
  for (const activation of ['Enter', ' ', 'dblclick']) {
    let resets = 0;
    const f = setup({applyInitial: false, onReset: () => {
      resets++; f.handle.ownerDocument.defaultView.requestAnimationFrame(() => f.external(240));
    }}, 320);
    if (activation === 'dblclick') f.handle.emit('dblclick'); else f.handle.emit('keydown', {key: activation});
    assert.equal(resets, 1); assert.equal(f.resizer.value, 320);
    f.handle.frame();
    assert.equal(f.resizer.value, 240); assert.equal(f.handle.getAttribute('aria-valuenow'), '240');
    assert.deepEqual(f.writes, []); assert.deepEqual(f.commits, []);
    f.handle.emit('keydown', {key: 'ArrowRight'}); f.handle.frame();
    assert.equal(f.resizer.value, 256); assert.deepEqual(f.writes, [256]);
    f.resizer.destroy();
  }
});

test('measured size describes unclamped initial and reset geometry without inferring an automatic mode', () => {
  const f = setup({applyInitial: false, min: 40, max: 640, defaultValue: 144, onReset: () => {
    f.handle.ownerDocument.defaultView.requestAnimationFrame(() => f.external(24));
  }}, 24);
  assert.equal(f.resizer.value, 40); assert.equal(f.handle.getAttribute('aria-valuenow'), '40');
  assert.equal(f.handle.getAttribute('aria-valuetext'), '24 pixels');
  f.handle.emit('keydown', {key: 'ArrowRight'}); f.handle.frame();
  assert.equal(f.handle.getAttribute('aria-valuenow'), '56'); assert.equal(f.handle.getAttribute('aria-valuetext'), null);
  f.handle.emit('keydown', {key: 'Enter'}); f.handle.frame();
  assert.equal(f.resizer.value, 40); assert.equal(f.handle.getAttribute('aria-valuetext'), '24 pixels');
  f.handle.emit('pointerdown'); assert.equal(f.handle.getAttribute('aria-valuetext'), null);
  f.resizer.destroy();
  const generic = setup({applyInitial: false, onReset: () => generic.external(240)}, 264);
  generic.handle.emit('dblclick'); generic.handle.frame();
  assert.equal(generic.handle.getAttribute('aria-valuetext'), '240 pixels'); generic.resizer.destroy();
  const unknown = setup({applyInitial: false}, NaN);
  assert.equal(unknown.handle.getAttribute('aria-valuetext'), null); unknown.resizer.destroy();
});

test('new input, replacement reset and destroy retire an outstanding reset measurement', () => {
  for (const action of ['arrow', 'pointer', 'reset', 'destroy']) {
    let resets = 0;
    const f = setup({applyInitial: false, onReset: () => {resets++;}}, 320);
    f.handle.emit('keydown', {key: 'Enter'}); assert.equal(f.handle.frames.size, 1);
    if (action === 'arrow') f.handle.emit('keydown', {key: 'ArrowRight'});
    else if (action === 'pointer') f.handle.emit('pointerdown');
    else if (action === 'reset') f.handle.emit('dblclick');
    else f.resizer.destroy();
    assert.equal(f.handle.frames.size, action === 'arrow' || action === 'reset' ? 1 : 0);
    f.external(240); f.handle.frame();
    assert.equal(f.resizer.value, action === 'reset' ? 240 : action === 'arrow' ? 336 : 320);
    assert.equal(resets, action === 'reset' ? 2 : 1);
    f.resizer.destroy();
  }
});

test('the global resize class remains until all handles release their captures', () => {
  const f = setup(); const second = new Handle(); second.ownerDocument = f.handle.ownerDocument;
  const resizer = createResizer({handle: second as unknown as HTMLElement, axis: 'y', min: 40, max: 640, defaultValue: 144,
    read: () => 144, write: () => {}, onCommit: () => {}});
  f.handle.emit('pointerdown'); second.emit('pointerdown', {pointerId: 2});
  f.handle.emit('pointercancel'); assert.equal(f.handle.rootClasses.has('resizing'), true);
  resizer.destroy(); assert.equal(f.handle.rootClasses.has('resizing'), false);
});

test('invalid bounds reject and fractional external dimensions round to integer pixels', () => {
  for (const options of [{min: 500}, {max: Infinity}, {defaultValue: NaN}, {min: 200.5}]) assert.throws(() => setup(options), RangeError);
  const f = setup({}, 270.6); f.handle.frame(); assert.deepEqual(f.writes, [271]);
});

test('a press that stays under the drag threshold changes and commits nothing, and a longer one follows the pointer from its origin', () => {
  const f = setup({axis: 'y', direction: -1, dragThreshold: 4}); f.handle.frame(); f.writes.length = 0;
  f.handle.emit('pointerdown', {clientY: 300}); f.handle.emit('pointerup', {clientY: 300});
  assert.deepEqual(f.commits, []); assert.deepEqual(f.writes, []); assert.equal(f.handle.rootClasses.has('resizing'), false);
  f.handle.emit('pointerdown', {clientY: 300}); f.handle.emit('pointermove', {clientY: 297}); f.handle.frame();
  f.handle.emit('pointerup', {clientY: 297});
  assert.deepEqual(f.commits, []); assert.deepEqual(f.writes, []); assert.equal(f.resizer.value, 264);
  f.handle.emit('pointerdown', {clientY: 300}); f.handle.emit('pointermove', {clientY: 296}); f.handle.frame();
  assert.deepEqual(f.writes, [268]); f.handle.emit('pointermove', {clientY: 301}); f.handle.emit('pointermove', {clientY: 230}); f.handle.frame();
  f.handle.emit('pointerup', {clientY: 230}); assert.deepEqual(f.commits, [334]);
  f.handle.emit('pointerdown', {clientY: 300}); f.handle.emit('pointermove', {clientY: 302}); f.handle.emit('pointercancel');
  assert.deepEqual(f.commits, [334], 'a cancelled press that never moved far enough commits nothing');
});
