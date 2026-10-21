import type {AgentRow, PrimaryView, ProjectedFrame, ResponseOutcome} from '../shared/api.ts';
import {responseOutcome} from './conversation-presentation.ts';

export type Attention = {label: 'Question' | 'Blocked' | 'Failed' | 'Not reachable'; tone: 'warning' | 'error'; title?: string};
export type AttentionSource = {connected: boolean; primary?: PrimaryView; question?: boolean; agent?: {live: boolean; connectionError?: string; frame?: ProjectedFrame}; outcome?: ResponseOutcome; catalog?: AgentRow['attention']};
function catalogAttention(hint: AgentRow['attention']): Attention | undefined {
  if (!hint) return;
  if (hint.kind === 'failed-turn') return {label: 'Failed', tone: 'error'};
  const reasons = {missing_task: 'A task is missing', task_too_old: 'A task is too old to resume', migration_failed: 'A task could not be migrated'};
  return {label: 'Blocked', tone: 'warning', ...(hint.kind === 'task-blocked' && hint.reason ? {title: reasons[hint.reason]} : {})};
}
/** A current live frame takes precedence over an exact-identity published hint. */
export function conversationAttention(source: AttentionSource): Attention | undefined {
  if (!source.connected) return;
  if (source.primary) {
    if (source.question) return {label: 'Question', tone: 'warning'};
    if (source.primary.lifecycle === 'ready' && source.primary.activity === 'idle' && source.outcome === 'failed') return {label: 'Failed', tone: 'error'};
    return;
  }
  const agent = source.agent;
  if (agent?.connectionError) return {label: 'Not reachable', tone: 'warning'};
  if (!agent?.live || !agent.frame) return catalogAttention(source.catalog);
  if (agent.frame.status.providerBlock) return {label: 'Blocked', tone: 'warning'};
  if (agent.frame.status.busy) return;
  if (responseOutcome(agent.frame.entries) === 'failed') return {label: 'Failed', tone: 'error'};
}
export function attentionCounts(states: readonly {attention?: Attention; working: boolean}[]): string {
  const need = states.filter(state => state.attention).length;
  const working = states.filter(state => !state.attention && state.working).length;
  return [need ? `${need} need you` : '', working ? `${working} working` : ''].filter(Boolean).join(' · ');
}
