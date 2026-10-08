import type { AgentHistoryPage, AgentRow, Bootstrap, DraftView, EventData, HistoryPage, OperationView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace } from '../shared/api.ts';
import { Actions } from './actions.ts';
import { ProjectPicker } from './picker.ts';
import type { SelectionChange } from './actions.ts';
import { Composer } from './composer.ts';
import { announce, byId, button, copy, details, element, empty, rawText, setText } from './dom.ts';
import { ExtensionDialogs, extensionStatus } from './extensions.ts';
import { Modal } from './modal.ts';
import { installIcons } from './icons.ts';
import { Transcript } from './render.ts';
import { historyBecameReady } from './transcript-history.ts';
import { Roster } from './roster.ts';
import { Recovery, exactInput } from './recovery.ts';
import { agentBlocks, conversationBlocks, createState, dismissNotice, markReadNotices, unreadNotices, mergeRosterPage, mergeAgentPage, mergePrimaryPage, primaryBlocks, reduceEvent, replaceSnapshot, targetIdentity } from './state.ts';
import type { UiEvent } from './state.ts';
import { hydrateVisible } from './hydrate.ts';
import { SelectionQueue } from './selection-state.ts';
import { usageSummary } from './usage.ts';
import { primaryBusy, primaryActivityLabel } from './primary-presentation.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
import { PreferenceQueue } from './preference-queue.ts';
import { renderFacts } from './facts.ts';
import { newerOperation, mergeOperationMap } from './operation-state.ts';
import { ApiError, authenticate, connect, errorMessage, operation, request } from './transport.ts';
import type { ReceivedEvent } from './transport.ts';

installIcons();
let state = createState();
let snapshot: Bootstrap | Snapshot | undefined;
let source: EventSource | undefined;
let connected = false;
let resynchronizing: Promise<void> | undefined;
let historyAbort = new AbortController();
let primaryCursor: string | null = null;
let agentBefore: number | null = null;
let primaryTargetKey = '';
let agentTargetKey = '';
let hiddenPanel = false;
let selecting = false;
let reloadTail = Promise.resolve();
const snapshotBuffers = new Set<{events: UiEvent[]; bytes: number; overflow: boolean}>();
let observationStart: {identity: string; at: number} | undefined;
const modal = new Modal();
const preferences = new PreferenceQueue();
const primaryComposer: Composer = new Composer('primary', {submitted: showOperation, unknownCommand: (text, literal): boolean => actions.unknown(text, literal), recover: recover});
const agentComposer = new Composer('agent', {submitted: showOperation, unknownCommand: () => false, recover: recover});
const primaryTranscript = new Transcript('primary', {presentation: (expanded, showThinking) => { void savePresentation(primaryComposer, expanded, showThinking); }, reading: reading => { void saveReading(primaryComposer, reading); }, fork: (message, entry) => actions.fork(entry, rawText(message.parts)), output: loadPrimaryOutput});
async function loadPrimaryOutput(more: import('../shared/api.ts').OutputContinuation): Promise<import('../shared/api.ts').OutputPage> {
  const captured = primary(); if (!captured) throw new Error('Primary history is unavailable.');
  const page = await request<import('../shared/api.ts').OutputPage>(`/api/primaries/${encodeURIComponent(captured.key)}/history/output?epoch=${captured.epoch}&entry=${encodeURIComponent(more.entryId)}&part=${more.part}&offset=${more.offset}`, 'GET', undefined, undefined, historyAbort.signal);
  if (primary()?.key !== captured.key || primary()?.epoch !== captured.epoch) throw new Error('The primary conversation changed.');
  return page;
}
const agentTranscript = new Transcript('agent', {presentation: (expanded, showThinking) => { void savePresentation(agentComposer, expanded, showThinking); }, reading: reading => { void saveReading(agentComposer, reading); }});
const actions: Actions = new Actions({snapshot: currentSnapshot, primary, composer: primaryComposer, modal, selection, reload, result: showOperation, rosterRefresh: refreshRoster, find: query => primaryTranscript.find(query), recovery: () => recovery.open(), primaryEntries: () => primary() ? primaryBlocks(state, primary()?.key ?? '') : []});
const picker = new ProjectPicker({snapshot: currentSnapshot, primary, modal, selection, reload});
actions.projectPicker = () => picker.open();
const recovery = new Recovery({snapshot: currentSnapshot, reload, modal});
const roster = new Roster(row => { void selectAgent(row).catch(showAgentError); }, action => { if (action === 'refresh') refreshRoster(); else moreRoster(); }, {
  load: (cursor, signal) => request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, undefined, signal),
  merge: page => { state = mergeRosterPage(state, page); renderRoster(); },
});
const extensionDialogs = new ExtensionDialogs(modal, () => state, next => { state = next; }, primary);
const selectionQueue = new SelectionQueue({current: () => state.workspace, reload, save: (workspace, change) => request<Workspace>(`/api/workspaces/${encodeURIComponent(workspace.id)}/selection`, 'PUT', {expectedRevision: workspace.revision, ...change}), paint: (workspace, pending) => { selecting = pending; state = {...state, workspace}; renderAll(); }});

function currentSnapshot(): Snapshot | undefined {
  return snapshot ? {...snapshot, workspace: state.workspace ?? snapshot.workspace, primaries: [...state.primaries.values()], primaryIndex: state.primaryIndex, targetIndex: [...state.targetIndex.values()]} : undefined;
}
function primary(): PrimaryView | undefined { return state.workspace?.primaryKey ? state.primaries.get(state.workspace.primaryKey) : undefined; }
function primaryTarget(): Target | undefined { const item = primary(); return item ? {kind: 'primary', key: item.key, epoch: item.epoch} : undefined; }
function agentRow(identity: string): AgentRow | undefined {
  const row = state.roster.get(identity); const availability = state.agentAvailability.get(identity);
  return row && availability ? {...row, availability: availability.state, capabilities: availability.capabilities} : row;
}
function selectedAgent(): string | undefined { return state.workspace?.selectedTarget?.kind === 'agent' ? state.workspace.selectedTarget.identity : undefined; }
function targetState(target?: Target): TargetState | undefined {
  if (!target) return undefined; const identity = targetIdentity(target);
  return [...state.targets.values()].find(item => targetIdentity(item.target) === identity);
}
function sameTarget(a?: Target, b?: Target): boolean { return !!a && !!b && targetIdentity(a) === targetIdentity(b); }
function selection(change: SelectionChange): Promise<void> {
  historyAbort.abort(); historyAbort = new AbortController(); const startedAt = performance.now();
  const task = selectionQueue.select(change);
  requestAnimationFrame(() => performance.measure('ui:cached-target-switch', {start: startedAt, end: performance.now()})); return task;
}
function reload(): Promise<void> {
  const task = reloadTail.then(refreshSnapshot); reloadTail = task.catch(() => undefined); return task;
}
async function refreshSnapshot(): Promise<void> {
  if (!state.workspace) return;
  const before = state; const buffered = {events: [] as UiEvent[], bytes: 0, overflow: false}; snapshotBuffers.add(buffered);
  try {
    const current = await hydrateVisible(await request<Snapshot>(`/api/snapshot?workspace=${encodeURIComponent(state.workspace.id)}`));
    if (buffered.overflow) throw new Error('Current view changed too quickly during restore. Reconnect to request a fresh baseline.');
    snapshot = current; state = replaceSnapshot({...before, dismissedNotices: state.dismissedNotices, readNotices: state.readNotices}, current, buffered.events); if (state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)}; renderAll();
  } finally { snapshotBuffers.delete(buffered); }
  await loadPrimaryHistory();
}
function stream(): void {
  source?.close(); if (!state.workspace || !state.cursor) return;
  source = connect(state.workspace.id, state.cursor, receive, disconnected);
}
function disconnected(): void {
  connected = false; renderAvailability();
  const banner = byId('connection'); banner.hidden = false;
  banner.replaceChildren(element('span', undefined, 'Connection lost. Work may continue on the Mac.'), button('Reconnect', () => { void resync(); }), button('Details', () => {
    modal.open('Connection details').append(element('p', undefined, 'Last observed primary and agent state stays readable. Unsaved text stays in this tab. No input resends automatically.'));
  }));
}
async function resync(): Promise<void> {
  if (resynchronizing) return resynchronizing;
  source?.close(); connected = false;
  const banner = byId('connection'); banner.hidden = false; setText(banner, 'Restoring current view'); renderAvailability();
  resynchronizing = (async () => {
    try { await reload(); connected = true; banner.hidden = true; stream(); renderAll(); }
    catch (error) { disconnected(); showError(error); }
    finally { resynchronizing = undefined; }
  })();
  return resynchronizing;
}
function receive(event: ReceivedEvent): void {
  const old = state;
  const reduced = {id: event.id, name: event.name, target: event.envelope.target, workspaceId: event.envelope.workspaceId, data: event.envelope.data} as UiEvent;
  for (const buffer of snapshotBuffers) {
    buffer.bytes += event.bytes ?? 512;
    if (buffer.bytes > 1_048_576 || buffer.events.length >= 256) buffer.overflow = true;
    if (!buffer.overflow) buffer.events.push(reduced);
  }
  const reducerStartedAt = performance.now(); state = reduceEvent(state, reduced);
  performance.measure('ui:reducer', {start: reducerStartedAt, end: performance.now()});
  if (state.needsResync) { void resync(); return; }
  if (event.name === 'workspace.changed' && state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)};
  if (event.name === 'ready') { connected = true; byId('connection').hidden = true; renderPrimary(); renderAgent(); return; }
  if (old === state) return;
  applyEvent(event);
  if (event.name === 'primary.state') {
    const current = event.envelope.data as PrimaryView; const previous = old.primaries.get(current.key);
    if (historyBecameReady(previous, current, state.workspace?.primaryKey)) { historyAbort.abort(); historyAbort = new AbortController(); void loadPrimaryHistory(); }
  }
}
function applyEvent(event: ReceivedEvent): void {
  const name = event.name;
  if (name === 'primary.delta' || name === 'primary.message' || name === 'primary.entry' || name === 'primary.tool') renderPrimaryTranscript();
  else if (name === 'primary.state') { renderPrimary(); extensionDialogs.update(); }
  else if (name === 'primary.recovery' || name === 'primary.queue') renderPrimary();
  else if (name === 'agent.frame') renderObservedAgent(event.envelope.data as EventData['agent.frame']);
  else if (name === 'agent.roster' || name === 'agent.availability') { renderRoster(); renderAgent(); }
  else if (name === 'workspace.changed') { renderAll(); void loadPrimaryHistory(); }
  else if (name === 'draft.changed') updateDraft(event.envelope.data as EventData['draft.changed']);
  else if (name === 'operation.changed') showOperation(event.envelope.data as OperationView);
  else if (name === 'notice') noticesBadge();
  else if (name === 'extension.request') applyExtension(event);
  else if (name === 'extension.expired') extensionDialogs.update();
}
function renderObservedAgent(data: EventData['agent.frame']): void {
  renderAgent();
  if (observationStart?.identity !== data.identity) return;
  const start = observationStart.at; observationStart = undefined;
  requestAnimationFrame(() => performance.measure('ui:agent-observation-startup', {start, end: performance.now(), detail: {identity: data.identity}}));
}
function applyExtension(event: ReceivedEvent): void {
  const data = event.envelope.data as EventData['extension.request'];
  if ('id' in data) { extensionDialogs.update(); return; }
  if (data.method === 'notify') noticesBadge();
  else if (data.method === 'set_editor_text' && sameTarget(event.envelope.target, primaryTarget())) primaryComposer.suggest(data.text);
  else if (sameTarget(event.envelope.target, primaryTarget())) extensionStatus(primary());
}
function updateDraft(event: EventData['draft.changed']): void {
  if (sameTarget(event.target, primaryComposer.target)) primaryComposer.updateDraft(event.draft);
  if (sameTarget(event.target, agentComposer.target)) agentComposer.updateDraft(event.draft);
}
function renderAll(): void {
  if (!state.workspace) return;
  document.documentElement.dataset.appearance = state.workspace.appearance ?? 'dark';
  const panelVisible = state.workspace.panelVisible ?? matchMedia('(min-width: 1180px)').matches;
  byId('agent-panel').hidden = !panelVisible;
  byId('workspace').classList.toggle('agents-open', panelVisible);
  byId('workspace').classList.toggle('agent-selected', !!selectedAgent());
  byId('agents-button').setAttribute('aria-expanded', String(panelVisible));
  byId('agent-detail').hidden = !selectedAgent();
  renderPrimary(); renderRoster(); renderAgent(); noticesBadge(); extensionDialogs.update();
}
function renderPrimary(): void {
  const item = primary(); const target = primaryTarget(); const saved = targetState(target);
  actions.warm();
  if (saved?.targetKey !== primaryTargetKey) {
    primaryTargetKey = saved?.targetKey ?? ''; primaryCursor = null; primaryTranscript.reset(); primaryTranscript.configure(saved?.presentation, saved?.reading);
  }
  primaryComposer.attach(state.workspace?.id ?? '', saved); primaryComposer.receipts(state.operations.values());
  byId('primary-composer').hidden = !saved; byId('primary-status').hidden = !item;
  byId('session-title').hidden = !item;
  primaryChrome(item); primaryActivity(item, target);
  extensionStatus(item); renderPrimaryTranscript(); renderAvailability();
  byId('primary-transcript').hidden = !item; byId('primary-empty').hidden = !!item;
  if (!item) {
    document.title = 'Pi · Open a project';
    setText(byId('primary-empty-caption'), state.workspace?.primaryKey ? 'Loading the selected session' : 'Open a project to start or resume a session.');
    byId('primary-open-project').hidden = !!state.workspace?.primaryKey;
  }
}
function primaryChrome(item?: PrimaryView): void {
  setText(byId('project-button'), item?.cwd.split('/').filter(Boolean).at(-1) ?? 'Open a project');
  setText(byId('session-title'), item?.extension?.title ?? item?.sessionName ?? item?.sessionId ?? 'Pi');
  if (item) document.title = `Pi · ${item.sessionName ?? item.sessionId ?? 'Primary'}`;
  const model = byId<HTMLButtonElement>('model-button'); model.disabled = item?.lifecycle !== 'ready'; model.hidden = !item?.model && item?.lifecycle !== 'ready'; setText(model, item?.model ? `${item.model.provider}/${item.model.id} ▾` : 'Model');
  setText(byId('primary-usage'), usageSummary(item));
  const thinking = byId<HTMLButtonElement>('thinking-button'); thinking.hidden = !item?.thinkingLevel; setText(thinking, item?.thinkingLevel ? `${item.thinkingLevel} ▾` : '');
}
function primaryActivity(item?: PrimaryView, target?: Target): void {
  const conversation = target ? state.conversations.get(targetIdentity(target)) : undefined;
  const recovery = conversation?.recovery;
  setText(byId('primary-activity'), item?.lifecycle === 'ready' && recovery?.kind === 'retry' && recovery.phase !== 'end' ? `Retrying${recovery.error ? ` after ${recovery.error}` : ''}${recovery.attempt ? ` · attempt ${recovery.attempt}` : ''}` : primaryActivityLabel(item));
  if (item?.lastError) byId('primary-activity').append(button('Review retry prompt…', () => actions.retryOutput()));
  byId('primary-stop').hidden = !(connected && primaryBusy(item, conversation?.queue?.pending));
}
function renderPrimaryTranscript(): void {
  const item = primary(); const target = primaryTarget();
  if (item) primaryTranscript.set(primaryBlocks(state, item.key), target ? state.conversations.get(targetIdentity(target))?.tools : undefined);
}
function renderRoster(): void { roster.set(state.rosterOrder.flatMap(id => { const row = state.roster.get(id); return row ? [row] : []; }), state.rosterMeta, selectedAgent()); }
function renderAgent(): void {
  const identity = selectedAgent(); if (!identity) { agentComposer.attach(state.workspace?.id ?? ''); return; }
  const row = agentRow(identity); const saved = targetState({kind: 'agent', identity});
  if (saved?.targetKey !== agentTargetKey) {
    agentTargetKey = saved?.targetKey ?? ''; agentBefore = null; byId('agent-facts').replaceChildren(); agentTranscript.reset(); agentTranscript.configure(saved?.presentation, saved?.reading);
  }
  agentComposer.attach(state.workspace?.id ?? '', saved); agentComposer.receipts(state.operations.values());
  agentChrome(identity, row);
  agentAvailability(identity, row); renderAvailability();
}
function agentChrome(identity: string, row?: AgentRow): void {
  setText(byId('agent-name'), row?.name ?? row?.handle ?? identity); setText(byId('agent-identity'), identity);
  const conversation = state.conversations.get(targetIdentity({kind: 'agent', identity})); const frame = conversation?.frame;
  agentTranscript.set(conversation ? conversationBlocks(conversation) : agentBlocks(state));
  setText(byId('agent-status'), frame?.status.model ? `${frame.status.model.provider}/${frame.status.model.modelId}${frame.status.thinkingLevel ? ` · ${frame.status.thinkingLevel}` : ''}` : row?.model ? `${row.model.provider}/${row.model.modelId}${row.thinkingLevel ? ` · ${row.thinkingLevel}` : ''}` : '');
  agentBefore = frame?.nextBefore ?? agentBefore; byId('agent-earlier').hidden = agentBefore === null;
  byId('agent-abort').hidden = !connected || row?.availability !== 'live' || !row?.capabilities?.input || !row?.capabilities?.abort;
  byId('agent-inspect').hidden = !row?.capabilities?.inspect;
  agentFacts(row, frame);
}
function agentFacts(row?: AgentRow, frame?: ProjectedFrame): void {
  const facts: {key: string; label: string; text: string}[] = [];
  if (!frame && row?.firstMessage) facts.push({key: 'first', label: 'First message · retained metadata', text: row.firstMessage});
  if (!frame && row?.latestReply) facts.push({key: 'reply', label: 'Last reply · retained metadata', text: row.latestReply});
  if (frame?.status.tasks) facts.push({key: 'tasks', label: 'Reported tasks', text: rawText(frame.status.tasks.value)});
  if (frame?.status.submissions) facts.push({key: 'submissions', label: 'Reported submissions', text: rawText(frame.status.submissions.value)});
  renderFacts(byId('agent-facts'), facts);
}
function agentAvailability(identity: string, row?: AgentRow): void {
  const frame = state.conversations.get(targetIdentity({kind: 'agent', identity}))?.frame;
  const availability = byId('agent-availability');
  if (row?.availability === 'live') setText(availability, !frame ? 'Loading history' : frame.status.busy ? '● Working' : 'Last observed · live host');
  else {
    setText(availability, row?.availability === 'incompatible' ? 'Host contract mismatch. This agent control is unavailable.' : 'Stored metadata; no live compatible host');
  }

}
function renderAvailability(): void {
  const item = primary(); const identity = selectedAgent(); const row = identity ? agentRow(identity) : undefined;
  const frame = identity ? state.conversations.get(targetIdentity({kind: 'agent', identity}))?.frame : undefined;
  const conversation = item ? state.conversations.get(targetIdentity({kind: 'primary', key: item.key, epoch: item.epoch})) : undefined;
  const busy = primaryBusy(item, conversation?.queue?.pending);
  primaryComposer.availability(connected && !selecting, item?.lifecycle === 'ready', busy);
  byId('primary-stop').hidden = !connected || !busy;
  byId('agent-abort').hidden = !connected || row?.availability !== 'live' || !row?.capabilities?.input || !row?.capabilities?.abort;
  agentComposer.availability(connected && !selecting, row?.availability === 'live' && row.capabilities?.input === true, frame?.status.busy ?? false);
  if (!connected) {
    setText(byId('primary-activity'), 'Last observed · Connection lost');
    if (identity) setText(byId('agent-availability'), 'Last observed · Connection lost');
  }
}
async function selectAgent(row: AgentRow): Promise<void> {
  observationStart = {identity: row.identity, at: performance.now()};
  const applied = selection({panelVisible: true, selectedTarget: {kind: 'agent', identity: row.identity}});
  byId('agent-name').focus(); await applied;
}
async function loadPrimaryHistory(cursor?: string): Promise<void> {
  const item = primary(); const target = primaryTarget(); if (!item || !target) return;
  const captured = targetIdentity(target); const controller = historyAbort;
  try {
    const page = await request<HistoryPage>(`/api/primaries/${encodeURIComponent(item.key)}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, controller.signal);
    if (controller.signal.aborted || captured !== (primaryTarget() ? targetIdentity(primaryTarget() as Target) : '')) return;
    state = mergePrimaryPage(state, target, page.items); primaryCursor = page.nextCursor; byId('primary-earlier').hidden = !primaryCursor; renderPrimaryTranscript();
    primaryTranscript.restore(targetState(target)?.reading);
  } catch (error) { if (!controller.signal.aborted) showError(error); }
}
async function loadAgentHistory(): Promise<void> {
  const identity = selectedAgent(); if (!identity) return;
  const page = await request<AgentHistoryPage>(`/api/agents/${encodeURIComponent(identity)}/history?limit=50${agentBefore ? `&before=${agentBefore}` : ''}`);
  if (selectedAgent() !== identity) return;
  state = mergeAgentPage(state, identity, page.entries); agentBefore = page.nextBefore; renderAgent();
}
function saveReading(composer: Composer, reading: TargetState['reading']): Promise<void> {
  return saveView(composer, 'reading', {anchorId: reading.anchorId, offsetPx: reading.offsetPx, followTail: reading.followTail});
}
function savePresentation(composer: Composer, expanded: string[], showThinking: boolean): Promise<void> {
  return saveView(composer, 'presentation', {expanded: expanded.slice(), showThinking});
}
async function saveView(composer: Composer, kind: 'reading' | 'presentation', values: object): Promise<void> {
  const saved = composer.state; const workspace = state.workspace; if (!saved || !workspace || !connected) return;
  const notice = byId(`${composer.prefix}-view-notice`);
  try { await preferences.save(`${workspace.id}/${saved.targetKey}/${kind}`, async () => {
    const latest = state.targets.get(saved.targetKey) ?? saved;
    const result = await request<TargetState['reading'] | NonNullable<TargetState['presentation']>>(`/api/workspaces/${encodeURIComponent(workspace.id)}/targets/${encodeURIComponent(saved.targetKey)}/${kind}`, 'PUT', {expectedRevision: latest[kind]?.revision ?? 0, ...values});
    const current = state.targets.get(saved.targetKey) ?? saved;
    if (result.revision >= (current[kind]?.revision ?? 0)) state = {...state, targets: new Map(state.targets).set(saved.targetKey, {...current, [kind]: result})};
    if (notice.dataset.kind === kind) notice.replaceChildren();
  }); } catch (error) {
    notice.dataset.kind = kind; notice.replaceChildren(element('p', 'error', `View not saved for ${targetIdentity(saved.target)}: ${errorMessage(error)}`), button('Reload saved view', () => { void reload().then(() => {
      if (composer.state?.targetKey !== saved.targetKey) return;
      const latest = state.targets.get(saved.targetKey); const transcript = composer.prefix === 'primary' ? primaryTranscript : agentTranscript;
      transcript.configure(latest?.presentation, latest?.reading); notice.replaceChildren();
    }).catch(showError); }));
  }
}
function showOperation(result: OperationView): void {
  if (newerOperation(state.operations.get(result.id), result) !== result) return;
  state = {...state, operations: mergeOperationMap(state.operations, result)};
  if (result.kind === 'primary.handoff') actions.handoffResult(result);
  if (inputOperation(result)) {
    if (['accepted', 'rejected', 'uncertain'].includes(result.state)) { primaryComposer.updateOperation(result); agentComposer.updateOperation(result); }
  }
  primaryComposer.receipts(state.operations.values()); agentComposer.receipts(state.operations.values());
  if (result.state !== 'reserved' && result.state !== 'dispatched') announce(operationLabel(result));
}
function recover(saved: TargetState): void {
  const prefix = saved.target.kind === 'primary' ? 'primary' : 'agent'; const receipt = byId(`${prefix}-receipt`); receipt.replaceChildren();
  for (const item of saved.unconfirmed) {
    const row = element('div'); row.append(element('p', 'warning', 'Send not confirmed'), element('pre', undefined, item.text));
    row.append(button('Check receipt', () => { void request<OperationView>(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {}).then(showOperation).catch(showError); }), button('Copy', () => { void exactInput(state.workspace?.id ?? '', item).then(exact => copy(exact.text, row)).catch(showError); }), button('Restore to draft', () => {
      void request<DraftView>(`/api/workspaces/${encodeURIComponent(state.workspace?.id ?? '')}/unconfirmed/${encodeURIComponent(item.operationId)}/restore`, 'POST', {expectedDraftRevision: saved.draft.revision}).then(() => reload()).catch(showError);
    }), button('Discard copy…', () => modal.confirm('Discard input copy', 'This deletes only the local copy. It does not cancel work or prove non-admission.', async () => { await request(`/api/workspaces/${encodeURIComponent(state.workspace?.id ?? '')}/unconfirmed/${encodeURIComponent(item.operationId)}`, 'DELETE'); await reload(); }, 'Discard copy'))); receipt.append(row);
  }
}
function noticesBadge(): void { const unread = unreadNotices(state); setText(byId('notices-count'), unread ? String(unread) : ''); byId('notices-count').hidden = !unread; byId('notices-button').setAttribute('aria-label', unread ? `Notifications (${unread} unread)` : 'Notifications'); }
function notices(): void {
  state = markReadNotices(state); noticesBadge(); modal.open('Notifications'); if (!state.notices.length) modal.body.append(empty('No notifications'));
  for (const notice of state.notices) {
    const row = element('div', `notification ${notice.level}`); row.append(button('Dismiss', () => { state = dismissNotice(state, notice.id); notices(); noticesBadge(); }), element('p', undefined, notice.message));
    if (notice.target) row.append(element('p', 'target-label', notice.target.kind === 'primary' ? `Primary ${notice.target.key} · conversation ${notice.target.epoch}` : `Agent ${notice.target.identity}`));
    modal.body.append(row);
  }
}
function showError(error: unknown): void { const message = errorMessage(error); announce(message); setText(byId('primary-receipt'), message); }
function showAgentError(error: unknown): void { const message = errorMessage(error); announce(message); setText(byId('agent-receipt'), message); }
function showRosterError(error: unknown): void { const message = errorMessage(error); announce(message); byId('roster-footer').replaceChildren(element('p', 'error', message), button('Retry roster read', () => { void reload().catch(showRosterError); })); }
function refreshRoster(): void { void request('/api/agents/refresh', 'POST', {}).catch(showRosterError); }
function moreRoster(): void {
  const cursor = state.rosterMeta?.nextCursor;
  if (cursor) { void request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`).then(page => {
    state = mergeRosterPage(state, page); renderRoster();
  }).catch(showRosterError); return; }
  const scanId = state.rosterMeta?.scan.scanId;
  void request('/api/agents/refresh', 'POST', scanId ? {scanId, continue: true} : {}).catch(showRosterError);
}
function inspectAgent(): void {
  const identity = selectedAgent(); if (!identity) return;
  modal.open('Agent activity').append(element('p', 'identity', identity)); const token = modal.token;
  void modal.run(async () => {
    const data = await request(`/api/agents/${encodeURIComponent(identity)}/inspect`, 'POST', {view: 'activity', limit: 20});
    if (modal.owns(token)) modal.body.append(details('Reported activity', rawText(data)));
  }, false);
}
function viewActions(): void {
  modal.open('Loaded conversation view');
  for (const [label, tools, expand] of [['Expand loaded tools', true, true], ['Collapse loaded tools', true, false], ['Show thinking', false, true], ['Hide thinking', false, false]] as const) modal.body.append(button(label, () => { primaryTranscript.expandLoaded(tools, expand); modal.close(); }));
  modal.body.append(button('Find in loaded messages', () => actions.find()));
}
function bind(): void {
  byId('primary-open-project').addEventListener('click', () => actions.projectPicker());
  byId('project-button').addEventListener('click', () => actions.projectPicker()); byId('session-title').addEventListener('click', () => actions.sessionDetails());
  byId('session-actions').addEventListener('click', () => { actions.sessionMenu(); modal.body.append(button('Conversation view…', viewActions)); }); byId('commands-button').addEventListener('click', () => actions.palette());
  byId('model-button').addEventListener('click', () => actions.modelPicker()); byId('thinking-button').addEventListener('click', () => actions.thinkingPicker());
  byId('notices-button').addEventListener('click', notices);
  byId('agent-acquire').addEventListener('click', () => { const identity = selectedAgent(); if (connected && identity) actions.prepareText(`/agent attach ${identity}`); });
  byId('agents-button').addEventListener('click', () => { void selection({panelVisible: byId('agent-panel').hidden}).catch(showError); });
  for (const id of ['agent-close', 'agent-detail-close']) byId(id).addEventListener('click', () => { void selection({panelVisible: false}).catch(showError); });
  byId('agent-back').addEventListener('click', () => { void selection({selectedTarget: null}).catch(showError); });
  byId('agent-copy').addEventListener('click', () => { void copy(selectedAgent() ?? '', byId('agent-availability')); });
  byId('agent-inspect').addEventListener('click', inspectAgent); byId('agent-facts').addEventListener('toggle', renderAgent, true);
  byId('agent-refresh').addEventListener('click', refreshRoster); byId('agent-new').addEventListener('click', () => actions.prepareText('/agent new'));
  byId('primary-earlier').addEventListener('click', () => { void loadPrimaryHistory(primaryCursor ?? undefined); }); byId('agent-earlier').addEventListener('click', () => { void loadAgentHistory().catch(showAgentError); });
  byId('primary-stop').addEventListener('click', () => { const target = primaryTarget(); if (target?.kind !== 'primary') return; setText(byId('primary-receipt'), 'Stop requested'); void operation('primary.stop', `/api/primaries/${encodeURIComponent(target.key)}/stop`, {epoch: target.epoch}, target).then(showOperation).catch(showError); });
  byId('agent-abort').addEventListener('click', () => { const identity = selectedAgent(); if (!identity) return; modal.confirm('Abort selected agent', `${identity}\nThis requests foreground abort only. Background work and timers remain separate.`, async () => { setText(byId('agent-receipt'), 'Abort requested'); showOperation(await operation('agent.abort', `/api/agents/${encodeURIComponent(identity)}/abort`, {background: false}, {kind: 'agent', identity})); }, 'Abort'); });
  document.addEventListener('keydown', event => { if (event.metaKey && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!modal.openNow) actions.palette(); } });
  window.addEventListener('resize', () => { primaryComposer.resize(); agentComposer.resize(); });
  window.addEventListener('beforeunload', event => { if (primaryComposer.unsaved || agentComposer.unsaved) event.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.workspace?.panelVisible) { hiddenPanel = true; void selection({panelVisible: false}).catch(showError); }
    else if (!document.hidden && hiddenPanel) { hiddenPanel = false; void selection({panelVisible: true}).catch(showError); }
  });
}
async function start(): Promise<void> {
  bind();
  try {
    await authenticate(); const workspace = new URL(location.href).searchParams.get('workspace');
    const data = await hydrateVisible(await request<Bootstrap>(`/api/bootstrap${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`));
    snapshot = data; state = replaceSnapshot(state, data);
    const url = new URL(location.href); url.searchParams.set('workspace', data.workspace.id); history.replaceState(null, '', url);
    connected = true; renderAll(); stream(); await loadPrimaryHistory();
    document.dispatchEvent(new Event('ui-ready')); if (!primary()) actions.projectPicker();
  } catch (error) {
    disconnected();
    if (error instanceof ApiError && error.view.code === 'unauthorized') { byId('connection').replaceChildren(element('span', undefined, 'Open the launch link from this Mac'), button('Retry', () => location.reload())); }
    else showError(error);
  }
}
void start();
