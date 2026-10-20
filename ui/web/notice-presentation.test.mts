import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRow, NoticeView, Snapshot, Target} from '../shared/api.ts';
import {createState, dismissNotice, replaceSnapshot} from './state.ts';
import {noticeGroups, noticeGroupText, noticeTarget, type NoticeGroup} from './notice-presentation.ts';

const agent: AgentRow = {identity: 'exact-agent', storageId: 'storage', cwd: '/project', modifiedAt: 0, state: 'idle', owner: 'here', partial: false, name: 'Parser', availability: 'live'};
const target: Target = {kind: 'agent', identity: agent.identity};
const refused = (id: number, message: string): NoticeView => ({id: `boot:${id}`, code: 'state_record_refused', level: 'warning', message});
function snapshot(notices: NoticeView[]): Snapshot {
  return {bootId: 'boot', cursor: 'boot:20', workspace: {id: 'w', revision: 1}, primaries: [],
    roster: {rows: [agent], nextCursor: null, stale: false, scan: {state: 'ready', complete: true, visited: 1, skipped: 0, omitted: 0}},
    dialogs: [], pendingOperations: [], targetIndex: [], notices};
}

test('refused records group by native code and retain every exact cause, severity and original ID', () => {
  const one = refused(1, '/state/one: unsupported draft shape'), two = {...refused(3, '/state/two: malformed JSON'), level: 'error' as const};
  const ordinary: NoticeView = {id: 'boot:2', level: 'info', message: 'state_record_refused is literal text'};
  const groups = noticeGroups([one, ordinary, two]);
  assert.equal(groups.length, 2); assert.equal(groups[0]?.level, 'error');
  assert.equal(groups[0]?.message, '2 saved records could not be read. The saved files remain unchanged.');
  assert.deepEqual(groups[0]?.items, [one, two]); assert.equal(groups[0]?.items[0], one); assert.equal(groups[0]?.items[1], two);
  assert.deepEqual(groups[1]?.items, [ordinary]); assert.equal(groups[1]?.message, ordinary.message);
  assert.match(noticeGroups([one])[0]?.message ?? '', /^1 saved record could not/);
});

test('native unavailable summaries keep the full supplied diagnostic in their original record', () => {
  const notice: NoticeView = {id: 'boot:1', code: 'observation_unavailable', level: 'warning', target, message: 'Native endpoint rejected attach: ENOENT /endpoint.sock'};
  const group = noticeGroups([notice])[0]; assert.ok(group);
  assert.equal(group.message, 'The agent connection is unavailable.'); assert.equal(group.items[0], notice); assert.equal(group.items[0]?.message, notice.message);
});

test('group dismissal uses all original IDs and same-boot reconnect never repeats their causes', () => {
  const notices = [refused(1, 'first'), refused(2, 'second'), {id: 'boot:3', level: 'info' as const, message: 'Keep this'}];
  const first = notices[0]; assert.ok(first); const snap = snapshot([...notices, first]); let state = replaceSnapshot(createState(), snap);
  assert.equal(noticeGroups(state.notices)[0]?.items.length, 2);
  for (const notice of noticeGroups(state.notices)[0]?.items ?? []) state = dismissNotice(state, notice.id);
  assert.deepEqual([...state.dismissedNotices], ['boot:1', 'boot:2']);
  state = replaceSnapshot(state, {...snap, cursor: 'boot:21'});
  assert.deepEqual(state.notices.map(item => item.id), ['boot:3']); assert.equal(state.noticeShelf.size, 3);
});

test('notice destinations require exact current identities and never infer a name or UUID from text', () => {
  const notice: NoticeView = {...refused(1, 'Parser exact-agent'), target, workspaceId: 'w'};
  const state = replaceSnapshot(createState(), snapshot([notice])); assert.equal(noticeTarget(state, notice), target);
  assert.equal(noticeTarget(state, {...notice}), undefined);
  assert.equal(noticeTarget({...state, roster: new Map([['replacement', {...agent, identity: 'replacement'}]])}, notice), undefined);
  assert.equal(noticeTarget({...state, workspace: {id: 'other', revision: 1}}, notice), undefined);
  assert.equal(noticeTarget(dismissNotice(state, notice.id), notice), undefined);
  const textOnly = {...notice, id: 'boot:2', target: undefined};
  assert.equal(noticeTarget(replaceSnapshot(state, snapshot([textOnly])), textOnly), undefined);
  const restarted = replaceSnapshot(state, {...snapshot([notice]), bootId: 'next', cursor: 'next:1'});
  assert.equal(noticeTarget(restarted, notice), undefined);
});

test('Primary destinations reject old epochs even if the key and displayed name stay the same', () => {
  const exact: Target = {kind: 'primary', key: 'p', epoch: 2}; const notice = {...refused(1, 'Primary'), target: exact};
  const state = replaceSnapshot(createState(), {...snapshot([notice]), primaryIndex: [{key: 'p', epoch: 2, lifecycle: 'ready'}]});
  assert.equal(noticeTarget(state, notice), exact);
  assert.equal(noticeTarget({...state, primaryIndex: [{key: 'p', epoch: 3, lifecycle: 'ready'}]}, notice), undefined);
});

test('a targeted notice starts with its conversation name and an untargeted or unnamed one reads as supplied', () => {
  const named = (id: number, who: Target): NoticeView => ({id: `boot:${id}`, code: 'observation_unavailable', level: 'warning', target: who, message: 'Native diagnostic'});
  const other: NoticeView = {id: 'boot:9', code: 'save', level: 'error', message: 'Draft was not saved.', target};
  const plain: NoticeView = {id: 'boot:10', code: 'observation_unavailable', level: 'warning', message: 'Native diagnostic'};
  const nameOf = (who: Target) => who.kind === 'agent' && who.identity === agent.identity ? 'Parser' : undefined;
  const groups = noticeGroups([named(1, target), other, plain, named(2, {kind: 'agent', identity: 'unknown-agent'})], nameOf);
  assert.deepEqual(groups.map(group => group.message), ['Parser: the agent connection is unavailable.', 'Parser: Draft was not saved.', 'The agent connection is unavailable.', 'The agent connection is unavailable.']);
});

test('notices with one target and one code share a row with a count and keep every original item', () => {
  const make = (id: number, who: Target, code = 'observation_unavailable', level: NoticeView['level'] = 'warning'): NoticeView => ({id: `boot:${id}`, code, level, target: who, message: `Native diagnostic ${id}`});
  const another: Target = {kind: 'agent', identity: 'another-agent'};
  const first = make(1, target), second = make(2, target, 'observation_unavailable', 'error'), apart = make(3, another), differs = make(4, target, 'save');
  const groups = noticeGroups([first, apart, second, differs], who => who.kind === 'agent' ? who.identity : undefined);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0]?.items, [first, second]); assert.equal(groups[0]?.times, 2); assert.equal(groups[0]?.level, 'error');
  assert.equal(noticeGroupText(groups[0] as NoticeGroup), 'exact-agent: the agent connection is unavailable · 2 times');
  assert.equal(groups[1]?.times, undefined); assert.equal(noticeGroupText(groups[1] as NoticeGroup), 'another-agent: the agent connection is unavailable.');
  assert.deepEqual(groups[2]?.items, [differs]);
  let state = replaceSnapshot(createState(), snapshot([first, second]));
  for (const item of noticeGroups(state.notices)[0]?.items ?? []) state = dismissNotice(state, item.id);
  assert.deepEqual([...state.dismissedNotices], ['boot:1', 'boot:2']); assert.deepEqual(state.notices, []);
});

test('the refused-record group ignores names and targets', () => {
  const one = {...refused(1, 'first'), target}, two = {...refused(2, 'second'), target};
  const groups = noticeGroups([one, two], () => 'Parser');
  assert.equal(groups.length, 1); assert.equal(groups[0]?.message, '2 saved records could not be read. The saved files remain unchanged.');
  assert.equal(groups[0]?.times, undefined); assert.deepEqual(groups[0]?.items, [one, two]);
});
