import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {WorkbenchStatus} from './workbench-status.ts';

class StatusNode extends EventTarget {
  textContent = ''; title = ''; hidden = false; dataset: Record<string, string> = {};
  height = 26; measurements = 0;
  readonly declarations = new Map<string, {value: string; priority: string}>();
  readonly attributes = new Map<string, string>();
  readonly style = {
    getPropertyValue: (name: string) => this.declarations.get(name)?.value ?? '',
    getPropertyPriority: (name: string) => this.declarations.get(name)?.priority ?? '',
    setProperty: (name: string, value: string, priority = '') => {this.declarations.set(name, {value, priority});},
    removeProperty: (name: string) => {const old = this.style.getPropertyValue(name); this.declarations.delete(name); return old;},
  };
  setAttribute(name: string, value: string): void {this.attributes.set(name, value);}
  getBoundingClientRect(): {height: number} {this.measurements++; return {height: this.height};}
}
function fixture(t: TestContext) {
  const document = new EventTarget(), window = new EventTarget(), frames = new Map<number, FrameRequestCallback>(); let serial = 0;
  const values = {document, window, requestAnimationFrame: (callback: FrameRequestCallback) => {const id = ++serial; frames.set(id, callback); return id;}, cancelAnimationFrame: (id: number) => {frames.delete(id);}};
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name); Reflect.set(globalThis, name, value);
    t.after(() => {if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name);});
  }
  const nodes = new Map<string, StatusNode>();
  const get = (id: string) => {let node = nodes.get(id); if (!node) {node = new StatusNode(); nodes.set(id, node);} return node as unknown as HTMLElement;};
  const status = new WorkbenchStatus(get), footer = nodes.get('workbench-status'); assert.ok(footer);
  const fire = (target: EventTarget, name: string, pointerId = 7) => target.dispatchEvent(Object.assign(new Event(name), {pointerId}));
  const press = (pointerId = 7) => status.holdGeometry({pointerId, button: 0, isPrimary: true});
  const flush = () => {for (const [id, callback] of [...frames]) {frames.delete(id); callback(0);}};
  return {status, footer, document, window, nodes, frames, fire, press, flush};
}

test('geometry hold restores exact values and priorities without replacing unrelated inline styles', t => {
  const {status, footer, document, frames, fire, press} = fixture(t);
  footer.style.setProperty('height', '7vh', 'important'); footer.style.setProperty('min-height', '12px');
  footer.style.setProperty('overflow-x', 'auto', 'important'); footer.style.setProperty('overflow-y', 'visible');
  const before = new Map(footer.declarations); press();
  for (const name of ['height', 'min-height', 'max-height']) assert.deepEqual(footer.declarations.get(name), {value: '26px', priority: 'important'});
  for (const name of ['overflow-x', 'overflow-y']) assert.deepEqual(footer.declarations.get(name), {value: 'hidden', priority: 'important'});
  status.update('primary', 'Focused conversation', 'Busy', 'exact-primary');
  assert.equal(footer.dataset.pane, 'primary'); assert.equal(footer.style.getPropertyValue('height'), '26px');
  footer.style.setProperty('color', 'blue', 'important'); before.set('color', {value: 'blue', priority: 'important'});
  fire(document, 'pointerup'); assert.equal(frames.size, 1); assert.equal(footer.style.getPropertyValue('height'), '26px');
  fire(document, 'click'); assert.equal(frames.size, 0); assert.deepEqual(footer.declarations, before);
  fire(document, 'click'); assert.deepEqual(footer.declarations, before);
});

test('duplicate press does not remeasure changed facts and replacement restores before its new measurement', t => {
  const {status, footer, document, fire, press} = fixture(t);
  press(); footer.height = 93; status.update('agent', 'Another long name', 'An activity'); press();
  assert.equal(footer.measurements, 1); assert.equal(footer.style.getPropertyValue('height'), '26px');
  press(8); assert.equal(footer.measurements, 2); assert.equal(footer.style.getPropertyValue('height'), '93px');
  fire(document, 'click', 7); assert.equal(footer.style.getPropertyValue('height'), '93px');
  fire(document, 'click', 8); assert.equal(footer.declarations.size, 0);
});

test('old frame cannot release a later press with the same pointer identity', t => {
  const {footer, document, frames, fire, press} = fixture(t);
  press(); fire(document, 'pointerup'); const stale = [...frames.values()][0]; assert.ok(stale);
  footer.height = 51; press(); assert.equal(frames.size, 0); assert.equal(footer.style.getPropertyValue('height'), '51px');
  stale(0); assert.equal(footer.style.getPropertyValue('height'), '51px');
  fire(document, 'click'); assert.equal(footer.declarations.size, 0);
});

test('no-click pointerup releases in one frame and ignores other pointers or duplicate release events', t => {
  const {footer, document, frames, fire, press, flush} = fixture(t);
  press(); fire(document, 'pointerup', 99); assert.equal(frames.size, 0);
  fire(document, 'pointerup'); fire(document, 'pointerup'); assert.equal(frames.size, 1);
  assert.equal(footer.style.getPropertyValue('height'), '26px'); flush();
  assert.equal(frames.size, 0); assert.equal(footer.declarations.size, 0);
  fire(document, 'pointerup'); assert.equal(frames.size, 0);
});

test('pointer cancellation matches the active press and never leaves a replay callback', t => {
  const {footer, document, frames, fire, press, flush} = fixture(t);
  let actions = 0; document.addEventListener('click', () => {actions++;});
  press(); fire(document, 'pointercancel', 99); assert.equal(footer.style.getPropertyValue('height'), '26px');
  fire(document, 'pointerup'); fire(document, 'pointercancel'); fire(document, 'pointercancel'); flush();
  assert.equal(footer.declarations.size, 0); assert.equal(frames.size, 0); assert.equal(actions, 0);
});

test('release away restores geometry without activating the pressed control', t => {
  const {footer, document, frames, fire, press, flush} = fixture(t);
  const control = new EventTarget(); let actions = 0;
  control.addEventListener('click', () => {actions++;});
  press(); fire(document, 'pointerup'); fire(document, 'click'); flush();
  assert.equal(footer.declarations.size, 0); assert.equal(frames.size, 0); assert.equal(actions, 0);
});

test('window blur and footer focus release geometry and invalidate stale frame cleanup', t => {
  const {footer, document, window, frames, fire, press} = fixture(t);
  press(); fire(document, 'pointerup'); const stale = [...frames.values()][0]; assert.ok(stale);
  fire(window, 'blur'); assert.equal(footer.declarations.size, 0); assert.equal(frames.size, 0);
  footer.height = 48; press(8); stale(0); assert.equal(footer.style.getPropertyValue('height'), '48px');
  fire(footer, 'focusin'); assert.equal(footer.declarations.size, 0); assert.equal(frames.size, 0);
});

test('keyboard facts, secondary buttons and non-primary pointers do not acquire geometry', t => {
  const {status, footer, nodes} = fixture(t);
  status.update('file', 'folder/file.ts', '', 'file.ts');
  status.holdGeometry({pointerId: 7, button: 2, isPrimary: true});
  status.holdGeometry({pointerId: 7, button: 0, isPrimary: false});
  assert.equal(footer.measurements, 0); assert.equal(footer.declarations.size, 0);
  const scope = nodes.get('workbench-scope'), primary = nodes.get('workbench-status-primary'); assert.ok(scope); assert.ok(primary);
  assert.equal(scope.textContent, 'folder/file.ts');
  assert.equal(primary.hidden, true);
});

test('status disclosures and tooltips retain the current exact name and activity', t => {
  const {status,nodes} = fixture(t);status.update('agent','Exact agent','Not connected','exact-agent');
  for(const owner of ['primary','agent']) assert.equal(nodes.get(`${owner}-status-summary`)?.textContent,'Exact agent · Not connected');
  assert.equal(nodes.get('workbench-scope')?.textContent,'Exact agent');assert.equal(nodes.get('workbench-scope')?.title,'Exact agent\nexact-agent');assert.equal(nodes.get('workbench-activity')?.textContent,'Not connected');assert.equal(nodes.get('workbench-activity')?.title,'Not connected');assert.equal(nodes.get('workbench-activity')?.attributes.get('aria-label'),'Not connected');
  status.update('primary','Primary','Ready');assert.equal(nodes.get('primary-status-summary')?.textContent,'Primary · Ready');
});
test('saved session scope hides both usage groups and restores the next conversation group', t => {
  const {status, footer, nodes} = fixture(t);
  status.update('primary', 'Primary', 'Ready');
  status.update('session', 'Retained session', 'Live in terminal', '/fixture/retained.jsonl');
  assert.equal(footer.dataset.pane, 'session');assert.equal(nodes.get('workbench-scope')?.textContent, 'Retained session');
  assert.equal(nodes.get('workbench-activity')?.textContent, 'Live in terminal');
  for (const owner of ['primary', 'agent']) assert.equal(nodes.get(`workbench-status-${owner}`)?.hidden, true);
  status.update('agent', 'Recipient', 'Ready');
  assert.equal(nodes.get('workbench-status-primary')?.hidden, true);assert.equal(nodes.get('workbench-status-agent')?.hidden, false);
  status.update('primary', 'Primary', 'Ready');
  assert.equal(nodes.get('workbench-status-primary')?.hidden, false);assert.equal(nodes.get('workbench-status-agent')?.hidden, true);
});

test('hidden or invalid footer geometry creates no hold or cleanup frame', t => {
  const {footer, document, frames, fire, press} = fixture(t);
  for (const height of [0, -1, NaN, Infinity]) {footer.height = height; press(); assert.equal(footer.declarations.size, 0);}
  fire(document, 'pointerup'); assert.equal(frames.size, 0);
});
