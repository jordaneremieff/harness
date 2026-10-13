import type { AgentRow, EventData, PrimaryView, ProjectedFrame, Target, TargetPreparation } from '../shared/api.ts';

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
  if (!source.ready) return 'Loading messages…';
  return source.complete ? 'No messages yet.' : 'History unavailable: saved messages could not be confirmed.';
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
  name: string; cwd?: string; activity: string; input: boolean; busy: boolean; lastObserved: boolean; guidance: string;
  model?: {provider: string; modelId: string}; thinking?: string; retainedModel: boolean; retainedThinking: boolean;
  tool?: AgentRow['currentTool'];
};
export type PresentationSource = {target?: Target; primary?: PrimaryView; row?: AgentRow;
  availability?: EventData['agent.availability']; negotiated?: Pick<TargetPreparation, 'availability' | 'capabilities'> & {identity: string}; frame?: ProjectedFrame; tool?: AgentRow['currentTool']; connected: boolean};
const emptyPresentation = (connected: boolean): ConversationPresentation => ({name: 'Primary', activity: '', input: false, busy: false, guidance: '', lastObserved: !connected, retainedModel: false, retainedThinking: false});
function primaryPresentation(source: PresentationSource, target: Extract<Target, {kind: 'primary'}>): ConversationPresentation {
  const base = emptyPresentation(source.connected); const item = source.primary;
  if (!item || item.key !== target.key || item.epoch !== target.epoch) return base;
  const ready = item.lifecycle === 'ready';
  const activity = item.lifecycle === 'ready'
    ? {idle: 'Ready', running: 'Working', compacting: 'Compacting…', retrying: 'Retrying…', unknown: 'Connected'}[item.activity]
    : {starting: 'Starting session…', switching: 'Switching session…', stopped: 'Stopped', failed: 'Session stopped', stopping: 'Stopping…'}[item.lifecycle];
  return {...base, name: item.extension?.title ?? item.sessionName ?? 'Primary', cwd: item.cwd, activity,
    input: ready, busy: ready && ['running', 'compacting', 'retrying'].includes(item.activity),
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
  if (frame?.status.busy) return 'Working';
  return frame && input ? 'Ready' : 'Connected';
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
function agentPresentation(source: PresentationSource, identity: string): ConversationPresentation {
  const {row, checked, state, input} = agentConnection(source, identity), frame = source.frame;
  const busy = checked && state === 'live' && frame?.status.busy === true, retained = !checked || state !== 'live';
  const settings = agentSettings(row, frame);
  return {...emptyPresentation(source.connected), ...settings, name: settings.name || identity, cwd: row?.cwd,
    activity: state === 'live' && !checked ? 'Connection not checked' : agentActivity(state, input, frame), input, busy, guidance: input ? '' : state === 'stored' ? 'Use Start agent to connect this agent.' : 'Messages are unavailable for this agent.', retainedModel: settings.retainedModel || retained && !!settings.model, retainedThinking: settings.retainedThinking || retained && !!settings.thinking,
    tool: checked && state === 'live' ? frameTool(frame) : undefined};
}
/** Negotiated input and accepted activity describe the same recipient; catalog claims never override them. */
export function conversationPresentation(source: PresentationSource): ConversationPresentation {
  const target = source.target;
  if (!target) return emptyPresentation(source.connected);
  return target.kind === 'primary' ? primaryPresentation(source, target) : agentPresentation(source, target.identity);
}
export function presentationGlyph(view: ConversationPresentation): string {
  if (view.busy) return '●';
  if (['Ready', 'Connected'].includes(view.activity)) return '✓';
  if (view.activity === 'Not connected') return '○';
  if (['Stopped', 'Unavailable', 'Connection unavailable', 'Session stopped'].includes(view.activity)) return '!';
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
