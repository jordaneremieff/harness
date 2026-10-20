import type {NoticeView, Target} from '../shared/api.ts';
import type {UiState} from './state.ts';

/** `times` is set only when identical notices for one conversation share the row. */
export type NoticeGroup = {items: NoticeView[]; level: NoticeView['level']; message: string; times?: number};
/** Resolves the conversation a notice names; undefined leaves the notice text as supplied. */
export type NoticeNamer = (target: Target) => string | undefined;
const severity = {info: 0, warning: 1, error: 2};
const targetKey = (target: Target) => target.kind === 'agent' ? `agent:${target.identity}` : `primary:${target.key}:${target.epoch}`;
function raise(group: NoticeGroup, level: NoticeView['level']): void {if (severity[level] > severity[group.level]) group.level = level;}
/** The row sentence: the conversation name when the notice has one, then the supplied text or its fixed summary. */
function noticeMessage(notice: NoticeView, nameOf?: NoticeNamer): string {
  const unavailable = notice.code === 'observation_unavailable', name = notice.target ? nameOf?.(notice.target) : undefined;
  if (!name) return unavailable ? 'The agent connection is unavailable.' : notice.message;
  return `${name}: ${unavailable ? 'the agent connection is unavailable.' : notice.message}`;
}
/** Only a notice with a target and a code can share a row, and only with the same displayed sentence. */
const mergeKey = (notice: NoticeView, message: string) => notice.target && notice.code ? JSON.stringify([notice.workspaceId, targetKey(notice.target), notice.code, message]) : undefined;
/** Group by the supplied diagnostic code, never by text or filename guesses. */
export function noticeGroups(notices: readonly NoticeView[], nameOf?: NoticeNamer): NoticeGroup[] {
  const groups: NoticeGroup[] = []; let refused: NoticeGroup | undefined; const merged = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    if (notice.code === 'state_record_refused') {
      if (!refused) {refused = {items: [], level: notice.level, message: ''}; groups.push(refused);}
      refused.items.push(notice); raise(refused, notice.level);
      continue;
    }
    const message = noticeMessage(notice, nameOf), key = mergeKey(notice, message), same = key ? merged.get(key) : undefined;
    if (same) {same.items.push(notice); same.times = same.items.length; raise(same, notice.level); continue;}
    const group: NoticeGroup = {items: [notice], level: notice.level, message}; groups.push(group);
    if (key) merged.set(key, group);
  }
  if (refused) refused.message = `${refused.items.length} saved ${refused.items.length === 1 ? 'record could' : 'records could'} not be read. The saved files remain unchanged.`;
  return groups;
}
/** The row text: the message, then the repeat count when notices were merged. */
export function noticeGroupText(group: NoticeGroup): string {return group.times ? `${group.message.replace(/\.$/u, '')} · ${group.times} times` : group.message;}
/** Only a current exact public target is a destination. Names and diagnostic text are not identities. */
export function noticeTarget(state: UiState, notice: NoticeView): Target | undefined {
  if (!state.workspace || notice.workspaceId && notice.workspaceId !== state.workspace.id || state.noticeShelf.get(notice.id) !== notice || state.dismissedNotices.has(notice.id)) return;
  const target = notice.target; if (!target) return;
  if (target.kind === 'agent') return state.roster.has(target.identity) ? target : undefined;
  const index = state.primaryIndex.find(item => item.key === target.key), view = state.primaries.get(target.key);
  if (index && index.epoch !== target.epoch || view && view.epoch !== target.epoch) return;
  return index || view ? target : undefined;
}
