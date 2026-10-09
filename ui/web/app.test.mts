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
  assert.match(source, /pending \? '↑ earlier…' : '↑ earlier'/);
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

test('message panel moves the existing form outside the roster without changing the main view', () => {
  assert.equal([...html.matchAll(/id="agent-composer"/g)].length, 1); assert.equal([...html.matchAll(/id="agent-editor"/g)].length, 1);
  assert.ok(html.includes('</section>\n<section id="agent-message-panel"'));
  assert.ok(html.indexOf('id="agent-message-panel"') < html.indexOf('<footer class="sidebar-foot">'));
  assert.match(source, /form.parentElement !== panel\) panel.append\(form\)/);
  assert.match(source, /form.parentElement !== detail\) detail.append\(form\)/);
  const panel = source.slice(source.indexOf('function renderMessagePanel()'), source.indexOf('function renderAgent()'));
  assert.doesNotMatch(panel, /selection\(|primaryTranscript\.|primaryComposer\.(attach|setText)/);
  assert.match(source, /targets`, 'POST', \{target\}/);
});
test('transcript saves use their captured workspace and target rather than the movable composer', () => {
  assert.match(source, /saveReading\(agentTranscriptTarget, reading\)/); assert.match(source, /savePresentation\(agentTranscriptTarget, expanded, showThinking\)/);
  const saves = source.slice(source.indexOf('function saveReading('), source.indexOf('function showOperation('));
  assert.doesNotMatch(saves, /composer\.state|agentComposer|selectedAgent/);
  assert.match(saves, /const \{saved, workspaceId, prefix\} = captured/);
  assert.match(saves, /encodeURIComponent\(workspaceId\)/); assert.match(saves, /encodeURIComponent\(saved.targetKey\)/);
});
test('close and Escape retain buffers, return focus by identity, and hide unsafe controls', () => {
  assert.match(source, /byId\('agent-message-close'\).addEventListener\('click', \(\) => closeMessagePanel\(\)/);
  assert.match(source, /event.key === 'Escape' && messageTarget.current && !modal.openNow/);
  assert.match(source, /roster.focusMessage\(identity\)/); assert.match(source, /primaryComposer.editor.focus\(\)/);
  for (const control of ['agent-abort', 'agent-acquire']) assert.ok(source.includes(`byId('${control}').addEventListener('click', () => { if (messageTarget.current) return;`));
  assert.match(source, /messageTarget.current \? messageTarget.ready : row\?\.availability/);
  assert.match(source, /agentComposer.placement\(true\)/);
});

test('only arrived roster and availability events invalidate message preparation', () => {
  const events = source.slice(source.indexOf('function applyEvent('), source.indexOf('function renderObservedAgent('));
  assert.match(events, /messageTarget.rosterChanged\(event.envelope.data as EventData\['agent.roster'\]\)/);
  assert.match(events, /messageTarget.availabilityChanged\(event.envelope.data as EventData\['agent.availability'\]\)/);
  const panel = source.slice(source.indexOf('function renderMessagePanel()'), source.indexOf('function closeMessagePanel('));
  assert.doesNotMatch(panel, /messageTarget\.(rosterChanged|availabilityChanged)/);
  assert.match(source, /messageTarget.current && !messageTarget.current.invalidated\) await messageTarget.open/);
});
test('Resume uses revision-aware reconciliation and restores its exact buffer while prepare is pending', () => {
  assert.match(source, /agentComposer.retained\(state.workspace\?\.id \?\? '', target, index\) \?\? false/);
  assert.doesNotMatch(source, /retained\([^\n]+\) \?\? !!\(index/);
  assert.match(source, /else agentComposer.attachRetained\(captured.workspaceId, \{kind: 'agent', identity: captured.identity\}\)/);
  assert.match(source, /agentComposer.availability\(connected, messageTarget.ready, false, selecting\)/);
});
test('the app delegates composer recovery without a duplicate renderer or hook', () => {
  assert.doesNotMatch(source, /function recover\(|recover: recover|exactInput/);
  assert.match(source, /recovery: \(\) => recovery.open\(\)/);
});

test('bare shell has palette-first controls, exception-only activity and dim sidebar state', () => {
  assert.doesNotMatch(source, /installIcons|primaryActivityLabel|sessionMenu\(\)|viewActions\(/);
  for (const id of ['sidebar-hide', 'sessions-button', 'appearance-button', 'agent-refresh', 'agent-new', 'session-actions', 'agent-copy', 'agent-identity', 'agent-inspect', 'primary-open-project']) assert.equal(html.includes(`id="${id}"`), false);
  assert.doesNotMatch(source, /byId\('(?:session-title|agent-name)'\)\.addEventListener\('click'/);
  assert.ok(source.includes("setText(byId('primary-row-meta'), item ? primaryState(item) : '')"));
  assert.ok(source.includes('$' + '{primaryState(item)}'));
  assert.doesNotMatch(source, /model\.id\} ▾|thinkingLevel\} ▾|Live · (idle|working|loading)/);
  assert.ok(source.includes("byId('notices-button').hidden = !unread"));
  assert.ok(source.includes("item?.activity === 'retrying' ? 'Retrying' : ''"));
  assert.ok(source.includes('if (item?.lastError)'));
  assert.ok(source.includes('selectedAgent: () =>'));
  assert.ok(source.includes('view: (tools, expand) => primaryTranscript.expandLoaded(tools, expand)'));
});

test('the project prompt uses lowercase instrument chrome', () => {
  assert.ok(source.includes("setText(byId('project-name'), item?.cwd.split('/').filter(Boolean).at(-1) ?? 'open a project')"));
});

test('the no-session primary row uses the allowed empty state glyph', () => {
  const navigation = source.slice(source.indexOf('function primaryNavigation('), source.indexOf('function primaryActivity('));
  assert.ok(navigation.includes("const glyph = !item ? '○'"));
  assert.ok(navigation.includes("?? 'no session'"));
  assert.doesNotMatch(navigation, /◌/);
});
