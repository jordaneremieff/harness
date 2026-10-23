import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { UI_ITERATION, identityLabel, identityText, type UiIdentity } from '../shared/version.ts';
import { VersionStatus } from './version-status.ts';
class Button {
  type = ''; tabIndex = -1; className = ''; textContent = ''; title = '';
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) {this.attributes.set(name, value);}
  addEventListener() {assert.fail('The version presentation adds no listeners; the health owner binds activation.');}
}
const identity: UiIdentity = {iteration: UI_ITERATION, git: {commit: 'a'.repeat(40), shortCommit: 'aaaaaaa', branch: 'feature/ui', modified: true,
  committedAt: '2026-10-12T00:00:00.000Z'}, assets: {digest: 'b'.repeat(64), builtAt: '2026-10-12T01:00:00.000Z'}, startedAt: '2026-10-12T02:00:00.000Z', pi: '1.1.0', durable: '1.1.0'};
test('one stable button shows this served iteration and names the health entry it opens', () => {
  const node = new Button();
  const status = new VersionStatus(node as unknown as HTMLButtonElement, identity);
  assert.equal(status.identity, identity); assert.equal(status.node as unknown, node);
  assert.equal(node.type, 'button'); assert.equal(node.tabIndex, 0);
  assert.equal(node.attributes.get('aria-label'), `Version ${identityLabel(identity)}, open health`);
  assert.equal(node.textContent, identityLabel(identity)); assert.equal(node.title, identityText(identity));
});
test('non-Git display contains only the declared iteration', () => {
  const node = new Button();
  new VersionStatus(node as unknown as HTMLButtonElement, {iteration: UI_ITERATION});
  assert.equal(node.textContent, `ui ${UI_ITERATION}`); assert.equal(node.title, node.textContent);
  assert.equal(node.attributes.get('aria-label'), `Version ui ${UI_ITERATION}, open health`);
});
test('identity is the final hidden status control after the conversation and measures groups, with quiet ink in the line font', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const footer = /<footer id="workbench-status"[^>]*\shidden>([\s\S]*?)<\/footer>/.exec(html)?.[1]; assert.ok(footer);
  assert.equal((html.match(/id="workbench-version"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /workbench-health/);
  assert.match(footer, /<button id="workbench-version"[^>]*><\/button>\s*$/);
  assert.doesNotMatch(footer,/id="status-controls"/);
  const order = ['id="workbench-scope"', 'id="workbench-activity"', 'id="workbench-status-primary"', 'id="workbench-status-agent"', 'id="workbench-version"'];
  const positions = order.map(marker => footer.indexOf(marker));
  assert.ok(positions.every(at => at >= 0)); assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  const rule = /\.workbench-version\s*\{([^}]*)\}/.exec(css)?.[1]; assert.ok(rule);
  assert.match(rule, /margin-left: auto/); assert.match(rule, /color: var\(--muted\)/);
  assert.doesNotMatch(rule, /font-family/);
  assert.doesNotMatch(css, /\.workbench-health/);
});
