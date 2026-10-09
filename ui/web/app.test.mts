import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
test('shell element references match the shared DOM contract', () => {
  for (const match of source.matchAll(/byId(?:<[^>]+>)?\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), `Missing ${match[1]}`);
  assert.doesNotMatch(source, /byId\('(?:agent-panel|agents-button|agent-back|agent-close|agent-detail-close)'\)/);
  assert.match(source, /commands: \(\) => actions\.commandOptions\(\)/);
});
test('section changes hide retained nodes and explicit skip navigation focuses the selected editor', () => {
  assert.match(source, /byId\('primary'\)\.hidden = agentSelected/);
  assert.match(source, /byId\('agent-detail'\)\.hidden = !agentSelected/);
  assert.doesNotMatch(source, /byId\('(?:primary|agent-detail)'\)\.replaceChildren/);
  assert.match(source, /navigationState\(state\.workspace, false\)\.editor\)\.focus\(\)/);
  assert.match(source, /byId\('skip-composer'\)\.addEventListener\('click', event => \{ event\.preventDefault\(\); focusEditor\(\); \}\)/);
});
test('earlier-history loads expose pending and result states without restoring an old saved anchor', () => {
  assert.match(source, /control\.disabled = pending/);
  assert.match(source, /pending \? 'Loading earlier messages…' : 'Load earlier messages'/);
  assert.match(source, /if \(cursor\) historyFeedback\('primary', `Loaded earlier history/);
  assert.match(source, /else if \(!selectedAgent\(\)\) primaryTranscript\.restore\(targetState\(target\)\?\.reading\)/);
  assert.match(source, /Earlier history unavailable:/);
  assert.match(source, /controller\.signal\.aborted \|\| !sameTarget\(target, primaryTarget\(\)\)/);
});
test('selection admission gate stays separate from transport connectivity', () => {
  assert.match(source, /primaryComposer\.availability\(connected, item\?\.lifecycle === 'ready', busy, selecting\)/);
  assert.match(source, /agentComposer\.availability\(connected, [^\n]+, selecting\)/);
  assert.doesNotMatch(source, /availability\(connected && !selecting/);
});
test('snapshot refresh does not await history and history still has a deadline', () => {
  assert.match(source, /refreshVisible\(refreshSnapshot, loadPrimaryHistory, showError\)/);
  assert.match(source, /AbortSignal\.any\(\[controller\.signal, AbortSignal\.timeout\(15_000\)\]\)/);
  assert.doesNotMatch(source, /await loadPrimaryHistory\(/);
});
test('action errors choose the visible receipt when the rejection is handled', () => {
  assert.match(source, /setText\(byId\(visibleReceipt\(state\.workspace\)\), message\)/);
  assert.doesNotMatch(source, /function showAgentError/);
});
test('collapsed connection failures have a single reachable owner and tab hiding still releases observation', () => {
  assert.match(source, /connectionSurfaceFor\(connectionPhase, !byId\('sidebar'\)\.hidden\)/);
  assert.match(source, /for \(const id of \['connection', 'workspace-alert'\]\)/);
  assert.match(source, /document\.hidden && state\.workspace\?\.panelVisible/);
  assert.match(source, /selection\(\{panelVisible: false\}\)/);
  assert.match(source, /selection\(\{panelVisible: true\}\)/);
  assert.doesNotMatch(source, /setInterval/);
});
