import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
  const status = new VersionStatus(node as unknown as HTMLButtonElement, identity, async value => {copies.push(value); return true;});
  assert.equal(status.identity, identity); assert.equal(node.type, 'button'); assert.equal(node.tabIndex, 0);
  assert.equal(node.attributes.get('aria-label'), 'Copy UI version identity');
  assert.equal(node.textContent, identityLabel(identity)); assert.equal(node.title, identityText(identity));
  assert.equal(node.clicks.length, 1); const click = node.clicks[0]; assert.ok(click); click();
  assert.deepEqual(copies, [identityText(identity)]); assert.equal(node.textContent, identityLabel(identity));
});
test('non-Git display and copy contain only the declared iteration', () => {
  const node = new Button(), copies: string[] = [];
  new VersionStatus(node as unknown as HTMLButtonElement, {iteration: UI_ITERATION}, async value => {copies.push(value); return true;});
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
