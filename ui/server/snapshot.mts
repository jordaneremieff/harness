import { LIMITS, type Bootstrap, type Snapshot, type SnapshotSection, type TargetState } from '../shared/api.ts';
import { ApiError } from './errors.mts';

const SECTIONS: SnapshotSection[] = ['notices', 'targets', 'selectedPage', 'selectedFrame', 'primaries', 'roster', 'pendingOperations', 'dialogs'];
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ok: true, data: null})) - 4;
const MAX_BYTES = LIMITS.displayBytes - ENVELOPE_BYTES;
const ROSTER_CONTAINER_BYTES = Buffer.byteLength(JSON.stringify({rows: []}));

/** Count JSON DTO bytes without constructing a serialized cache or scanning past the bound. */
function jsonBytes(value: unknown, limit: number): number {
  let bytes = 0;
  const object = (item: object): void => {
    bytes += 2; let count = 0;
    for (const key of Object.keys(item)) {
      if (bytes > limit) break;
      const field: unknown = Reflect.get(item, key);
      if (field === undefined || typeof field === 'function' || typeof field === 'symbol') continue;
      if (count++) bytes++;
      bytes += Buffer.byteLength(JSON.stringify(key)) + 1; visit(field);
    }
  };
  const array = (items: unknown[]): void => {
    bytes += 2;
    for (let i = 0; i < items.length && bytes <= limit; i++) { if (i) bytes++; visit(items[i]); }
  };
  const visit = (item: unknown): void => {
    if (bytes > limit) return;
    if (item === null || typeof item !== 'object') {
      const encoded = JSON.stringify(item); bytes += encoded === undefined ? 4 : Buffer.byteLength(encoded); return;
    }
    if (Array.isArray(item)) array(item); else object(item);
  };
  visit(value); return bytes;
}
class Budget {
  private used: number;
  constructor(core: Snapshot | Bootstrap) {
    this.used = jsonBytes(core, MAX_BYTES);
    if (this.used > MAX_BYTES) throw new ApiError('payload_too_large', 'The snapshot index exceeds the display bound.', 413);
  }
  take(value: unknown, overhead = 0) {
    const available = MAX_BYTES - this.used - overhead;
    if (available < 0) return false;
    const bytes = jsonBytes(value, available);
    if (bytes > available) return false;
    this.used += bytes + overhead; return true;
  }
  array<T>(source: readonly T[], destination: T[]) {
    for (const item of source) if (this.take(item, destination.length ? 1 : 0)) destination.push(item);
    return destination.length === source.length;
  }
  roster(source: Snapshot['roster']) {
    const available = MAX_BYTES - this.used;
    const payload = {rows: source.rows, nextCursor: source.nextCursor, error: source.error};
    const bytes = jsonBytes(payload, available + ROSTER_CONTAINER_BYTES) - ROSTER_CONTAINER_BYTES;
    if (bytes > available) return false;
    this.used += bytes; return true;
  }
  optional(key: string, value: unknown) { return this.take(value, Buffer.byteLength(JSON.stringify(key)) + 2); }
}
function targetIndex(targets: readonly TargetState[]) {
  return targets.map(state => ({targetKey: state.targetKey, target: state.target, draftRevision: state.draft.revision,
    hasDraft: state.draft.text.length > 0, unconfirmedOperationIds: state.unconfirmed.map(input => input.operationId)}));
}
function priorities(snapshot: Snapshot) {
  const active = snapshot.primaries.filter(view => view.key === snapshot.workspace.primaryKey);
  const others = snapshot.primaries.filter(view => view.key !== snapshot.workspace.primaryKey);
  const stopped = (view: Snapshot['primaries'][number]) => view.lifecycle === 'stopped' || view.lifecycle === 'failed';
  return [...active, ...others.filter(view => !stopped(view)), ...others.filter(stopped)];
}
function optionalPages(source: Snapshot, result: Snapshot, budget: Budget, omitted: Set<SnapshotSection>) {
  if (source.selectedPage !== undefined) {
    if (budget.optional('selectedPage', source.selectedPage)) result.selectedPage = source.selectedPage;
    else omitted.add('selectedPage');
  }
  if (source.selectedFrame !== undefined) {
    if (budget.optional('selectedFrame', source.selectedFrame)) result.selectedFrame = source.selectedFrame;
    else omitted.add('selectedFrame');
  }
}

/** Selected-agent metadata is core state, independent of the containing roster page. */
function emptySnapshot(snapshot: Snapshot | Bootstrap): Snapshot | Bootstrap {
  const {primaries, targets, pendingOperations, dialogs: _dialogs, roster, selectedPage: _page, selectedFrame: _frame, notices, omitted: _omitted, ...core} = snapshot;
  const result: Snapshot = {...core, primaryIndex: snapshot.primaryIndex ?? primaries.map(({key, epoch, lifecycle}) => ({key, epoch, lifecycle})),
    operationIndex: snapshot.operationIndex ?? pendingOperations.map(operation => operation.id),
    targetIndex: snapshot.targetIndex ?? targetIndex(targets ?? []), omitted: [...SECTIONS], primaries: [], pendingOperations: [], dialogs: [],
    roster: {...roster, rows: [], nextCursor: undefined, error: undefined}, ...(targets === undefined ? {} : {targets: []}), ...(notices === undefined ? {} : {notices: []})};
  return 'limits' in snapshot ? {...result, limits: snapshot.limits, launchCwd: snapshot.launchCwd} : result;
}

/** Exact drafts and complete indexes survive omission; omitted sections require separate reads. */
export function budgetSnapshot(snapshot: Bootstrap): Bootstrap;
export function budgetSnapshot(snapshot: Snapshot): Snapshot;
export function budgetSnapshot(snapshot: Snapshot | Bootstrap): Snapshot | Bootstrap {
  const {targets, pendingOperations, dialogs, roster, notices} = snapshot;
  const result = emptySnapshot(snapshot);
  const budget = new Budget(result); const omitted = new Set(snapshot.omitted);
  // Notices reserve their space before large state and transcript sections compete for it.
  if (notices && !budget.array(notices, result.notices ?? [])) omitted.add('notices');
  if (!budget.array(priorities(snapshot), result.primaries)) omitted.add('primaries');
  if (targets && !budget.array(targets, result.targets ?? [])) omitted.add('targets');
  if (!budget.array(pendingOperations, result.pendingOperations)) omitted.add('pendingOperations');
  // A shortened roster page has no authentic continuation cursor. Reload it from its first page.
  if (budget.roster(roster)) result.roster = {...roster, rows: [...roster.rows]};
  else omitted.add('roster');
  const represented = new Set(result.primaries.flatMap(view => view.pendingDialogs.map(dialog => dialog.id)));
  const unique = dialogs.filter(dialog => !represented.has(dialog.id));
  const dialogsComplete = budget.array(unique, result.dialogs);
  if (unique.length !== dialogs.length || !dialogsComplete) omitted.add('dialogs');
  optionalPages(snapshot, result, budget, omitted);
  if (omitted.size) result.omitted = SECTIONS.filter(section => omitted.has(section)); else delete result.omitted;
  return result;
}
