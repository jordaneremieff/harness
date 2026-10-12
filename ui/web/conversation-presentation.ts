import type { AgentRow, EventData, PrimaryView, ProjectedFrame, Target } from '../shared/api.ts';

export type ConversationPresentation = {
  name: string; cwd?: string; activity: string; input: boolean; busy: boolean; lastObserved: boolean; guidance: string;
  model?: {provider: string; modelId: string}; thinking?: string; retainedModel: boolean; retainedThinking: boolean;
  tool?: AgentRow['currentTool'];
};
export type PresentationSource = {target?: Target; primary?: PrimaryView; row?: AgentRow;
  availability?: EventData['agent.availability']; frame?: ProjectedFrame; tool?: AgentRow['currentTool']; connected: boolean};
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
  if (state !== 'live') return {stored: 'Not connected', incompatible: 'Incompatible host', unavailable: 'Unavailable'}[state];
  if (frame?.status.busy) return 'Working';
  return frame && input ? 'Ready' : 'Connected';
}
function frameTool(frame?: ProjectedFrame): AgentRow['currentTool'] {
  if (!frame?.status.busy) return undefined;
  const completed = new Set([...frame.entries, ...frame.live].flatMap(entry => (entry.messages ?? []).flatMap(message => message.parts.filter(part => part.type === 'toolResult').map(part => part.callId))));
  const calls = frame.live.flatMap(entry => (entry.messages ?? []).flatMap(message => message.parts.filter(part => part.type === 'toolCall')));
  const call = calls.findLast(part => !completed.has(part.callId));
  return call ? {name: call.name, argument: JSON.stringify(call.arguments.value) ?? ''} : undefined;
}
function agentPresentation(source: PresentationSource, identity: string): ConversationPresentation {
  const row = source.row?.identity === identity ? source.row : undefined;
  const availability = source.availability?.identity === identity ? source.availability : undefined;
  const state = availability?.state ?? row?.availability ?? 'unavailable';
  const input = state === 'live' && (availability?.capabilities ?? row?.capabilities)?.input === true;
  const frame = source.frame; const busy = state === 'live' && frame?.status.busy === true;
  const settings = agentSettings(row, frame);
  return {...emptyPresentation(source.connected), ...settings, name: settings.name || identity, cwd: row?.cwd,
    activity: agentActivity(state, input, frame), input, busy, guidance: input ? '' : state === 'stored' ? 'Use Start agent to connect this agent.' : 'Messages are unavailable for this agent.', retainedModel: settings.retainedModel || state !== 'live' && !!settings.model, retainedThinking: settings.retainedThinking || state !== 'live' && !!settings.thinking,
    tool: state === 'live' ? frameTool(frame) : undefined};
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
  if (['Stopped', 'Unavailable', 'Incompatible host', 'Session stopped'].includes(view.activity)) return '!';
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
