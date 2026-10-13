import type {NoticeView, Target} from '../shared/api.ts';
import type {UiState} from './state.ts';

export type NoticeGroup = {items: NoticeView[]; level: NoticeView['level']; message: string};
/** Group by the supplied diagnostic code, never by text or filename guesses. */
export function noticeGroups(notices: readonly NoticeView[]): NoticeGroup[] {
  const groups: NoticeGroup[] = []; let refused: NoticeGroup | undefined;
  const severity = {info: 0, warning: 1, error: 2};
  for (const notice of notices) {
    if (notice.code !== 'state_record_refused') {
      groups.push({items: [notice], level: notice.level, message: notice.code === 'observation_unavailable' ? 'The agent connection is unavailable.' : notice.message});
      continue;
    }
    if (!refused) {refused = {items: [], level: notice.level, message: ''}; groups.push(refused);}
    refused.items.push(notice);
    if (severity[notice.level] > severity[refused.level]) refused.level = notice.level;
  }
  if (refused) refused.message = `${refused.items.length} saved ${refused.items.length === 1 ? 'record could' : 'records could'} not be read. The saved files remain unchanged.`;
  return groups;
}
/** Only a current exact public target is a destination. Names and diagnostic text are not identities. */
export function noticeTarget(state: UiState, notice: NoticeView): Target | undefined {
  if (!state.workspace || notice.workspaceId && notice.workspaceId !== state.workspace.id || state.noticeShelf.get(notice.id) !== notice || state.dismissedNotices.has(notice.id)) return;
  const target = notice.target; if (!target) return;
  if (target.kind === 'agent') return state.roster.has(target.identity) ? target : undefined;
  const index = state.primaryIndex.find(item => item.key === target.key), view = state.primaries.get(target.key);
  if (index && index.epoch !== target.epoch || view && view.epoch !== target.epoch) return;
  return index || view ? target : undefined;
}
