import type { AgentRow, EntryView, EventData, MessageView, PrimaryView, ProjectedFrame, ResponseOutcome, SavedSession, Target, TargetPreparation } from '../shared/api.ts';
import {absoluteTime} from './format.ts';
import {sessionLabel} from './picker-state.ts';
import {agentName, type ConversationCaption} from './tabs.ts';
export type PresentationTone = 'info' | 'success' | 'warning' | 'error' | 'secondary';

export type AgentHistoryState = {hasEntries: boolean; connected: boolean; loading: boolean; ready: boolean; complete?: boolean; error?: {code?: string; message: string}; availability?: AgentRow['availability']};
export type AgentStartAttempt = {pending: boolean; reason?: string};
export type AgentComposerSource = {connected: boolean; checking?: boolean; availability?: AgentRow['availability']; input?: boolean; checked?: boolean; reason?: string; startAttempt?: AgentStartAttempt; connectionError?: string; blocked?: string};
/** Reading retained messages is separate from admitting new work; the history note covers only the first and shows only while the pane has no messages. */
export type AgentHistoryNote = {text: string; detail: string; reload: boolean; label: 'Load messages' | 'Reload messages'};
/** An agent the browser cannot reach for input still has saved messages to read, so its first read is named as such. */
export function readsSavedMessages(source: Pick<AgentHistoryState, 'connected' | 'availability'>): boolean {
  return source.connected && (source.availability === 'stored' || source.availability === 'unavailable' || source.availability === 'incompatible');
}
function historyNote(text: string, reload: boolean, label: AgentHistoryNote['label'], detail = ''): AgentHistoryNote { return {text, detail, reload, label}; }
export function agentHistoryNote(source: AgentHistoryState): AgentHistoryNote {
  const error = source.error;
  if (error) {
    const format = ['contract_mismatch', 'incompatible'].includes(error.code ?? '');
    return historyNote(format ? 'Saved messages use an unsupported format.' : 'Saved messages could not be read.', true, 'Reload messages', error.message);
  }
  if (source.hasEntries) return historyNote('', false, 'Load messages');
  if (source.loading) return historyNote(readsSavedMessages(source) ? 'Reading saved messages' : 'Loading messages', false, 'Load messages');
  if (!source.connected) return historyNote('Messages are unavailable while the browser is disconnected.', false, 'Load messages');
  if (!source.ready) return historyNote('Messages not loaded.', true, 'Load messages');
  if (source.complete) return historyNote('No messages yet.', false, 'Load messages');
  return historyNote('Saved messages could not be confirmed.', true, 'Reload messages');
}
export type AgentComposerState = {kind: 'start' | 'starting' | 'failed' | 'checking' | 'unreachable' | 'read-only' | 'notice'; line: string; label: string; action?: {label: string; pending?: boolean; disabled?: boolean}; detail: string};
/** `line` is the full sentence for assistive technology; `label` is the short note shown beside the add control in every state that is not ready. */
/** What the composer must say before the draft can be sent; undefined means the agent accepts messages as usual. */
export function agentComposerState(source: AgentComposerSource): AgentComposerState | undefined {
  const attempt = source.startAttempt, detail = [attempt?.reason, source.connectionError, source.reason].filter(Boolean).join('\n');
  if (attempt?.pending) return {kind: 'starting', line: 'Starting the agent', label: 'Starting the agent', action: {label: 'Starting', pending: true, disabled: true}, detail};
  if (attempt) return {kind: 'failed', line: 'Start did not complete.', label: 'Start did not complete', action: {label: 'Try again', disabled: !source.connected}, detail};
  if (!source.connected) return undefined;
  if (source.checking) return {kind: 'checking', line: 'Checking the agent', label: 'Checking the agent', detail: ''};
  if (source.connectionError) return {kind: 'unreachable', line: 'Could not reach the agent.', label: 'Could not reach the agent', action: {label: 'Check again'}, detail};
  if (source.availability === 'incompatible' || source.availability === 'unavailable') return {kind: 'read-only', line: 'This agent cannot run here. Messages are read only.', label: 'This agent cannot run here', detail};
  if (source.availability === 'stored') return {kind: 'start', line: 'Not running. Start it to send a message.', label: 'Not running', action: {label: 'Start'}, detail};
  if (source.availability === 'live' && source.checked && source.input === false) return {kind: 'read-only', line: 'Messages are read only.', label: 'Read only', detail};
  if (source.blocked) return {kind: 'notice', line: 'Provider blocked. Configure this agent through Primary.', label: 'Provider blocked', detail: source.blocked};
  return undefined;
}
export type ConversationPresentation = {
  name: string; nameDetail?: string; identityTail?: string; tone: PresentationTone; cwd?: string; activity: string; input: boolean; busy: boolean; lastObserved: boolean; guidance: string;
  model?: {provider: string; modelId: string; name?: string}; thinking?: string; retainedModel: boolean; retainedThinking: boolean;
  tool?: AgentRow['currentTool']; detail?: string; responseOutcome?: ResponseOutcome; hideVisibleState?: boolean;
};
export function settingsLabel(view: Pick<ConversationPresentation, 'model' | 'thinking' | 'retainedModel' | 'retainedThinking'>, fullModel = false): string {
  const both = !!view.model && !!view.thinking && view.retainedModel && view.retainedThinking;
  const model = view.model ? `${!both && view.retainedModel ? 'Last observed model' : 'Model'} ${fullModel ? `${view.model.provider}/` : ''}${view.model.modelId}` : '';
  const thinking = view.thinking ? `${!both && view.retainedThinking ? 'Last observed thinking' : 'Thinking'} ${view.thinking}` : '';
  return `${both ? 'Last observed: ' : ''}${[model, thinking].filter(Boolean).join(' · ')}`;
}
/** Composer text for a model: the list name when one is known, otherwise the id. The provider and id stay in the tooltip and accessible name. */
export function modelText(model: {modelId: string; name?: string}, listed?: string): string { return listed?.trim() || model.name?.trim() || model.modelId; }
/** Effort is shown with a capital first letter; the reported level stays unchanged elsewhere. */
export function effortText(level: string): string { return level ? level.charAt(0).toLocaleUpperCase() + level.slice(1) : level; }
export type PresentationSource = {target?: Target; primary?: PrimaryView; savedSession?: SavedSession; row?: AgentRow; identityTail?: string; caption?: ConversationCaption;
  availability?: EventData['agent.availability']; negotiated?: Pick<TargetPreparation, 'availability' | 'capabilities'> & {identity: string}; frame?: ProjectedFrame; entries?: readonly EntryView[]; tool?: AgentRow['currentTool']; start?: AgentStartAttempt; connected: boolean};
/** The newest conversational record owns its response outcome; tool errors do not. */
export function responseOutcome(entries: readonly EntryView[] = []): ResponseOutcome | undefined {
  const message = lastConversationMessage(entries);
  if (message?.role !== 'assistant' || message.state !== 'final') return;
  return message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'stopped' : undefined;
}
function lastConversationMessage(entries: readonly EntryView[]): MessageView | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.messages?.findLast(value => value.role === 'assistant' || value.role === 'user');
    if (message) return message;
  }
}
function outcomeLabel(outcome?: ResponseOutcome): string | undefined { return outcome === 'failed' ? 'Response failed' : outcome === 'stopped' ? 'Stopped' : undefined; }
function retryTime(at: number): string { return Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000 ? absoluteTime(at) : 'unavailable'; }
const emptyPresentation = (connected: boolean): ConversationPresentation => ({name: 'Primary', tone: 'warning', activity: '', input: false, busy: false, guidance: '', lastObserved: !connected, retainedModel: false, retainedThinking: false});
function primaryActivity(item: PrimaryView, outcome?: ResponseOutcome): string {
  if (item.lifecycle !== 'ready') return {starting: 'Starting session', switching: 'Switching session', stopped: 'Stopped', failed: 'Session stopped', stopping: 'Stopping'}[item.lifecycle];
  if (item.activity === 'retrying' && item.retry) return `Retrying · retry ${item.retry.attempt} of ${item.retry.maxAttempts} · next about ${retryTime(item.retry.at)}`;
  if (item.activity === 'idle' && outcome) return outcomeLabel(outcome) as string;
  return {idle: 'Ready', running: 'Working', compacting: 'Compacting', retrying: 'Retrying', unknown: 'Connected'}[item.activity];
}
function primaryTone(item: PrimaryView, outcome: ResponseOutcome | undefined, connected: boolean): PresentationTone {
  if (item.lifecycle === 'failed') return 'error';
  if (!connected || item.lifecycle === 'stopped' || item.activity === 'retrying') return 'warning';
  if (item.lifecycle !== 'ready' || ['running', 'compacting'].includes(item.activity)) return 'info';
  if (item.activity === 'unknown') return 'warning';
  return outcome === 'failed' ? 'error' : outcome === 'stopped' ? 'warning' : 'success';
}
function primaryCaption(item: PrimaryView, saved?: SavedSession): Pick<ConversationPresentation, 'name' | 'nameDetail'> {
  const supplied = item.extension?.title?.trim() ? item.extension.title : item.sessionName?.trim() ? item.sessionName : undefined;
  const prompt = !supplied && saved?.id === item.sessionId && saved?.path === item.sessionFile && saved?.titleState === 'ready' && saved.titleSource === 'prompt' && saved.title.trim() ? saved : undefined;
  return {name: supplied ?? (prompt ? sessionLabel(prompt) : 'Primary'), nameDetail: prompt ? `Title from first message, not a supplied name\n${prompt.title}` : undefined};
}
function primaryPresentation(source: PresentationSource, target: Extract<Target, {kind: 'primary'}>): ConversationPresentation {
  const base = emptyPresentation(source.connected); const item = source.primary;
  if (!item || item.key !== target.key || item.epoch !== target.epoch) return base;
  const ready = item.lifecycle === 'ready';
  const outcome = item.responseOutcome ?? responseOutcome(source.entries);
  const activity = source.connected ? primaryActivity(item, outcome) : 'Connection lost; activity unknown';
  return {...base, ...primaryCaption(item, source.savedSession), identityTail:source.identityTail, cwd: item.cwd, activity, tone: primaryTone(item, outcome, source.connected),
    input: ready, busy: source.connected && ready && ['running', 'compacting', 'retrying'].includes(item.activity), responseOutcome: outcome,
    detail: item.activity === 'retrying' && item.retry ? `Next retry time is estimated from backend receipt plus ${item.retry.delayMs} ms.\n${item.retry.error}` : undefined,
    model: item.model ? {provider: item.model.provider, modelId: item.model.id, name: item.model.name} : undefined, thinking: item.thinkingLevel,
    tool: ready && item.activity === 'running' ? source.tool : undefined};
}
function agentSettings(row?: AgentRow, frame?: ProjectedFrame): Pick<ConversationPresentation, 'name' | 'model' | 'thinking' | 'retainedModel' | 'retainedThinking'> {
  return {name: frame?.status.name ?? row?.name ?? row?.handle ?? '', model: frame?.status.model ?? row?.model,
    thinking: frame?.status.thinkingLevel ?? row?.thinkingLevel ?? row?.model?.thinkingLevel,
    retainedModel: !frame?.status.model && !!row?.model, retainedThinking: frame?.status.thinkingLevel === undefined && !!(row?.thinkingLevel ?? row?.model?.thinkingLevel)};
}
function startActivity(state: AgentRow['availability'], start: AgentStartAttempt | undefined): string | undefined {
  if (!start || state === 'live') return undefined;
  return start.pending ? 'Starting' : 'Start failed';
}
function agentActivity(state: AgentRow['availability'], input: boolean, frame: ProjectedFrame | undefined, connected: boolean, checked: boolean, start?: AgentStartAttempt): string {
  if (!connected) return 'Connection lost; activity unknown';
  const attempt = startActivity(state, start); if (attempt) return attempt;
  if (state === 'live' && !checked) return 'Running';
  if (state !== 'live') return {stored: 'Not running', incompatible: 'Read only', unavailable: 'Read only'}[state];
  if (Array.isArray(frame?.status.compactions?.value) && frame.status.compactions.value.length) return 'Compacting';
  if (frame?.status.retry && frame.status.busy) return `Retrying · attempt ${frame.status.retry.attempt} · next ${retryTime(frame.status.retry.at)}`;
  if (frame?.status.busy) return 'Working';
  if (frame?.status.providerBlock) return 'Provider blocked';
  return outcomeLabel(responseOutcome(frame?.entries)) ?? (input ? 'Ready' : 'Read only');
}
function frameTool(frame?: ProjectedFrame): AgentRow['currentTool'] {
  if (!frame?.status.busy) return undefined;
  const nested = frame.live.findLast(entry => entry.tool?.status === 'running')?.tool;
  if (nested) return {name: nested.name, argument: JSON.stringify(nested.arguments.value) ?? ''};
  const completed = new Set([...frame.entries, ...frame.live].flatMap(entry => (entry.messages ?? []).flatMap(message => message.parts.filter(part => part.type === 'toolResult').map(part => part.callId))));
  const calls = frame.live.flatMap(entry => (entry.messages ?? []).flatMap(message => message.parts.filter(part => part.type === 'toolCall')));
  const call = calls.findLast(part => !completed.has(part.callId));
  return call ? {name: call.name, argument: JSON.stringify(call.arguments.value) ?? ''} : undefined;
}
function agentConnection(source: PresentationSource, identity: string) {
  const row = source.row?.identity === identity ? source.row : undefined;
  const availability = source.availability?.identity === identity ? source.availability : undefined;
  const negotiated = source.negotiated?.identity === identity ? source.negotiated : undefined, checked = !!negotiated || !!availability;
  const state = negotiated?.availability ?? availability?.state ?? row?.availability ?? 'unavailable';
  const input = source.connected && checked && state === 'live' && (negotiated?.capabilities ?? availability?.capabilities)?.input === true;
  return {row, checked, state, input};
}
function agentFailureDetails(frame?: ProjectedFrame): string | undefined {
  if (frame?.status.busy && frame.status.retry) return frame.status.retry.error;
  const block = frame?.status.providerBlock; if (!block) return;
  return ['Configure this agent through Primary.', block.error, block.errorRedacted ? 'Some diagnostic text was redacted.' : '', block.errorTruncated ? 'The diagnostic is shortened.' : ''].filter(Boolean).join('\n');
}
function storedTone(start: AgentStartAttempt | undefined): PresentationTone { return start && !start.pending ? 'warning' : 'secondary'; }
function agentTone(state: AgentRow['availability'], connected: boolean, checked: boolean, live: boolean, busy: boolean, input: boolean, frame?: ProjectedFrame, outcome?: ResponseOutcome, start?: AgentStartAttempt): PresentationTone {
  if(state==='stored')return storedTone(start);
  if(connected&&state==='live'&&!checked)return 'secondary';
  if(!connected||!live)return 'warning';
  if(frame?.status.retry||frame?.status.providerBlock)return 'warning';
  if(Array.isArray(frame?.status.compactions?.value)&&frame.status.compactions.value.length)return 'info';
  if(busy)return 'info';
  if(outcome==='failed')return 'error';
  if(outcome==='stopped')return 'warning';
  return frame&&input?'success':'warning';
}
function agentPresentation(source: PresentationSource, identity: string): ConversationPresentation {
  const {row, checked, state, input} = agentConnection(source, identity), frame = source.frame;
  const live = source.connected && checked && state === 'live';
  const busy = live && frame?.status.busy === true, retained = !live;
  const settings = agentSettings(row, frame);
  const name = source.caption?.name ?? agentName(row?.name, row?.handle, identity, frame?.status.name, row?.firstMessage);
  const identityTail = source.caption?.tail ?? source.identityTail;
  const outcome = responseOutcome(frame?.entries);
  const tone = agentTone(state,source.connected,checked,live,busy,input,frame,outcome,source.start);
  return {...emptyPresentation(source.connected), ...settings, name, identityTail, tone, cwd: row?.cwd,
    activity: agentActivity(state, input, frame, source.connected, checked, source.start), input, busy, guidance: input ? '' : state === 'stored' ? 'Start this agent to send.' : 'Messages are unavailable for this agent.', retainedModel: settings.retainedModel || retained && !!settings.model, retainedThinking: settings.retainedThinking || retained && !!settings.thinking,
    hideVisibleState: source.connected && state === 'live' && !checked,
    detail: live ? agentFailureDetails(frame) : undefined,
    responseOutcome: responseOutcome(frame?.entries), tool: live ? frameTool(frame) : undefined};
}
/** Negotiated input and accepted activity describe the same recipient; catalog claims never override them. */
export function conversationPresentation(source: PresentationSource): ConversationPresentation {
  const target = source.target;
  if (!target) return emptyPresentation(source.connected);
  return target.kind === 'primary' ? primaryPresentation(source, target) : agentPresentation(source, target.identity);
}
export function presentationName(view: Pick<ConversationPresentation, 'name' | 'identityTail'>): string {return view.identityTail ? `${view.name} · ${view.identityTail}` : view.name;}
export function presentationGlyph(view: ConversationPresentation): string {
  if (view.busy) return '●';
  if (view.activity === 'Ready') return '✓';
  if (['Not running', 'Read only'].includes(view.activity)) return '○';
  if (['Stopped', 'Response failed', 'Provider blocked', 'Start failed', 'Session stopped'].includes(view.activity)) return '!';
  return '?';
}
/** Composer folders come only from this recipient, never the window launch directory. */
export function composerFolder(view: Pick<ConversationPresentation, 'cwd'>, retained: boolean): {text: string; title: string} | undefined {
  const path = view.cwd; if (!path) return undefined;
  return {text: `${retained ? 'Saved folder' : 'Folder'} ${path}`, title: `${retained ? 'Retained agent folder' : 'Reported Primary folder'}: ${path}`};
}
/** Duplicate directories share a label; a full-path slash distinguishes a suffix-of-path collision. */
export function projectLabels(paths: readonly string[]): Map<string, string> {
  const components = new Map(paths.map(path => [path, path.split('/').filter(Boolean)]));
  const directories = new Map([...components.values()].map(parts => [parts.join('/'), parts]));
  return new Map([...components].map(([path, parts]) => {
    for (let depth = 1; depth <= parts.length; depth++) {
      const suffix = parts.slice(-depth).join('/');
      const collision = [...directories.values()].some(other => other.join('/') !== parts.join('/') && other.length >= depth && other.slice(-depth).join('/') === suffix);
      if (!collision) return [path, suffix];
    }
    return [path, `/${parts.join('/')}`];
  }));
}
export function projectIdentity(view: Pick<ConversationPresentation, 'cwd'>, launchCwd?: string, listedPaths: readonly string[] = []): {path?: string; name: string} {
  const path = view.cwd || launchCwd;
  return {path, name: path ? projectLabels([...listedPaths, path]).get(path) ?? path : 'Working folder'};
}
