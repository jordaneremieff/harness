import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../shared/api.ts';
import type { Appearance, DraftView, EventData, EventName, OperationView, PresentationView, PrimaryView, ReadingView, Target, TargetIndex, TargetState, UnconfirmedInput, Workspace } from '../shared/api.ts';

import { safeText } from './projection.mts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT = 'ui-state/1';
export type ChangeHook = (name: EventName, data: EventData[EventName], workspaceId?: string, target?: Target) => void;
export type OperationMetadata = {view: Pick<OperationView, 'id' | 'kind' | 'target' | 'state' | 'createdAt' | 'updatedAt'>; workspaceId: string; input?: true; inputResolved?: boolean};
export type OperationRecord = { view: OperationView; workspaceId: string; digest?: string; input?: UnconfirmedInput & {targetKey: string}; inputResolved?: boolean };
type StoredTarget = Omit<TargetState, 'unconfirmed'> & {workspaceId: string};

export class StateError extends Error {
  readonly retry: 'none' | 'read' | 'manual';
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message); this.code = code; this.status = status; this.details = details;
    this.name = 'StateError'; this.retry = code === 'stale_revision' ? 'read' : code === 'capacity' ? 'manual' : 'none';
  }
}
export function sameTarget(a?: Target, b?: Target): boolean {
  return a?.kind === b?.kind && (a?.kind === 'primary' && b?.kind === 'primary' ? a.key === b.key && a.epoch === b.epoch : a?.kind === 'agent' && b?.kind === 'agent' ? a.identity === b.identity : a === b);
}
export function validateTarget(target: Target): void {
  if (!target || (target.kind !== 'primary' && target.kind !== 'agent')) throw new StateError('invalid_request', 'Invalid target');
  const allowed = target.kind === 'primary' ? ['kind', 'key', 'epoch'] : ['kind', 'identity'];
  if (Object.keys(target).some(key => !allowed.includes(key))) throw new StateError('invalid_request', 'Unknown target field');
  const id = target.kind === 'primary' ? target.key : target.identity;
  if (typeof id !== 'string' || !id.length || id.length > LIMITS.idChars || /[\x00-\x1f]/.test(id)) throw new StateError('invalid_request', 'Invalid target identity');
  if (target.kind === 'primary' && (!Number.isSafeInteger(target.epoch) || target.epoch < 0)) throw new StateError('invalid_request', 'Invalid target epoch');
}
function revision(actual: number, expected: number, current: unknown): void {
  if (!Number.isSafeInteger(expected) || expected !== actual) throw new StateError('stale_revision', 'The saved revision changed', 409, current);
}
function validateText(text: string): void {
  if (typeof text !== 'string') throw new StateError('invalid_request', 'Text must be a string');
  if (Buffer.byteLength(text) > LIMITS.textBytes) throw new StateError('payload_too_large', 'Text exceeds the saved text limit', 413);
}
function validateMode(mode: string): void {
  if (!['prompt', 'steer', 'followUp'].includes(mode)) throw new StateError('invalid_request', 'Invalid input mode');
}
async function readJson(path: string, bound: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > bound) throw new StateError('capacity', 'Saved state exceeds its file limit', 429);
    await file.chmod(0o600);
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > bound) throw new StateError('capacity', 'Saved state exceeds its file limit', 429);
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
}

type SelectionInput = {expectedRevision: number; primaryKey?: string; selectedTarget?: Target | null; panelVisible?: boolean; appearance?: Appearance};
function validateSelection(input: SelectionInput): void {
      if (input.selectedTarget) validateTarget(input.selectedTarget);
      if (input.primaryKey !== undefined && (typeof input.primaryKey !== 'string' || input.primaryKey.length > 256)) throw new StateError('invalid_request', 'Invalid primary key');
      if (input.panelVisible !== undefined && typeof input.panelVisible !== 'boolean') throw new StateError('invalid_request', 'Invalid panel visibility');
      if (input.appearance !== undefined && !['dark', 'light', 'system'].includes(input.appearance)) throw new StateError('invalid_request', 'Invalid appearance');
      const allowed = ['expectedRevision', 'primaryKey', 'selectedTarget', 'panelVisible', 'appearance'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new StateError('invalid_request', 'Unknown workspace field');
}
function selectedWorkspace(current: Workspace, input: SelectionInput): Workspace {
      const value: Workspace = {...current, revision: current.revision + 1};
      if (input.primaryKey !== undefined) value.primaryKey = input.primaryKey;
      if (input.panelVisible !== undefined) value.panelVisible = input.panelVisible;
      if (input.appearance !== undefined) value.appearance = input.appearance;
      if (input.selectedTarget === null) delete value.selectedTarget;
      else if (input.selectedTarget !== undefined) value.selectedTarget = structuredClone(input.selectedTarget);
  return value;
}

export class StateStore {
  readonly root: string;
  instanceId = '';
  private readonly owner = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private workspaces = new Map<string, Workspace>();
  private targetRecords = new Map<string, StoredTarget>();
  private operationRecords = new Map<string, OperationRecord>();
  private operationBytes = 0;
  private readonly operationSizes = new Map<string, number>();
  private unconfirmedCount = 0;
  private readonly inputPreviews = new Map<string, UnconfirmedInput & {targetKey: string; workspaceId: string}>();
  private primaries: PrimaryView[] = [];
  private onChange?: ChangeHook;
  private constructor(root: string, onChange?: ChangeHook) { this.root = resolve(root); this.onChange = onChange; }

  static async open(root: string, options: {recoverDeadLock?: boolean; onChange?: ChangeHook} = {}): Promise<StateStore> {
    const store = new StateStore(root, options.onChange);
    await mkdir(store.root, {recursive: true, mode: 0o700});
    const info = await lstat(store.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StateError('not_ready', 'State root must be a private directory', 503);
    await chmod(store.root, 0o700);
    for (const name of ['workspaces', 'targets', 'operations']) {
      const dir = join(store.root, name); await mkdir(dir, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('not_ready', 'State subdirectory is not a directory', 503);
      await chmod(dir, 0o700);
    }
    await store.acquireLock(options.recoverDeadLock === true);
    try { await store.initialize(); return store; }
    catch (error) { await store.releaseLock(); throw error; }
  }
  private async initialize(): Promise<void> {
      try {
        const value = await readJson(join(this.root, 'instance.json'), 1024) as {format: string; id: string};
        if (value.format !== FORMAT || !UUID.test(value.id)) throw new StateError('not_ready', 'Unsupported state format', 503);
        this.instanceId = value.id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.instanceId = randomUUID(); await this.atomic('instance.json', {format: FORMAT, id: this.instanceId}, 1024);
      }
      await this.load('workspaces', LIMITS.workspaces, 8192, value => {
        const record = value as Workspace;
        if (!UUID.test(record.id) || !Number.isSafeInteger(record.revision)) throw new StateError('not_ready', 'Invalid saved workspace', 503);
        this.workspaces.set(record.id, record);
      });
      await this.load('targets', LIMITS.targets, 96 * 1024, value => {
        const record = value as StoredTarget; validateTarget(record.target);
        if (!UUID.test(record.targetKey) || !this.workspaces.has(record.workspaceId)) throw new StateError('not_ready', 'Invalid saved target', 503);
        validateText(record.draft.text); validateMode(record.draft.mode); this.targetRecords.set(record.targetKey, record);
      });
      let operationBytes = 0;
      await this.load('operations', LIMITS.operations, 128 * 1024, value => {
        const record = value as OperationRecord;
        if (!UUID.test(record.view.id) || !this.workspaces.has(record.workspaceId)) throw new StateError('not_ready', 'Invalid saved operation', 503);
        operationBytes += Buffer.byteLength(JSON.stringify(record));
        if (operationBytes > 32 * 1024 * 1024) throw new StateError('capacity', 'Saved operation store exceeds its limit', 429);
        this.operationRecords.set(record.view.id, record); this.operationBytes = operationBytes;
        this.operationSizes.set(record.view.id, Buffer.byteLength(JSON.stringify(record)));
        if (record.input && !record.inputResolved) this.unconfirmedCount++;
        this.cacheInput(record);
      });
      for (const record of this.operationRecords.values()) {
        if (record.view.state === 'dispatched') {
          record.view.state = 'uncertain'; record.view.updatedAt = new Date().toISOString();
          record.view.error = {code: 'delivery_uncertain', message: 'Backend restarted before a receipt arrived', retry: 'manual'};
          if (record.input) record.input.reason = 'Backend restarted before a receipt arrived';
          await this.writeOperation(record);
        }
      }
      try { this.primaries = await readJson(join(this.root, 'primaries.json'), 96 * 1024) as PrimaryView[]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async acquireLock(recover: boolean): Promise<void> {
    const path = join(this.root, 'lock.json');
    const create = async () => {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({format: FORMAT, pid: process.pid, hostname: hostname(), owner: this.owner})); await file.sync(); }
      finally { await file.close(); }
      await syncDirectory(this.root);
    };
    try { await create(); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!recover) throw new StateError('not_ready', 'State root already has an owner', 503);
    const guardPath = join(this.root, 'lock-recovery.json');
    const guard = await open(guardPath, 'wx', 0o600).catch(() => { throw new StateError('not_ready', 'State lock recovery already has an owner', 503); });
    try {
      const lock = await readJson(path, 4096) as {pid: number; hostname: string};
      if (lock.hostname !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new StateError('not_ready', 'State lock owner is unknown', 503);
      let dead = false;
      try { process.kill(lock.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) throw new StateError('not_ready', 'State lock owner is live or unknown', 503);
      await unlink(path); await create();
    } finally { await guard.close(); await unlink(guardPath); }
  }
  private async releaseLock(): Promise<void> {
    const path = join(this.root, 'lock.json');
    const lock = await readJson(path, 4096) as {owner: string};
    if (lock.owner !== this.owner) throw new StateError('not_ready', 'State lock ownership changed', 503);
    await unlink(path); await syncDirectory(this.root);
  }
  private async load(directory: string, count: number, bound: number, accept: (value: unknown) => void): Promise<void> {
    const dir = await opendir(join(this.root, directory)); let visited = 0;
    const maxVisits = count + 64;
    for await (const item of dir) {
      if (++visited > maxVisits) throw new StateError('capacity', 'Saved state directory exceeds its limit', 429);
      if (!item.name.endsWith('.json')) continue;
      if (!UUID.test(item.name.slice(0, -5)) || !item.isFile()) throw new StateError('not_ready', 'Invalid saved state file', 503);
      if (--count < 0) throw new StateError('capacity', 'Saved state record limit reached', 429);
      accept(await readJson(join(this.root, directory, item.name), bound));
    }
  }
  private async atomic(relative: string, value: unknown, bound: number): Promise<void> {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > bound) throw new StateError('payload_too_large', 'Saved state file exceeds its limit', 413);
    const destination = join(this.root, relative);
    const temp = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600); let published = false;
    try {
      await file.writeFile(data); await file.sync(); await file.close();
      await rename(temp, destination); published = true;
      await syncDirectory(resolve(destination, '..'));
    } catch (error) {
      await file.close().catch(() => {}); if (published) this.poisoned = true;
      throw error;
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  transaction<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.closed || this.poisoned) throw new StateError('not_ready', 'State store is closed or requires restart', 503);
      return work();
    });
    this.queue = run.catch(() => {}); return run;
  }
  changed(name: EventName, data: EventData[EventName], workspaceId?: string, target?: Target): void {
    try { this.onChange?.(name, structuredClone(data), workspaceId, target); } catch { /* Publication must not undo acknowledged persistence. */ }
  }
  async close(): Promise<void> { await this.queue; if (!this.closed) { this.closed = true; await this.releaseLock(); } }
  private requireWorkspace(id: string): Workspace {
    const value = this.workspaces.get(id); if (!value) throw new StateError('invalid_request', 'Unknown workspace', 404); return value;
  }
  async workspace(id?: string): Promise<Workspace> {
    if (id) { await this.queue; return structuredClone(this.requireWorkspace(id)); }
    return this.transaction(async () => {
      const first = this.workspaces.values().next().value as Workspace | undefined;
      return first ? structuredClone(first) : this.createWorkspaceRecord();
    });
  }
  private async createWorkspaceRecord(): Promise<Workspace> {
    if (this.workspaces.size >= LIMITS.workspaces) throw new StateError('capacity', 'Workspace limit reached', 429);
    const value: Workspace = {id: randomUUID(), revision: 0, panelVisible: true, appearance: 'dark'};
    await this.atomic(`workspaces/${value.id}.json`, value, 8192); this.workspaces.set(value.id, value);
    this.changed('workspace.changed', value, value.id); return structuredClone(value);
  }
  createWorkspace(): Promise<Workspace> { return this.transaction(() => this.createWorkspaceRecord()); }
  updateSelection(id: string, input: SelectionInput): Promise<Workspace> {
    return this.transaction(async () => {
      const current = this.requireWorkspace(id); revision(current.revision, input.expectedRevision, current);
      validateSelection(input);
      const value = selectedWorkspace(current, input);
      await this.atomic(`workspaces/${id}.json`, value, 8192); this.workspaces.set(id, value);
      this.changed('workspace.changed', value, id); return structuredClone(value);
    });
  }
  private requireTarget(wid: string, key: string): StoredTarget {
    this.requireWorkspace(wid); const value = this.targetRecords.get(key);
    if (!value || value.workspaceId !== wid) throw new StateError('invalid_request', 'Unknown target key', 404); return value;
  }
  private targetView(value: StoredTarget): TargetState {
    const {workspaceId: _, ...view} = value;
    const unconfirmed = [...this.inputPreviews.values()].filter(copy => copy.workspaceId === value.workspaceId && copy.targetKey === value.targetKey).map(({targetKey: _, workspaceId: __, ...copy}) => copy);
    const result = structuredClone({...view, unconfirmed});
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.displayBytes - 1024) throw new StateError('capacity', 'Read recovery copies through the target index; this target view exceeds its display limit', 429);
    return result;
  }
  target(wid: string, target: Target): Promise<TargetState> {
    return this.transaction(async () => {
      this.requireWorkspace(wid); validateTarget(target);
      for (const value of this.targetRecords.values()) if (value.workspaceId === wid && sameTarget(value.target, target)) return this.targetView(value);
      if (this.targetRecords.size >= LIMITS.targets) throw new StateError('capacity', 'Saved target limit reached', 429);
      const value: StoredTarget = {workspaceId: wid, targetKey: randomUUID(), target: structuredClone(target), draft: {revision: 0, text: '', mode: target.kind === 'agent' ? 'followUp' : 'prompt', persisted: true}, reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, presentation: {revision: 0, expanded: [], showThinking: false}};
      await this.atomic(`targets/${value.targetKey}.json`, value, 96 * 1024); this.targetRecords.set(value.targetKey, value); return this.targetView(value);
    });
  }
  async getTarget(wid: string, key: string): Promise<TargetState> { await this.queue; return this.targetView(this.requireTarget(wid, key)); }
  targetIndex(wid: string): TargetIndex[] {
    this.requireWorkspace(wid);
    const links = new Map<string, string[]>();
    for (const record of this.operationRecords.values()) {
      if (record.workspaceId !== wid || !record.input || record.inputResolved) continue;
      const ids = links.get(record.input.targetKey) ?? []; ids.push(record.view.id); links.set(record.input.targetKey, ids);
    }
    return [...this.targetRecords.values()].filter(value => value.workspaceId === wid).map(value => ({targetKey: value.targetKey, target: structuredClone(value.target), draftRevision: value.draft.revision, hasDraft: value.draft.text.length > 0, unconfirmedOperationIds: links.get(value.targetKey) ?? []}));
  }
  snapshot(wid: string, selectedTargets?: Target[]): {workspace: Workspace; targets: TargetState[]; targetIndex: TargetIndex[]} {
    const workspace = structuredClone(this.requireWorkspace(wid));
    const selected = selectedTargets ?? this.defaultTargets(workspace);
    const targets = [...this.targetRecords.values()].filter(value => value.workspaceId === wid && selected.some(target => sameTarget(target, value.target))).map(value => this.targetView(value));
    return {workspace, targets, targetIndex: this.targetIndex(wid)};
  }
  private defaultTargets(workspace: Workspace): Target[] {
    const targets: Target[] = workspace.selectedTarget ? [workspace.selectedTarget] : [];
    const primary = [...this.targetRecords.values()].filter(value => value.workspaceId === workspace.id && value.target.kind === 'primary' && value.target.key === workspace.primaryKey).sort((a, b) => (b.target as Extract<Target, {kind: 'primary'}>).epoch - (a.target as Extract<Target, {kind: 'primary'}>).epoch)[0];
    if (primary) targets.push(primary.target); return targets;
  }
  async targets(wid: string): Promise<TargetState[]> { await this.queue; this.requireWorkspace(wid); return [...this.targetRecords.values()].filter(value => value.workspaceId === wid).map(value => this.targetView(value)); }
  async getUnconfirmed(wid: string, id: string): Promise<UnconfirmedInput> {
    await this.queue; const record = this.record(id);
    if (record.workspaceId !== wid || !record.input || record.inputResolved) throw new StateError('unknown_operation', 'No unconfirmed copy exists', 404);
    const {targetKey: _, ...input} = record.input; return input;
  }
  private async writeTarget(value: StoredTarget): Promise<void> {
    await this.atomic(`targets/${value.targetKey}.json`, value, 96 * 1024); this.targetRecords.set(value.targetKey, value);
  }
  putDraft(wid: string, key: string, input: {expectedRevision: number; text: string; mode: string}): Promise<DraftView> {
    return this.transaction(async () => {
      const value = this.requireTarget(wid, key); revision(value.draft.revision, input.expectedRevision, value.draft); validateText(input.text); validateMode(input.mode);
      const draft: DraftView = {revision: value.draft.revision + 1, text: input.text, mode: input.mode, persisted: true};
      await this.writeTarget({...value, draft}); this.changed('draft.changed', {targetKey: key, target: value.target, draft}, wid, value.target); return structuredClone(draft);
    });
  }
  putReading(wid: string, key: string, input: Omit<ReadingView, 'revision'> & {expectedRevision: number}): Promise<ReadingView> {
    return this.transaction(async () => {
      const value = this.requireTarget(wid, key); revision(value.reading.revision, input.expectedRevision, value.reading);
      if ((input.anchorId !== null && (typeof input.anchorId !== 'string' || input.anchorId.length > 256)) || !Number.isFinite(input.offsetPx) || Math.abs(input.offsetPx) > 1e7 || typeof input.followTail !== 'boolean') throw new StateError('invalid_request', 'Invalid reading position');
      const reading: ReadingView = {revision: value.reading.revision + 1, anchorId: input.anchorId, offsetPx: input.offsetPx, followTail: input.followTail};
      await this.writeTarget({...value, reading}); this.changed('reading.changed', {targetKey: key, reading}, wid, value.target); return structuredClone(reading);
    });
  }
  putPresentation(wid: string, key: string, input: Omit<PresentationView, 'revision'> & {expectedRevision: number}): Promise<PresentationView> {
    return this.transaction(async () => {
      const value = this.requireTarget(wid, key); revision(value.presentation?.revision ?? 0, input.expectedRevision, value.presentation);
      if (!Array.isArray(input.expanded) || input.expanded.length > 128 || input.expanded.some(id => typeof id !== 'string' || id.length > 256) || typeof input.showThinking !== 'boolean') throw new StateError('invalid_request', 'Invalid presentation preferences');
      const presentation: PresentationView = {revision: (value.presentation?.revision ?? 0) + 1, expanded: [...new Set(input.expanded)], showThinking: input.showThinking};
      await this.writeTarget({...value, presentation}); return structuredClone(presentation);
    });
  }
  restoreUnconfirmed(wid: string, id: string, expectedDraftRevision: number): Promise<DraftView> {
    return this.transaction(async () => {
      const record = this.record(id);
      if (record.workspaceId !== wid || !record.input || record.inputResolved) throw new StateError('unknown_operation', 'No unconfirmed copy exists', 404);
      const value = this.requireTarget(wid, record.input.targetKey); revision(value.draft.revision, expectedDraftRevision, value.draft);
      const draft: DraftView = {revision: value.draft.revision + 1, text: record.input.text, mode: record.input.mode, persisted: true};
      await this.writeTarget({...value, draft}); this.changed('draft.changed', {targetKey: value.targetKey, target: value.target, draft}, wid, value.target); return structuredClone(draft);
    });
  }
  discardUnconfirmed(wid: string, id: string): Promise<void> {
    return this.transaction(async () => { const record = structuredClone(this.record(id)); if (record.workspaceId !== wid) throw new StateError('unknown_operation', 'Unknown workspace operation', 404); record.inputResolved = true; delete record.input; await this.writeOperation(record); });
  }
  async readPrimaries(): Promise<PrimaryView[]> { await this.queue; return structuredClone(this.primaries); }
  savePrimaries(values: PrimaryView[]): Promise<void> {
    return this.transaction(async () => { if (values.length > 128) throw new StateError('capacity', 'Saved primary limit reached', 429); await this.atomic('primaries.json', values, 96 * 1024); this.primaries = structuredClone(values); });
  }
  // Operations use this boundary only inside transaction(), never across an external dispatch.
  getWorkspaceForOperation(id: string): void { this.requireWorkspace(id); }
  records(): OperationRecord[] { return structuredClone([...this.operationRecords.values()]); }
  record(id: string): OperationRecord {
    const value = this.operationRecords.get(id); if (!value) throw new StateError('unknown_operation', 'Unknown operation', 404); return structuredClone(value);
  }
  private cacheInput(value: OperationRecord, previous?: OperationRecord): void {
    if (!value.input || value.inputResolved) { this.inputPreviews.delete(value.view.id); return; }
    const cached = this.inputPreviews.get(value.view.id);
    const text = cached && previous?.input?.text === value.input.text ? cached.text : safeText(value.input.text, 256);
    this.inputPreviews.set(value.view.id, {...value.input, workspaceId: value.workspaceId, text, ...(text !== value.input.text ? {textTruncated: true as const} : {})});
  }
  async writeOperation(value: OperationRecord): Promise<void> {
    if (!UUID.test(value.view.id)) throw new StateError('invalid_request', 'Invalid operation identity');
    this.requireWorkspace(value.workspaceId);
    if (!this.operationRecords.has(value.view.id) && this.operationRecords.size >= LIMITS.operations) throw new StateError('capacity', 'Operation record limit reached', 429);
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new StateError('payload_too_large', 'Operation exceeds its file limit', 413);
    const previous = this.operationRecords.get(value.view.id);
    const size = Buffer.byteLength(JSON.stringify(value));
    const total = this.operationBytes - (this.operationSizes.get(value.view.id) ?? 0) + size;
    if (total > 32 * 1024 * 1024) throw new StateError('capacity', 'Operation store byte limit reached', 429);
    await this.atomic(`operations/${value.view.id}.json`, value, 128 * 1024); this.operationRecords.set(value.view.id, structuredClone(value)); this.operationBytes = total; this.operationSizes.set(value.view.id, size);
    if (previous?.input && !previous.inputResolved) this.unconfirmedCount--;
    if (value.input && !value.inputResolved) this.unconfirmedCount++;
    this.cacheInput(value, previous);
    this.changed('operation.changed', value.view, value.workspaceId, value.view.target);
  }
  operationStoreBytes(): number { return this.operationBytes; }
  operationMetadata(): OperationMetadata[] {
    return [...this.operationRecords.values()].map(({view, workspaceId, input, inputResolved}) => ({workspaceId, inputResolved, ...(input ? {input: true as const} : {}), view: {id: view.id, kind: view.kind, state: view.state, createdAt: view.createdAt, updatedAt: view.updatedAt, ...(view.target ? {target: structuredClone(view.target)} : {})}}));
  }
  operationViews(wid: string): OperationView[] { return structuredClone([...this.operationRecords.values()].filter(value => value.workspaceId === wid && ['reserved', 'dispatched', 'uncertain'].includes(value.view.state)).map(value => value.view)); }
  unresolvedInputCount(): number { return this.unconfirmedCount; }
  async deleteOperation(id: string): Promise<void> {
    const previous = this.operationRecords.get(id);
    if (!previous) throw new StateError('unknown_operation', 'Unknown operation', 404);
    await unlink(join(this.root, 'operations', `${id}.json`)); await syncDirectory(join(this.root, 'operations'));
    this.operationRecords.delete(id); this.operationBytes -= this.operationSizes.get(id) ?? 0; this.operationSizes.delete(id); this.inputPreviews.delete(id);
    if (previous.input && !previous.inputResolved) this.unconfirmedCount--;
  }
  draftForOperation(wid: string, key: string): TargetState { return this.targetView(this.requireTarget(wid, key)); }
  async clearSubmittedDraft(wid: string, input: NonNullable<OperationRecord['input']>): Promise<void> {
    const value = this.requireTarget(wid, input.targetKey);
    if (value.draft.revision !== input.submittedDraftRevision || value.draft.text !== input.text) return;
    const draft: DraftView = {...value.draft, revision: value.draft.revision + 1, text: ''}; await this.writeTarget({...value, draft});
    this.changed('draft.changed', {targetKey: value.targetKey, target: value.target, draft}, wid, value.target);
  }
}
