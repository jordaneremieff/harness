import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, {type TestContext} from 'node:test';
import { Modal } from './modal.ts';
import { UI_ITERATION, identityLabel, identityText, type UiIdentity } from '../shared/version.ts';
import { VersionStatus } from './version-status.ts';
class Button {
  type = ''; tabIndex = -1; className = ''; textContent = ''; title = '';
  attributes = new Map<string, string>(); clicks: (() => void)[] = [];
  setAttribute(name: string, value: string) {this.attributes.set(name, value);}
  addEventListener(name: string, callback: () => void) {assert.equal(name, 'click'); this.clicks.push(callback);}
}
const identity: UiIdentity = {iteration: UI_ITERATION, git: {commit: 'a'.repeat(40), shortCommit: 'aaaaaaa', branch: 'feature/ui', modified: true,
  committedAt: '2026-10-12T00:00:00.000Z'}, assets: {digest: 'b'.repeat(64), builtAt: '2026-10-12T01:00:00.000Z'}, startedAt: '2026-10-12T02:00:00.000Z', pi: '1.1.0', durable: '1.1.0'};
test('one stable button shows this served iteration and copies the full tooltip identity', () => {
  const node = new Button(), copies: string[] = [];
  const status = new VersionStatus(() => {throw new Error('No copy fallback on success');}, node as unknown as HTMLButtonElement, identity, async value => {copies.push(value); return true;});
  assert.equal(status.identity, identity); assert.equal(node.type, 'button'); assert.equal(node.tabIndex, 0);
  assert.equal(node.attributes.get('aria-label'), 'Copy UI version identity');
  assert.equal(node.textContent, identityLabel(identity)); assert.equal(node.title, identityText(identity));
  assert.equal(node.clicks.length, 1); const click = node.clicks[0]; assert.ok(click); click();
  assert.deepEqual(copies, [identityText(identity)]); assert.equal(node.textContent, identityLabel(identity));
});
test('non-Git display and copy contain only the declared iteration', () => {
  const node = new Button(), copies: string[] = [];
  new VersionStatus(() => {throw new Error('No copy fallback on success');}, node as unknown as HTMLButtonElement, {iteration: UI_ITERATION}, async value => {copies.push(value); return true;});
  assert.equal(node.clicks.length, 1); const click = node.clicks[0]; assert.ok(click); click(); assert.equal(node.textContent, `ui ${UI_ITERATION}`); assert.equal(node.title, node.textContent);
  assert.deepEqual(copies, [node.textContent]);
});
test('identity is a final footer control outside conversation groups, with theme-owned quiet ink', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const footer = /<footer id="workbench-status"[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1]; assert.ok(footer);
  assert.equal((html.match(/id="workbench-version"/g) ?? []).length, 1);
  assert.match(footer, /<button id="workbench-version"[^>]*><\/button>\s*$/);
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  const rule = /\.workbench-version\s*\{([^}]*)\}/.exec(css)?.[1]; assert.ok(rule);
  assert.match(rule, /margin-left: auto/); assert.match(rule, /color: var\(--muted\)/); assert.match(rule, /font-family: var\(--mono\)/);
});

function copyHost(context: TestContext, refused: boolean) {
  let active: CopyNode | undefined; const copied: string[] = [];
  class CopyNode extends EventTarget {
    textContent = ''; className = ''; type = ''; tabIndex = 0; open = false; isConnected = true;
    value = ''; readOnly = false; selectionStart = 0; selectionEnd = 0; dataset: Record<string, string> = {};
    children: CopyNode[] = []; attributes = new Map<string, string>();
    append(node: CopyNode) {this.children.push(node);}
    replaceChildren() {this.children = []; this.textContent = '';}
    setAttribute(name: string, value: string) {this.attributes.set(name, value);}
    showModal() {this.open = true;}
    close() {this.open = false; this.dispatchEvent(new Event('close'));}
    focus() {active = this;}
    select() {this.selectionStart = 0; this.selectionEnd = this.value.length;}
  }
  const nodes = new Map(['modal', 'modal-body', 'modal-close', 'modal-title', 'modal-error', 'announcements', 'workbench-version'].map(name => [name, new CopyNode()]));
  const trigger = nodes.get('workbench-version'), body = nodes.get('modal-body'), dialog = nodes.get('modal');
  assert.ok(trigger); assert.ok(body); assert.ok(dialog); active = trigger;
  const document = {get activeElement() {return active;}, createElement: () => new CopyNode(), getElementById: (id: string) => nodes.get(id)};
  const navigator = {clipboard: {writeText: async (text: string) => {copied.push(text); if (refused) throw new Error('Clipboard refused');}}};
  for (const [name, value] of [['document', document], ['navigator', navigator], ['HTMLElement', CopyNode]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, value});
    context.after(() => {if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);});
  }
  return {trigger, body, dialog, nodes, copied, get active() {return active;}};
}

test('clipboard refusal opens the existing dialog with full selected identity and restores focus on dismissal', async context => {
  for (const dismissal of ['escape', 'close']) await context.test(dismissal, async child => {
    const host = copyHost(child, true), modal = new Modal(); let opened = 0;
    new VersionStatus(() => {opened++; return modal.open('Copy UI version identity');}, host.trigger as unknown as HTMLButtonElement, identity);
    assert.equal(modal.openNow, false); assert.equal(host.body.children.length, 0);
    host.trigger.dispatchEvent(new Event('click')); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(host.copied, [identityText(identity)]); assert.equal(opened, 1); assert.equal(modal.openNow, true);
    assert.equal(host.body.children.length, 1); const field = host.body.children[0]; assert.ok(field);
    assert.equal(field.value, identityText(identity)); assert.equal(field.readOnly, true);
    assert.equal(field.attributes.get('aria-label'), 'Select and copy text');
    assert.equal(host.active, field); assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, field.value.length);
    assert.equal(host.nodes.get('announcements')?.textContent, 'Copy failed. Select and copy the text.');
    assert.equal(host.trigger.tabIndex, 0); assert.equal(host.trigger.textContent, identityLabel(identity));
    assert.equal(host.trigger.children.length, 0);
    if (dismissal === 'escape') {const cancel = new Event('cancel', {cancelable: true}); host.dialog.dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true);}
    else {const close = host.nodes.get('modal-close'); assert.ok(close); close.dispatchEvent(new Event('click'));}
    assert.equal(modal.openNow, false); assert.equal(host.active, host.trigger);
  });
});
test('normal clipboard copy does not open a fallback or add a second footer tab stop', async context => {
  const host = copyHost(context, false), modal = new Modal(); let opened = 0;
  new VersionStatus(() => {opened++; return modal.open('Copy UI version identity');}, host.trigger as unknown as HTMLButtonElement, identity);
  host.trigger.dispatchEvent(new Event('click')); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(host.copied, [identityText(identity)]); assert.equal(opened, 0); assert.equal(modal.openNow, false);
  assert.equal(host.body.children.length, 0); assert.equal(host.trigger.children.length, 0);
  assert.equal(host.trigger.tabIndex, 0); assert.equal(host.active, host.trigger);
  assert.equal(host.nodes.get('announcements')?.textContent, 'Copied');
});
