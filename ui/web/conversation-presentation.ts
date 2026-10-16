import type { AgentRow, EntryView, EventData, MessageView, PrimaryView, ProjectedFrame, ResponseOutcome, Target, TargetPreparation } from '../shared/api.ts';
import {absoluteTime} from './format.ts';
import {agentIdentityTails, agentName} from './tabs.ts';
export type PresentationTone = 'info' | 'success' | 'warning' | 'error' | 'secondary';

export type AgentViewState = {hasEntries: boolean; connected: boolean; loading: boolean; ready: boolean; complete?: boolean; availability?: AgentRow['availability']; input?: boolean; checked?: boolean; reason?: string; error?: {code?: string; message: string}; startAttempt?: {pending: boolean; reason?: string}; connectionError?: string};
/** Reading retained messages and admitting new work have independent outcomes. */
export function agentViewStatus(source: AgentViewState): {text: string; detail: string; start: boolean} {
  const history = agentHistoryStatus(source), connection = agentConnectionStatus(source.connectionError === source.error?.message ? {...source, connectionError: undefined} : source);
  const text = (source.startAttempt ? [connection, history] : [history, connection]).filter(Boolean).join(' · ');
  return {text, detail: [source.error?.message, source.startAttempt?.reason, source.connectionError, source.reason].filter(Boolean).join('\n'), start: source.availability === 'stored' && !source.startAttempt};
}
function agentHistoryStatus(source: AgentViewState): string {
  if (source.error?.code === 'source_unreadable') return 'History unavailable: saved messages could not be read.';
  if (source.error) return ['contract_mismatch', 'incompatible'].includes(source.error.code ?? '') ? 'History unavailable: saved messages use an unsupported format.' : 'History unavailable: saved messages could not be read.';
  if (source.loading) return source.hasEntries ? 'Updating messages…' : 'Loading messages…';
  if (source.hasEntries) return '';
  if (!source.connected) return 'History unavailable: the browser is disconnected.';
  if (!source.ready) return 'Messages not loaded.';
  return source.ready && source.complete ? 'No messages yet.' : 'History unavailable: saved messages could not be confirmed.';
}
function agentConnectionStatus(source: AgentViewState): string {
  if (source.startAttempt) return source.startAttempt.pending ? 'Starting agent…' : 'Start not confirmed. Retry only reads saved messages.';
  if (source.connectionError) return 'Agent connection is unavailable.';
  if (!source.connected && source.hasEntries) return 'The browser is disconnected.';
  if (source.availability === 'live' && source.checked === false) return 'Connection not checked.';
  if (source.availability === 'live' && source.input === false) return 'Messages are read-only.';
  if (source.availability === 'incompatible') return 'This agent cannot connect; messages remain read-only.';
  if (source.availability === 'stored' || source.availability === 'unavailable') return 'Agent is not connected.';
  return '';
}
export type ConversationPresentation = {
  name: string; identityTail?: string; tone: PresentationTone; cwd?: string; activity: string; input: boolean; busy: boolean; lastObserved: boolean; guidance: string;
  model?: {provider: string; modelId: string}; thinking?: string; retainedModel: boolean; retainedThinking: boolean;
  tool?: AgentRow['currentTool']; detail?: string; responseOutcome?: ResponseOutcome;
};
export type PresentationSource = {target?: Target; primary?: PrimaryView; row?: AgentRow; identityTail?: string;
  availability?: EventData['agent.availability']; negotiated?: Pick<TargetPreparation, 'availability' | 'capabilities'> & {identity: string}; frame?: ProjectedFrame; entries?: readonly EntryView[]; tool?: AgentRow['currentTool']; connected: boolean};
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
  if (item.lifecycle !== 'ready') return {starting: 'Starting session…', switching: 'Switching session…', stopped: 'Stopped', failed: 'Session stopped', stopping: 'Stopping…'}[item.lifecycle];
  if (item.activity === 'retrying' && item.retry) return `Retrying · retry ${item.retry.attempt} of ${item.retry.maxAttempts} · next about ${retryTime(item.retry.at)}`;
  if (item.activity === 'idle' && outcome) return outcomeLabel(outcome) as string;
  return {idle: 'Ready', running: 'Working', compacting: 'Compacting…', retrying: 'Retrying…', unknown: 'Connected'}[item.activity];
}
function primaryTone(item: PrimaryView, outcome: ResponseOutcome | undefined, connected: boolean): PresentationTone {
  if (item.lifecycle === 'failed') return 'error';
  if (!connected || item.lifecycle === 'stopped' || item.activity === 'retrying') return 'warning';
  if (item.lifecycle !== 'ready' || ['running', 'compacting'].includes(item.activity)) return 'info';
  if (item.activity === 'unknown') return 'warning';
  return outcome === 'failed' ? 'error' : outcome === 'stopped' ? 'warning' : 'success';
}
function primaryPresentation(source: PresentationSource, target: Extract<Target, {kind: 'primary'}>): ConversationPresentation {
  const base = emptyPresentation(source.connected); const item = source.primary;
  if (!item || item.key !== target.key || item.epoch !== target.epoch) return base;
  const ready = item.lifecycle === 'ready';
  const outcome = item.responseOutcome ?? responseOutcome(source.entries);
  const activity = primaryActivity(item, outcome);
  return {...base, name: item.extension?.title ?? item.sessionName ?? 'Primary', identityTail:source.identityTail, cwd: item.cwd, activity, tone: primaryTone(item, outcome, source.connected),
    input: ready, busy: ready && ['running', 'compacting', 'retrying'].includes(item.activity), responseOutcome: outcome,
    detail: item.activity === 'retrying' && item.retry ? `Next retry time is estimated from backend receipt plus ${item.retry.delayMs} ms.\n${item.retry.error}` : undefined,
    model: item.model ? {provider: item.model.provider, modelId: item.model.id} : undefined, thinking: item.thinkingLevel,
    tool: ready && item.activity === 'running' ? source.tool : undefined};
}
function agentSettings(row?: AgentRow, frame?: ProjectedFrame): Pick<ConversationPresentation, 'name' | 'model' | 'thinking' | 'retainedModel' | 'retainedThinking'> {
  return {name: frame?.status.name ?? row?.name ?? row?.handle ?? '', model: frame?.status.model ?? row?.model,
    thinking: frame?.status.thinkingLevel ?? row?.thinkingLevel ?? row?.model?.thinkingLevel,
    retainedModel: !frame?.status.model && !!row?.model, retainedThinking: frame?.status.thinkingLevel === undefined && !!(row?.thinkingLevel ?? row?.model?.thinkingLevel)};
}
function agentActivity(state: AgentRow['availability'], input: boolean, frame?: ProjectedFrame): string {
  if (state !== 'live') return {stored: 'Not connected', incompatible: 'Connection unavailable', unavailable: 'Unavailable'}[state];
  if (Array.isArray(frame?.status.compactions?.value) && frame.status.compactions.value.length) return 'Compacting…';
  if (frame?.status.retry && frame.status.busy) return `Retrying · attempt ${frame.status.retry.attempt} · next ${retryTime(frame.status.retry.at)}`;
  if (frame?.status.busy) return 'Working';
  if (frame?.status.providerBlock) return 'Provider blocked';
  return outcomeLabel(responseOutcome(frame?.entries)) ?? (frame && input ? 'Ready' : 'Connected');
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
function agentTone(state: AgentRow['availability'], connected: boolean, live: boolean, busy: boolean, input: boolean, frame?: ProjectedFrame, outcome?: ResponseOutcome): PresentationTone {
  if(state==='stored')return 'secondary';
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
  const live = checked && state === 'live';
  const busy = live && frame?.status.busy === true, retained = !live;
  const settings = agentSettings(row, frame);
  const name = agentName(row?.name, row?.handle, identity, frame?.status.name);
  const identityTail = source.identityTail ?? agentIdentityTails([{name, identity}]).get(identity);
  const outcome = responseOutcome(frame?.entries);
  const tone = agentTone(state,source.connected,live,busy,input,frame,outcome);
  return {...emptyPresentation(source.connected), ...settings, name, identityTail, tone, cwd: row?.cwd,
    activity: state === 'live' && !checked ? 'Connection not checked' : agentActivity(state, input, frame), input, busy, guidance: input ? '' : state === 'stored' ? 'Use Start agent to connect this agent.' : 'Messages are unavailable for this agent.', retainedModel: settings.retainedModel || retained && !!settings.model, retainedThinking: settings.retainedThinking || retained && !!settings.thinking,
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
  if (['Ready', 'Connected'].includes(view.activity)) return '✓';
  if (view.activity === 'Not connected') return '○';
  if (['Stopped', 'Response failed', 'Provider blocked', 'Unavailable', 'Connection unavailable', 'Session stopped'].includes(view.activity)) return '!';
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
