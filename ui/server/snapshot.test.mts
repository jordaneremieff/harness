import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS, type AgentRow, type Bootstrap, type DialogView, type OperationView, type PrimaryView, type Snapshot, type TargetState, type UnconfirmedInput } from '../shared/api.ts';
import { budgetSnapshot } from './snapshot.mts';

function primary(key: string, lifecycle: PrimaryView['lifecycle'] = 'stopped'): PrimaryView {
  return {key, epoch: 1, cwd: '/project', lifecycle, activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {input: lifecycle === 'ready'}};
}
function target(key: string, text = ''): TargetState {
  return {targetKey: key, target: {kind: 'primary', key, epoch: 1}, draft: {revision: 2, text, mode: 'prompt', persisted: true, images: []},
    reading: {revision: 1, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: [], retainedInputs: [], imageAvailability: []};
}
function operation(id: string, payload = ''): OperationView {
  return {id, kind: 'primary.input', target: {kind: 'primary', key: 'p', epoch: 1}, state: 'uncertain', createdAt: 'date', updatedAt: 'date',
    error: {code: 'delivery_uncertain', message: payload, retry: 'manual'}};
}
function row(identity: string, latestReply = ''): AgentRow {
  return {identity, storageId: identity, cwd: '/project', modifiedAt: 1, state: 'idle', owner: 'unknown', availability: 'stored', partial: false, latestReply};
}
function snapshot(): Snapshot {
  return {bootId: 'boot', cursor: 'boot:123', workspace: {id: 'workspace', revision: 7, primaryKey: 'p'}, primaries: [],
    roster: {rows: [], scan: {state: 'ready', complete: true, visited: 3, skipped: 0, omitted: 0}, stale: false}, dialogs: [], pendingOperations: []};
}
function bounded(value: Snapshot) {
  const bytes = Buffer.byteLength(JSON.stringify({ok: true, data: value}));
  assert.ok(bytes <= LIMITS.displayBytes, `${bytes} exceeds ${LIMITS.displayBytes}`); return bytes;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const field of Object.values(value)) freeze(field); Object.freeze(value);
}

test('small snapshots preserve the authoritative cut, workspace, indexes, and exact state without mutation', () => {
  const source = snapshot(); source.primaries = [primary('p', 'ready')]; source.targets = [target('p', 'unchanged draft')];
  source.pendingOperations = [operation('operation')]; source.roster.rows = [row('agent')]; source.roster.nextCursor = 'actual-cursor';
  const before = JSON.stringify(source); freeze(source); const result = budgetSnapshot(source); bounded(result);
  assert.equal(JSON.stringify(source), before); assert.deepEqual(result.workspace, source.workspace); assert.equal(result.cursor, source.cursor);
  assert.deepEqual(result.primaryIndex, [{key: 'p', epoch: 1, lifecycle: 'ready'}]); assert.deepEqual(result.operationIndex, ['operation']);
  assert.deepEqual(result.targetIndex, [{targetKey: 'p', target: source.targets[0]?.target, draftRevision: 2, hasDraft: true, draftPreview: 'unchanged draft', draftPreviewTruncated: false, unconfirmedOperationIds: [], retainedInputOperationIds: []}]);
  assert.deepEqual(result.targets, source.targets); assert.equal(result.omitted, undefined); assert.equal(result.roster.nextCursor, 'actual-cursor');
});

test('image-only drafts and refused-copy IDs survive whole-target snapshot omission', () => {
  const source = snapshot(), state = target('p');
  state.draft.images = [{digest: 'a'.repeat(64), mimeType: 'image/png', bytes: 100, width: 1, height: 1, name: 'pixel.png'}];
  state.retainedInputs = [{operationId: 'refused', target: state.target, text: '\u0000'.repeat(LIMITS.textBytes), mode: 'prompt', images: state.draft.images, submittedDraftRevision: 1, createdAt: 'date', reason: 'Refused', admission: 'refused', error: {code: 'unsupported', message: 'Refused', retry: 'none'}}];
  source.targets = [state]; const result = budgetSnapshot(source); bounded(result);
  assert.deepEqual(result.targets, []); assert.ok(result.omitted?.includes('targets'));
  assert.equal(result.targetIndex?.[0]?.hasDraft, true); assert.deepEqual(result.targetIndex?.[0]?.retainedInputOperationIds, ['refused']);
  state.recoveryPreviewTruncated = true;
  assert.throws(() => budgetSnapshot(source), {code: 'capacity'});
  source.targetIndex = result.targetIndex;
  assert.deepEqual(budgetSnapshot(source).targetIndex, result.targetIndex);
});

test('bootstrap budgeting retains limits and launch path along with stable existing indexes', () => {
  const source: Bootstrap = {...snapshot(), limits: LIMITS, launchCwd: `/project/${'界'.repeat(1000)}`};
  source.primaryIndex = [{key: 'not-inline', epoch: 4, lifecycle: 'stopped'}]; source.operationIndex = ['not-inline'];
  source.targetIndex = [{targetKey: 'not-inline', target: {kind: 'agent', identity: 'agent'}, draftRevision: 9, hasDraft: true, unconfirmedOperationIds: ['copy'], retainedInputOperationIds: ['retained']}];
  const result = budgetSnapshot(source); bounded(result); assert.equal(result.limits, LIMITS); assert.equal(result.launchCwd, source.launchCwd);
  assert.deepEqual(result.primaryIndex, source.primaryIndex); assert.deepEqual(result.operationIndex, source.operationIndex); assert.deepEqual(result.targetIndex, source.targetIndex);
});

test('large saved primary lists admit the active view before other live views and stopped views', () => {
  const source = snapshot(); source.workspace.primaryKey = 'p127';
  source.primaries = Array.from({length: 128}, (_, i) => ({...primary(`p${i}`, i >= 125 ? 'ready' : 'stopped'), cwd: `/${'x'.repeat(4095)}`, sessionFile: `/${'y'.repeat(4095)}`}));
  const result = budgetSnapshot(source); bounded(result);
  assert.deepEqual(result.primaries.slice(0, 3).map(view => view.key), ['p127', 'p125', 'p126']);
  assert.ok(result.primaries.length < 128); assert.ok(result.omitted?.includes('primaries'));
  assert.deepEqual(result.primaryIndex?.map(view => view.key), source.primaries.map(view => view.key));
});

test('two maximum drafts remain exact when both complete targets fit', () => {
  const source = snapshot(); source.primaries = [primary('p', 'ready')];
  const agent = target('agent', '😀'.repeat(LIMITS.textBytes / 4)); agent.target = {kind: 'agent', identity: 'agent'};
  source.targets = [target('p', 'x'.repeat(LIMITS.textBytes)), agent];
  const result = budgetSnapshot(source); bounded(result); assert.equal(result.targets?.length, 2);
  assert.deepEqual(result.targets, source.targets); assert.ok(!result.omitted?.includes('targets'));
});

test('JSON-escaped maximum drafts are omitted whole, never shortened or replaced with empty text', () => {
  const source = snapshot(); source.targets = [target('large', '\u0000'.repeat(LIMITS.textBytes)), target('small', 'still exact')];
  const result = budgetSnapshot(source); bounded(result);
  assert.deepEqual(result.targets, [source.targets[1]]); assert.ok(result.omitted?.includes('targets'));
  assert.deepEqual(result.targetIndex?.map(state => [state.targetKey, state.hasDraft]), [['large', true], ['small', true]]);
  assert.equal(source.targets[0]?.draft.text.length, LIMITS.textBytes);
});

test('a target with 128 large unconfirmed copies keeps every copy ID without scanning every text', () => {
  const source = snapshot(); const state = target('p'); let reads = 0;
  state.unconfirmed = Array.from({length: 128}, (_, i): UnconfirmedInput => {
    const copy = {operationId: `copy${i}`, target: state.target, text: '', mode: 'prompt', images: [], submittedDraftRevision: 1, createdAt: 'date', reason: 'uncertain'};
    Object.defineProperty(copy, 'text', {enumerable: true, get() { reads++; return 'x'.repeat(LIMITS.textBytes); }}); return copy;
  });
  source.targets = [state]; const result = budgetSnapshot(source); bounded(result);
  assert.deepEqual(result.targets, []); assert.ok(result.omitted?.includes('targets')); assert.ok(reads < 128);
  assert.deepEqual(result.targetIndex?.[0]?.unconfirmedOperationIds, state.unconfirmed.map(copy => copy.operationId));
});

test('large selected pages and frames are optional and do not displace exact drafts', () => {
  const source = snapshot(); source.targets = [target('p', 'x'.repeat(LIMITS.textBytes))];
  const entry = {id: 'entry', kind: 'custom', data: {value: '界'.repeat(LIMITS.textBytes), truncated: false}};
  source.selectedPage = {target: {kind: 'primary', key: 'p', epoch: 1}, items: [entry, entry], nextCursor: 'real-page-cursor', coverage: {complete: true, truncated: false, omitted: 0}};
  source.observations = [{identity:'agent',connectionEpoch:1,frame:{revision: 3, observedAt: 'date', entries: [entry, entry], live: [], nextBefore: null, status: {busy: true}, coverage: {complete: true, truncated: false, omitted: 0}}}];
  const result = budgetSnapshot(source); bounded(result); assert.deepEqual(result.targets, source.targets);
  assert.equal(result.selectedPage, undefined); assert.deepEqual(result.observations,[{identity:'agent',connectionEpoch:1,omitted:true}]);
  assert.ok(result.omitted?.includes('selectedPage')); assert.ok(result.omitted?.includes('observations'));
});

test('all 128 operation IDs survive and bounded notices reserve space before large operation payloads', () => {
  const source = snapshot(); source.pendingOperations = Array.from({length: 128}, (_, i) => operation(`op${i}`, 'x'.repeat(LIMITS.textBytes)));
  source.notices = Array.from({length: 32}, (_, i) => ({id: `notice${i}`, level: 'warning', message: `Notice ${i} ${'x'.repeat(300)}`}));
  const result = budgetSnapshot(source); bounded(result); assert.deepEqual(result.notices, source.notices);
  assert.deepEqual(result.operationIndex, source.pendingOperations.map(op => op.id)); assert.ok(result.pendingOperations.length < 128);
  assert.ok(result.omitted?.includes('pendingOperations')); assert.ok(!result.omitted?.includes('notices'));
});

test('a roster page stays whole with its real cursor or is omitted with no fabricated continuation', () => {
  const source = snapshot(); source.targets = [target('p', 'x'.repeat(LIMITS.textBytes))];
  source.roster.rows = Array.from({length: 4}, (_, i) => row(`agent${i}`, 'x'.repeat(LIMITS.textBytes))); source.roster.nextCursor = 'real-after-four';
  const result = budgetSnapshot(source); bounded(result); assert.deepEqual(result.roster.rows, []);
  assert.ok(result.omitted?.includes('roster')); assert.equal(result.roster.nextCursor, undefined); assert.equal(source.roster.nextCursor, 'real-after-four');
  const small = snapshot(); small.roster.rows = [row('small')]; small.roster.nextCursor = 'real-after-one';
  const kept = budgetSnapshot(small); bounded(kept); assert.deepEqual(kept.roster.rows, small.roster.rows); assert.equal(kept.roster.nextCursor, 'real-after-one');
});

test('pure concurrent observation indexes survive omitted roster pages and oversized frames with exact drafts', () => {
  const source = snapshot(); source.workspace.selectedTarget = {kind:'agent',identity:'beyond-first-page'};
  source.targets = [target('p','x'.repeat(LIMITS.textBytes)),target('agent','y'.repeat(LIMITS.textBytes))];
  source.roster.rows = Array.from({length:4},(_,i)=>row(`first-page${i}`,'z'.repeat(LIMITS.textBytes)));source.roster.nextCursor='actual-first-page-end';
  const entry={id:'entry',kind:'custom',data:{value:'z'.repeat(LIMITS.displayBytes),truncated:false}};
  source.observations=Array.from({length:4},(_,i)=>({identity:`beyond-page-${i}`,connectionEpoch:i+1,frame:{revision:1,observedAt:'date',entries:[entry],live:[],nextBefore:null,status:{busy:true},coverage:{complete:true,truncated:false,omitted:0}}}));
  freeze(source);const result=budgetSnapshot(source);bounded(result);
  assert.deepEqual(result.targets,source.targets);assert.deepEqual(result.workspace,source.workspace);
  assert.deepEqual(result.observations,source.observations.map(({identity,connectionEpoch})=>({identity,connectionEpoch,omitted:true})));
  assert.ok(result.omitted?.includes('observations'));assert.ok(result.omitted?.includes('roster'));assert.equal(source.roster.nextCursor,'actual-first-page-end');
});
test('pure concurrent optional frames share one display budget and do not alter authentic roster pagination',()=> {
  const source=snapshot();source.roster.rows=[row('first')];source.roster.nextCursor='actual-after-first';
  const entry={id:'entry',kind:'custom',data:{value:'x'.repeat(Math.floor(LIMITS.displayBytes/3)),truncated:false}};
  source.observations=Array.from({length:4},(_,i)=>({identity:`agent${i}`,connectionEpoch:i+1,frame:{revision:i,observedAt:'date',entries:[entry],live:[],nextBefore:null,status:{busy:false},coverage:{complete:true,truncated:false,omitted:0}}}));
  const result=budgetSnapshot(source);bounded(result);
  assert.equal(result.observations?.length,4);assert.equal(result.observations?.filter(value=>value.frame).length,2);
  assert.ok(result.observations?.slice(2).every(value=>value.omitted===true));assert.deepEqual(result.roster.rows,source.roster.rows);assert.equal(result.roster.nextCursor,'actual-after-first');
  const second=budgetSnapshot(result);bounded(second);assert.deepEqual(second.observations,result.observations);
});
test('pure concurrent unobserved targets keep epoch zero and the fifth observation refuses explicitly',()=> {
  const source=snapshot();source.observations=[{identity:'visible',connectionEpoch:0,omitted:true}];
  const result=budgetSnapshot(source);bounded(result);assert.deepEqual(result.observations,source.observations);
  assert.ok(result.omitted?.includes('observations'));
  source.observations=Array.from({length:5},(_,i)=>({identity:`agent${i}`,connectionEpoch:0,omitted:true}));
  assert.throws(()=>budgetSnapshot(source),{code:'capacity'});
});

test('oversized optional roster diagnostics do not displace authoritative core state', () => {
  const source = snapshot(); source.roster.rows = [row('agent')]; source.roster.nextCursor = 'actual-cursor';
  source.roster.error = {code: 'host_unavailable', message: 'Catalog unavailable', retry: 'read', details: {value: 'x'.repeat(LIMITS.displayBytes), truncated: false}};
  const result = budgetSnapshot(source); bounded(result); assert.deepEqual(result.workspace, source.workspace);
  assert.deepEqual(result.roster.rows, []); assert.equal(result.roster.error, undefined); assert.equal(result.roster.nextCursor, undefined);
  assert.ok(result.omitted?.includes('roster')); assert.deepEqual(result.roster.scan, source.roster.scan);
});

test('duplicate global dialogs are explicitly omitted while independent dialogs remain available', () => {
  const source = snapshot(); const duplicate: DialogView = {id: 'same', method: 'confirm', title: 'Confirm'};
  source.primaries = [{...primary('p', 'ready'), pendingDialogs: [duplicate]}]; source.dialogs = [duplicate, {id: 'other', method: 'input', title: 'Other'}];
  const result = budgetSnapshot(source); bounded(result); assert.deepEqual(result.primaries[0]?.pendingDialogs, [duplicate]);
  assert.deepEqual(result.dialogs, [source.dialogs[1]]); assert.ok(result.omitted?.includes('dialogs')); assert.equal(source.dialogs.length, 2);
});

test('Unicode, control escapes, and lone surrogates use actual UTF-8 JSON bytes under pressure', () => {
  for (const text of ['界', '😀', '\n', '\t', '\u0000', '"', '\\', '\ud800']) {
    const source = snapshot(); source.targets = [target('p', text.repeat(40000))];
    source.pendingOperations = Array.from({length: 8}, (_, i) => operation(`op${i}`, text.repeat(40000)));
    const result = budgetSnapshot(source); bounded(result);
    for (const state of result.targets ?? []) assert.equal(state.draft.text, source.targets[0]?.draft.text);
  }
});

test('the budget counts item JSON incrementally and never stringifies a whole cache', context => {
  const original = JSON.stringify; const source = snapshot(); source.primaries = Array.from({length: 128}, (_, i) => primary(`p${i}`));
  source.targets = [target('p', 'x'.repeat(LIMITS.textBytes))];
  context.mock.method(JSON, 'stringify', (value: unknown) => {
    assert.ok(value === null || typeof value !== 'object', 'whole cache serialization is forbidden'); return original(value);
  });
  const result = budgetSnapshot(source); context.mock.restoreAll(); bounded(result);
});

test('repeat budgeting preserves complete indexes and prior omission markers', () => {
  const source = snapshot(); source.targets = [target('p', '\u0000'.repeat(LIMITS.textBytes))];
  const first = budgetSnapshot(source); const second = budgetSnapshot(first); bounded(second);
  assert.deepEqual(second.targetIndex, first.targetIndex); assert.deepEqual(second.primaryIndex, first.primaryIndex);
  assert.deepEqual(second.operationIndex, first.operationIndex); assert.deepEqual(second.omitted, first.omitted);
});

test('an oversized mandatory index rejects explicitly instead of deleting authoritative core state', () => {
  const source = snapshot(); source.workspace.id = 'x'.repeat(LIMITS.displayBytes);
  assert.throws(() => budgetSnapshot(source), {code: 'payload_too_large', status: 413});
});
