import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { APPEARANCES, LIMITS, LAYOUT_VERSION, validSessionMetadataTarget, sameDraftTuple, draftHasContent, validLayoutData, validWorkspaceTab, workspaceTabKey, type FilePosition } from '../shared/api.ts';
import type {SessionMetadataRecord, DraftImage, DraftPut, StoredDraft, RecoveryInput, RetainedInput, RetainedAdmission, InputCopy, RecoveryOrigin, RecoverySendGuard, QueueRecovery, ImageUploadView} from '../shared/api.ts';
import {normalizeDraftImages, imageName} from './validate.mts';
import {DraftImages, sameImageContent} from './draft-images.mts';
import type {BlobIndex, BlobReferenceGraph, BlobReadSpec, BlobIntake, UploadReservation} from './draft-images.mts';
import {sentImageAttachments, imageDigest, imageMessageDigest} from './images.mts';
import type {ImageBytes, ValidatedImage, SentImageReceipt} from './images.mts';
import type { Appearance, ConversationLayout, DraftView, EntryView, EventData, EventName, MessageView, OperationView, PresentationView, PrimaryView, ReadingView, Target, TargetIndex, TargetState, UnconfirmedInput, Workspace } from '../shared/api.ts';

import { safeText } from './projection.mts';
import {movedFilePath, type FileMutation} from '../shared/files.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT = 'ui-state/1';
// Node omits Darwin O_EXLOCK. Keep the guard inode so every contender locks the same kernel object.
const DARWIN_EXCLUSIVE_LOCK = 0x20;
type LockOwner = {format: string; pid: number; hostname: string; owner: string};
export type ChangeHook = (name: EventName, data: EventData[EventName], workspaceId?: string, target?: Target) => void;
export type QueueClearRecord = {recoveryWorkspaceId: string; phase: 'prepared' | 'retaining' | 'retained' | 'uncertain' | 'refused'; imageCopies: {workspaceId: string; operationId: string}[]; rowBudget: number; returned?: {steering: number; followUp: number}};
export type OperationMetadata = {view: Pick<OperationView, 'id' | 'kind' | 'target' | 'state' | 'createdAt' | 'updatedAt'>; workspaceId: string; input?: true; inputResolved?: boolean; retainedInput?: RetainedAdmission; protected?: boolean};
export type OperationRecord = {view: OperationView; workspaceId: string; digest?: string; input?: Omit<InputCopy, 'queueRecovery'> & {targetKey: string}; inputResolved?: boolean; retainedInput?: RetainedAdmission; sentImages?: SentImageReceipt; queueRecovery?: QueueRecovery; queueClear?: QueueClearRecord};
export type ImageLease = {image: ValidatedImage; expiresAt: string};
type SentImageSource = {workspaceId: string; receipt: SentImageReceipt};
type StoredTarget = Omit<TargetState, 'draft' | 'unconfirmed' | 'retainedInputs' | 'imageAvailability' | 'imageStorageError' | 'recoveryPreviewTruncated'> & {workspaceId: string; draft: StoredDraft; imageLeases?: ImageLease[]};
type WorkspaceActivity = {id: string; savedAt: number; trackedAt: number; lastUsedAt?: number; clientSeenAt?: number; archivedAt?: number};
const WORKSPACE_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;

export class StateError extends Error {
  readonly retry: 'none' | 'read' | 'manual';
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message); this.code = code; this.status = status; this.details = details;
    this.name = 'StateError'; this.retry = ['stale_revision', 'file_changed', 'unknown_image_digest', 'image_unavailable', 'queue_recovery_guard', 'queue_recovery_provenance'].includes(code) ? 'read' : ['capacity','file_identity_uncertain'].includes(code) ? 'manual' : 'none';
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
function layoutObject(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StateError('invalid_request', `Invalid ${name}`);
  const record = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(record, key))) throw new StateError('invalid_request', `Invalid ${name} fields`);
  return record;
}
function conversationTabKey(value: unknown): string {
  if (!validWorkspaceTab(value)) throw new StateError('invalid_request', 'Invalid conversation tab');
  return workspaceTabKey(value);
}
type LayoutValidation = {ids: Set<string>; leaves: Set<string>; keys: Set<string>; conversations: number; nodes: number; empty: number};
function layoutPaneId(value: unknown, state: LayoutValidation): string {
  if (typeof value !== 'string' || !value || value.length > 64 || /[\x00-\x1f]/.test(value) || state.ids.has(value)) throw new StateError('invalid_request', 'Invalid or duplicate conversation pane ID');
  state.ids.add(value); return value;
}
function layoutLeaf(node: Record<string, unknown>, state: LayoutValidation): void {
  state.leaves.add(node.id as string);
  if (state.leaves.size > 4 || !Array.isArray(node.tabs)) throw new StateError('invalid_request', 'Invalid conversation pane or tab count');
  const local = new Set<string>();
  for (const tab of node.tabs) {
    const key = conversationTabKey(tab);
    if (state.keys.has(key)) throw new StateError('invalid_request', 'Duplicate conversation tab');
    local.add(key); state.keys.add(key);if ((tab as {kind:string}).kind !== 'file') state.conversations++;
  }
  if (state.conversations > LIMITS.conversationTabs) throw new StateError('invalid_request', 'Invalid conversation tab count');
  if (local.size ? typeof node.active !== 'string' || !local.has(node.active) : node.active !== null) throw new StateError('invalid_request', 'Invalid active conversation tab');
  if (!local.size) state.empty++;
}
function layoutSplit(node: Record<string, unknown>): void {
  if (node.kind !== 'split' || (node.axis !== 'x' && node.axis !== 'y') || typeof node.ratio !== 'number' || !Number.isSafeInteger(node.ratio) || node.ratio < 20 || node.ratio > 80) throw new StateError('invalid_request', 'Invalid conversation split');
}
function visitLayout(value: unknown, depth: number, state: LayoutValidation): void {
  if (++state.nodes > 7 || depth > 3) throw new StateError('invalid_request', 'Conversation pane tree exceeds its bounds');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StateError('invalid_request', 'Invalid conversation pane');
  const candidate = value as Record<string, unknown>;
  const node = layoutObject(value, candidate.kind === 'pane' ? ['kind', 'id', 'tabs', 'active'] : ['kind', 'id', 'axis', 'ratio', 'first', 'second'], 'conversation pane');
  layoutPaneId(node.id, state);
  if (node.kind === 'pane') { layoutLeaf(node, state); return; }
  layoutSplit(node); visitLayout(node.first, depth + 1, state); visitLayout(node.second, depth + 1, state);
}
/** One bounded tree owns tabs, active targets and pane focus. */
export function validateConversationLayout(value: unknown): asserts value is ConversationLayout {
  if (!validLayoutData(value)) throw new StateError('invalid_request','Invalid or oversized layout metadata');
  const layout = layoutObject(value, ['root', 'focusedPane'], 'conversation layout');
  const state: LayoutValidation = {ids: new Set(), leaves: new Set(), keys: new Set(), conversations: 0, nodes: 0, empty: 0};
  visitLayout(layout.root, 0, state);
  if (typeof layout.focusedPane !== 'string' || !state.leaves.has(layout.focusedPane) || state.empty && state.leaves.size !== 1) throw new StateError('invalid_request', 'Invalid conversation pane focus or empty group');
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

type SelectionInput = {expectedRevision: number; primaryKey?: string; selectedTarget?: Target | null; panelVisible?: boolean; sidebarVisible?: boolean; sidebarWidth?: number; appearance?: Appearance; enterSendsMessages?: boolean; agentControl?:boolean; recentModels?: Workspace['recentModels']; conversationLayout?: ConversationLayout; filePositions?: Record<string,FilePosition>};
function fileKeys(layout?:ConversationLayout):Set<string> {
  const keys = new Set<string>();
  const visit = (node:ConversationLayout['root']):void => {if (node.kind === 'split') {visit(node.first);visit(node.second);} else for (const tab of node.tabs) if (tab.kind === 'file') keys.add(workspaceTabKey(tab));};
  if (layout) visit(layout.root); return keys;
}
export function validateFilePositions(value:unknown, layout?:ConversationLayout):asserts value is Record<string,FilePosition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StateError('invalid_request','Invalid file positions');
  const keys = fileKeys(layout);
  for (const [key,position] of Object.entries(value)) if (!keys.has(key) || !position || typeof position !== 'object' || Object.keys(position).length !== 2 || !Number.isFinite(position.scrollTop) || !Number.isFinite(position.scrollLeft) || position.scrollTop < 0 || position.scrollLeft < 0 || position.scrollTop > 1e9 || position.scrollLeft > 1e9) throw new StateError('invalid_request','Invalid file reading position');
}
function validateEnterPreference(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw new StateError('invalid_request', 'Invalid Enter preference');
}
function validateRecentModels(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 5) throw new StateError('invalid_request', 'Invalid recent models');
  const identities = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !['provider', 'modelId'].every(key => typeof item[key] === 'string' && item[key].trim().length > 0 && item[key].length <= LIMITS.idChars && !/[\u0000-\u001f\u007f]/.test(item[key]))) throw new StateError('invalid_request', 'Invalid recent model identity');
    const identity = JSON.stringify([item.provider, item.modelId]);
    if (identities.has(identity)) throw new StateError('invalid_request', 'Duplicate recent model');
    identities.add(identity);
  }
}
function validateAgentControl(value:unknown):void {if(value!==undefined&&typeof value!=='boolean')throw new StateError('invalid_request','Invalid agent control setting');}
function validateSelection(input: SelectionInput): void {
      if (input.selectedTarget) validateTarget(input.selectedTarget);
      if (input.primaryKey !== undefined && (typeof input.primaryKey !== 'string' || input.primaryKey.length > 256)) throw new StateError('invalid_request', 'Invalid primary key');
      if (input.panelVisible !== undefined && typeof input.panelVisible !== 'boolean') throw new StateError('invalid_request', 'Invalid panel visibility');
      if (input.sidebarVisible !== undefined && typeof input.sidebarVisible !== 'boolean') throw new StateError('invalid_request', 'Invalid sidebar visibility');
      if (input.sidebarWidth !== undefined && (!Number.isSafeInteger(input.sidebarWidth) || input.sidebarWidth < LIMITS.sidebarWidthMin || input.sidebarWidth > LIMITS.sidebarWidthMax)) throw new StateError('invalid_request', 'Invalid sidebar width');
      if (input.appearance !== undefined && !(APPEARANCES as readonly string[]).includes(input.appearance)) throw new StateError('invalid_request', 'Invalid appearance');
      validateEnterPreference(input.enterSendsMessages);
      validateAgentControl(input.agentControl);
      validateRecentModels(input.recentModels);
      if (input.conversationLayout !== undefined) validateConversationLayout(input.conversationLayout);
      const allowed = ['expectedRevision', 'primaryKey', 'selectedTarget', 'panelVisible', 'sidebarVisible', 'sidebarWidth', 'appearance', 'enterSendsMessages', 'agentControl', 'recentModels', 'conversationLayout', 'filePositions'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new StateError('invalid_request', 'Unknown workspace field');
}
function knownTabFields(tab:import('../shared/api.ts').WorkspaceTab):string[] {
  if(tab.kind==='primary')return ['kind'];
  if(tab.kind==='agent')return ['kind','identity'];
  return ['kind','rootId','path','view'];
}
function validateSavedLayoutVersion(version:unknown):void {
  if(version!==undefined&&(!Number.isSafeInteger(version)||typeof version!=='number'||version<1))throw new StateError('not_ready','Invalid saved layout version',503);
}
function opaqueLayoutFields(layout?:ConversationLayout):Map<string,unknown> {
  const result=new Map<string,unknown>();if(!layout)return result;
  const extras=(key:string,value:object,known:string[])=>{const fields=Object.fromEntries(Object.entries(value).filter(([field])=>!known.includes(field)));if(Object.keys(fields).length)result.set(key,fields);};
  extras('layout',layout,['root','focusedPane']);
  const visit=(node:ConversationLayout['root']):void=>{
    extras(`pane:${node.id}`,node,node.kind==='pane'?['kind','id','tabs','active']:['kind','id','axis','ratio','first','second']);
    if(node.kind==='split'){visit(node.first);visit(node.second);return;}
    for(const tab of node.tabs){const key=`tab:${workspaceTabKey(tab)}`;if(tab.kind==='session')result.set(key,tab);else extras(key,tab,knownTabFields(tab));}
  };visit(layout.root);return result;
}
function validateLayoutWrite(current:Workspace,input:SelectionInput,version?:number):void {
  if(version!==undefined&&version!==LAYOUT_VERSION)throw new StateError('layout_version','This backend does not support that layout writer version.',409);
  if(input.conversationLayout===undefined&&input.filePositions===undefined)return;
  if((current.layoutVersion??0)>LAYOUT_VERSION)throw new StateError('layout_version','The saved layout requires a newer page. No view state changed.',409);
  if(!input.conversationLayout)return;
  validateOpaqueLayoutWrite(current.conversationLayout,input.conversationLayout,version);
}
function validateOpaqueLayoutWrite(current:ConversationLayout|undefined,incoming:ConversationLayout,version?:number):void {
  const before=opaqueLayoutFields(current),after=opaqueLayoutFields(incoming);
  if(version===undefined&&before.size&&!isDeepStrictEqual(current,incoming))throw new StateError('layout_version','Reload this page before changing the retained layout. No view state changed.',409);
  for(const [key,value] of before)if(!key.startsWith('tab:session:')&&!isDeepStrictEqual(value,after.get(key)))throw new StateError('layout_version','This page cannot replace retained view metadata. No view state changed.',409);
}
function applyWorkspacePreferences(value: Workspace, input: SelectionInput): void {
  if (input.panelVisible !== undefined) value.panelVisible = input.panelVisible;
  if (input.sidebarVisible !== undefined) value.sidebarVisible = input.sidebarVisible;
  if (input.sidebarWidth !== undefined) value.sidebarWidth = input.sidebarWidth;
  if (input.appearance !== undefined) value.appearance = input.appearance;
  if (input.enterSendsMessages !== undefined) value.enterSendsMessages = input.enterSendsMessages;
  if (input.agentControl !== undefined) value.agentControl = input.agentControl;
  if (input.recentModels !== undefined) value.recentModels = structuredClone(input.recentModels);
}
function validateSavedPreferences(record: Workspace): void {
  try { validateRecentModels(record.recentModels); } catch { throw new StateError('not_ready', 'Invalid saved recent models', 503); }
  if (record.agentControl !== undefined && typeof record.agentControl !== 'boolean') throw new StateError('not_ready', 'Invalid saved agent control setting', 503);
  if (record.enterSendsMessages !== undefined && typeof record.enterSendsMessages !== 'boolean') throw new StateError('not_ready', 'Invalid saved Enter preference', 503);
}
function selectedWorkspace(current: Workspace, input: SelectionInput, layoutVersion?:number): Workspace {
      const value: Workspace = {...current, revision: current.revision + 1};
      if(layoutVersion!==undefined&&(input.conversationLayout!==undefined||input.filePositions!==undefined))value.layoutVersion=layoutVersion;
      if (input.primaryKey !== undefined) value.primaryKey = input.primaryKey;
      applyWorkspacePreferences(value, input);
      if (input.conversationLayout !== undefined) value.conversationLayout = structuredClone(input.conversationLayout);
      if (input.selectedTarget === null) delete value.selectedTarget;
      else if (input.selectedTarget !== undefined) value.selectedTarget = structuredClone(input.selectedTarget);
      if (input.filePositions !== undefined) validateFilePositions(input.filePositions,value.conversationLayout);
      const keys = fileKeys(value.conversationLayout);
      value.filePositions = Object.fromEntries(Object.entries({...current.filePositions,...structuredClone(input.filePositions ?? {})}).filter(([key])=>keys.has(key)));
      validateFilePositions(value.filePositions,value.conversationLayout);
  return value;
}

function savedImages(value: unknown, owner: 'draft' | 'input'): DraftImage[] {
  if (!Array.isArray(value)) throw new StateError('state_record_refused', `Saved ${owner} image metadata requires an array`, 503);
  return normalizeDraftImages(value);
}
function validateOrigin(value: RecoveryOrigin): void {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !UUID.test(value.clearOperationId) || !UUID.test(value.recoveryOperationId)) throw new StateError('queue_recovery_provenance', 'Recovery source is invalid', 409);
}
function validateQueueRecovery(value: QueueRecovery): void {
  if (!value || Object.keys(value).length !== 3 || !UUID.test(value.clearOperationId) || !['steer', 'followUp'].includes(value.mode) || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= LIMITS.unconfirmed) throw new StateError('queue_recovery_provenance', 'Queue recovery source is invalid', 409);
}
function moveLayoutFiles(node:ConversationLayout['root'],rootId:string,from:string,to:string,keys:Map<string,string>):void {
  if (node.kind === 'split') {moveLayoutFiles(node.first,rootId,from,to,keys);moveLayoutFiles(node.second,rootId,from,to,keys);return;}
  for (const tab of node.tabs) {
    if (tab.kind !== 'file' || tab.rootId !== rootId) continue;
    const source = tab.path === from || tab.path.startsWith(`${from}/`);
    if (!source && (tab.path === to || tab.path.startsWith(`${to}/`))) throw new StateError('file_changed','The destination has a retained file identity. Choose another name.',409);
    const path = movedFilePath(tab.path,from,to);if (path === tab.path) continue;
    const previous = workspaceTabKey(tab);tab.path = path;const next = workspaceTabKey(tab);keys.set(previous,next);
    if (node.active === previous) node.active = next;
  }
}
function movedWorkspace(current:Workspace,rootId:string,from:string,to:string):Workspace {
  const value = structuredClone(current),keys = new Map<string,string>();
  if (value.conversationLayout) moveLayoutFiles(value.conversationLayout.root,rootId,from,to,keys);
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new StateError('capacity','The workspace revision bound is full.',429);
  value.revision++;
  if (value.filePositions) value.filePositions = Object.fromEntries(Object.entries(value.filePositions).map(([key,position])=>[keys.get(key) ?? key,position]));
  if (value.conversationLayout) validateConversationLayout(value.conversationLayout);if (value.filePositions) validateFilePositions(value.filePositions,value.conversationLayout);
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.requestBytes) throw new StateError('capacity','The moved workspace exceeds its saved byte bound.',429);
  return value;
}
export class StateStore {
  readonly root: string;
  instanceId = '';
  private readonly owner = randomUUID();
  private lockHeld = false;
  private lockGuard?: FileHandle;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;
  private poisoned = false;
  private readonly refusedTargets = new Set<string>();
  private imageRecordsRefused = false;
  private readonly refusedOperations = new Set<string>();
  private refusedOperationBytes = 0;
  private workspaces = new Map<string, Workspace>();
  private workspaceActivity = new Map<string, WorkspaceActivity>();
  private lastUsedWorkspace?: string;
  private fileIdentity:'ready'|'pending'|'uncertain' = 'ready';
  private fileDeadlineMs:number = LIMITS.fileReadMs;
  private targetRecords = new Map<string, StoredTarget>();
  private operationRecords = new Map<string, OperationRecord>();
  private operationBytes = 0;
  private readonly operationSizes = new Map<string, number>();
  private readonly inputPreviews = new Map<string, UnconfirmedInput & {targetKey: string; workspaceId: string}>();
  private primaries: PrimaryView[] = [];
  private sessionMetadata: SessionMetadataRecord[] = [];
  private onChange?: ChangeHook;
  private images!: DraftImages;
  private imageIndex: BlobIndex = {directories: [], entries: [], temps: []};
  private readonly uploads = new Map<string, UploadReservation>();
  private readonly now: () => number;
  private constructor(root: string, onChange?: ChangeHook, now: () => number = Date.now) { this.root = resolve(root); this.onChange = onChange; this.now = now; }

  static async open(root: string, options: {recoverDeadLock?: boolean; onChange?: ChangeHook; now?: () => number; fileDeadlineMs?:number} = {}): Promise<StateStore> {
    const store = new StateStore(root, options.onChange, options.now);store.fileDeadlineMs = options.fileDeadlineMs ?? LIMITS.fileReadMs;
    await mkdir(store.root, {recursive: true, mode: 0o700});
    const info = await lstat(store.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StateError('not_ready', 'State root must be a private directory', 503);
    await chmod(store.root, 0o700);
    for (const name of ['workspaces', 'workspace-activity', 'targets', 'operations']) {
      const dir = join(store.root, name); await mkdir(dir, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError('not_ready', 'State subdirectory is not a directory', 503);
      await chmod(dir, 0o700);
    }
    try {
      await store.acquireLock(options.recoverDeadLock === true);
      await store.initialize(); store.images = new DraftImages(store.root); await store.refreshImageIndex(); await store.cleanupImagesForMutation(); return store;
    } catch (error) { await store.images?.close(); await store.releaseLock(); throw error; }
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
      await this.loadSavedRecords();
      await this.recoverDispatchedOperations();
      try { this.primaries = await readJson(join(this.root, 'primaries.json'), 96 * 1024) as PrimaryView[]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try {
        const rows = await readJson(join(this.root, 'session-metadata.json'), LIMITS.rosterBytes);
        if (!Array.isArray(rows) || rows.length > LIMITS.rosterRows || rows.some(row => !row || typeof row.key !== 'string' || row.key.length > 16 * 1024 || typeof row.title !== 'string' || row.title.length > 240 || typeof row.archived !== 'boolean' || row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 240) || !validSessionMetadataTarget(row.target)) || new Set(rows.map(row => row.key)).size !== rows.length) throw new StateError('not_ready','Invalid saved session metadata',503);
        this.sessionMetadata = rows;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async recoverDispatchedOperations(): Promise<void> {
    for (const record of this.operationRecords.values()) {
      if (record.view.state !== 'dispatched') continue;
      record.view.state = 'uncertain'; record.view.updatedAt = new Date().toISOString();
      record.view.error = {code: 'delivery_uncertain', message: 'Backend restarted before a receipt arrived', retry: 'manual'};
      if (record.input) record.input.reason = 'Backend restarted before a receipt arrived';
      if (record.queueClear) record.queueClear.phase = 'uncertain';
      await this.writeOperation(record);
    }
  }
  private validateImageLeases(leases: StoredTarget['imageLeases']): void {
        if (leases) {
          if (!Array.isArray(leases) || leases.length > LIMITS.stagedImagesPerTarget || new Set(leases.map(lease => lease.image.digest)).size !== leases.length) throw new StateError('image_storage_unavailable', 'Saved image leases are invalid', 503);
          for (const lease of leases) { normalizeDraftImages([{...lease.image, name: 'Staged image'}]); if (!Number.isFinite(Date.parse(lease.expiresAt))) throw new StateError('image_storage_unavailable', 'Saved image lease time is invalid', 503); }
        }
  }
  private async loadSavedRecords(): Promise<void> {
      await this.load('workspaces', LIMITS.workspaces, LIMITS.requestBytes, (value, modifiedAt) => {
        const record = value as Workspace;
        if (!UUID.test(record.id) || !Number.isSafeInteger(record.revision)) throw new StateError('not_ready', 'Invalid saved workspace', 503);
        validateSavedLayoutVersion(record.layoutVersion);
        validateSavedPreferences(record);
        if (record.conversationLayout !== undefined) validateConversationLayout(record.conversationLayout);
        if (record.filePositions !== undefined) validateFilePositions(record.filePositions,record.conversationLayout);
        this.workspaces.set(record.id, record);
        this.workspaceActivity.set(record.id,{id:record.id,savedAt:modifiedAt ?? this.now(),trackedAt:this.now()});
      });
      const untracked = new Set(this.workspaces.keys());
      await this.load('workspace-activity', LIMITS.workspaces, 1024, value => {
        const record = value as WorkspaceActivity;
        const validTime=(time:unknown)=>typeof time === 'number' && Number.isFinite(new Date(time).getTime());
        if (!UUID.test(record.id) || !this.workspaces.has(record.id) || !validTime(record.savedAt) || !validTime(record.trackedAt) || record.lastUsedAt !== undefined && !validTime(record.lastUsedAt) || record.archivedAt !== undefined && !validTime(record.archivedAt) || record.clientSeenAt !== undefined && !validTime(record.clientSeenAt)) throw new StateError('not_ready','Invalid workspace activity',503);
        this.workspaceActivity.set(record.id,record); untracked.delete(record.id);
      });
      for (const id of untracked) await this.atomic(`workspace-activity/${id}.json`,this.workspaceActivity.get(id),1024);
      await this.load('targets', LIMITS.targets, 96 * 1024, value => {
        const record = value as StoredTarget; validateTarget(record.target);
        if (!UUID.test(record.targetKey) || !this.workspaces.has(record.workspaceId)) throw new StateError('not_ready', 'Invalid saved target', 503);
        validateText(record.draft.text); validateMode(record.draft.mode); record.draft.images = savedImages(record.draft.images, 'draft');
        if (record.draft.recoveryOrigin) validateOrigin(record.draft.recoveryOrigin);
        this.validateImageLeases(record.imageLeases);
        if ([...this.targetRecords.values()].some(saved => saved.workspaceId === record.workspaceId && sameTarget(saved.target, record.target))) throw new StateError('not_ready', 'Duplicate saved target identity', 503);
        this.targetRecords.set(record.targetKey, record);
      });
      let operationBytes = 0;
      await this.load('operations', LIMITS.operations, 128 * 1024, value => {
        const record = value as OperationRecord;
        if (!UUID.test(record.view.id) || !this.workspaces.has(record.workspaceId)) throw new StateError('not_ready', 'Invalid saved operation', 503);
        this.validateOperationInput(record);
        operationBytes += Buffer.byteLength(JSON.stringify(record));
        if (operationBytes > 32 * 1024 * 1024) throw new StateError('capacity', 'Saved operation store exceeds its limit', 429);
        this.operationRecords.set(record.view.id, record); this.operationBytes = operationBytes;
        this.operationSizes.set(record.view.id, Buffer.byteLength(JSON.stringify(record)));
        this.cacheInput(record);
      });
      if (this.operationBytes + this.refusedOperationBytes > 32 * 1024 * 1024) throw new StateError('capacity', 'Saved operation store exceeds its limit', 429);
  }
  private async acquireGuard(recover: boolean): Promise<void> {
    if (process.platform !== 'darwin') throw new StateError('not_ready', 'State lock coordination requires macOS', 503);
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | DARWIN_EXCLUSIVE_LOCK;
    this.lockGuard = await open(join(this.root, 'lock-recovery.json'), flags, 0o600).catch(error => {
      let message = 'State lock guard is unavailable';
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') message = recover ? 'State lock owner is live or unknown' : 'State root already has an owner';
      throw new StateError('not_ready', message, 503);
    });
    await this.checkGuard();
  }
  private async checkGuard(): Promise<void> {
    if (!this.lockGuard) throw new StateError('not_ready', 'State lock guard is unavailable', 503);
    const [info,named] = await Promise.all([this.lockGuard.stat(),lstat(join(this.root, 'lock-recovery.json'))]).catch(() => { throw new StateError('not_ready', 'State lock guard is unavailable', 503); });
    if (!info.isFile() || !named.isFile() || info.dev !== named.dev || info.ino !== named.ino || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new StateError('not_ready', 'State lock guard is not private or its identity changed', 503);
  }
  private async readLock(): Promise<LockOwner> {
    let value: LockOwner;
    try { value = await readJson(join(this.root, 'lock.json'), 4096) as LockOwner; }
    catch { throw new StateError('not_ready', 'State lock owner is unknown', 503); }
    if (!value || value.format !== FORMAT || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.hostname !== 'string' || !value.hostname || typeof value.owner !== 'string' || !value.owner || value.owner.length > 128) throw new StateError('not_ready', 'State lock owner is unknown', 503);
    return value;
  }
  private async publishLock(localHostname: string): Promise<boolean> {
    const temp = join(this.root, `.lock-${this.owner}.tmp`),file = await open(temp, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify({format: FORMAT, pid: process.pid, hostname: localHostname, owner: this.owner})); await file.sync(); }
      finally { await file.close(); }
      try { await link(temp, join(this.root, 'lock.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      this.lockHeld = true; await syncDirectory(this.root); return true;
    } finally { await unlink(temp); }
  }
  private async acquireLock(recover: boolean): Promise<void> {
    await this.acquireGuard(recover);
    const localHostname = hostname();
    if (!localHostname) throw new StateError('not_ready', 'Local hostname is unavailable', 503);
    if (await this.publishLock(localHostname)) return;
    if (!recover) throw new StateError('not_ready', 'State root already has an owner', 503);
    const lock = await this.readLock();
    if (lock.hostname !== localHostname) throw new StateError('not_ready', 'State lock owner is unknown', 503);
    let dead = false;
    try { process.kill(lock.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (!dead) throw new StateError('not_ready', 'State lock owner is live or unknown', 503);
    await unlink(join(this.root, 'lock.json'));
    if (!await this.publishLock(localHostname)) throw new StateError('not_ready', 'State lock ownership changed', 503);
  }
  private async releaseLock(): Promise<void> {
    try {
      if (!this.lockHeld) return;
      await this.checkGuard();
      const lock = await this.readLock();
      if (lock.owner !== this.owner) throw new StateError('not_ready', 'State lock ownership changed', 503);
      await unlink(join(this.root, 'lock.json')); this.lockHeld = false; await syncDirectory(this.root);
    } finally { const guard = this.lockGuard; this.lockGuard = undefined; await guard?.close(); }
  }
  private async load(directory: string, count: number, bound: number, accept: (value: unknown, modifiedAt?: number) => void): Promise<void> {
    const dir = await opendir(join(this.root, directory)); let visited = 0;
    const maxVisits = count + 64;
    for await (const item of dir) {
      if (++visited > maxVisits) throw new StateError('capacity', 'Saved state directory exceeds its limit', 429);
      if (!item.name.endsWith('.json')) continue;
      if (!UUID.test(item.name.slice(0, -5)) || !item.isFile()) throw new StateError('not_ready', 'Invalid saved state file', 503);
      if (--count < 0) throw new StateError('capacity', 'Saved state record limit reached', 429);
      const path = join(this.root, directory, item.name), value = await readJson(path, bound);
      const modifiedAt = directory === 'workspaces' ? (await lstat(path)).mtimeMs : undefined;
      try { accept(value, modifiedAt); }
      catch (error) { this.refuseSavedRecord(directory, item.name, value, error); }
    }
  }
  private refuseSavedRecord(directory: string, name: string, value: unknown, error: unknown): void {
    if (!(error instanceof StateError) || error.code !== 'state_record_refused') throw error;
    if (directory === 'targets') this.refusedTargets.add(name.slice(0, -5));
    if (directory === 'operations') { this.refusedOperations.add(name.slice(0, -5)); this.refusedOperationBytes += Buffer.byteLength(JSON.stringify(value)); }
    this.imageRecordsRefused = true;
    this.changed('notice', {level: 'warning', code: 'state_record_refused', message: `${directory}/${name}: ${error.message}. The saved file remains unchanged.`});
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
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      for (const reservation of [...this.uploads.values()]) await this.cancelImageUpload(reservation);
      await this.queue;
      if (!this.closed) { this.closed = true; await this.images.close(); await this.releaseLock(); }
    })();
    return this.closePromise;
  }
  private requireWorkspace(id: string): Workspace {
    const value = this.workspaces.get(id); if (!value) throw new StateError('invalid_request', 'Unknown workspace', 404); return value;
  }
  async workspace(id?: string, recordUse = true): Promise<Workspace> {
    return this.transaction(async () => {
      const value = id ? this.requireWorkspace(id) : [...this.workspaces.values()].filter(item => this.workspaceActivity.get(item.id)?.archivedAt === undefined).sort((a,b) => this.workspaceRecency(b.id)-this.workspaceRecency(a.id) || a.id.localeCompare(b.id))[0];
      if (!value) return this.createWorkspaceRecord();
      if(recordUse)await this.useWorkspace(value.id); return structuredClone(value);
    });
  }
  private workspaceRecency(id: string): number { const value = this.workspaceActivity.get(id); return value?.lastUsedAt ?? value?.savedAt ?? 0; }
  private async useWorkspace(id: string): Promise<void> {
    const current = this.workspaceActivity.get(id), now = this.now();
    if (this.lastUsedWorkspace === id && current && current.archivedAt === undefined && current.lastUsedAt !== undefined && now-current.lastUsedAt < 5000) return;
    const value: WorkspaceActivity = {...current,id,savedAt:current?.savedAt ?? now,trackedAt:current?.trackedAt ?? now,lastUsedAt:now}; delete value.archivedAt;
    await this.atomic(`workspace-activity/${id}.json`,value,1024);this.workspaceActivity.set(id,value);this.lastUsedWorkspace=id;
  }
  keepWorkspace(id: string): Promise<void> { return this.transaction(async () => {
    this.requireWorkspace(id); const current=this.workspaceActivity.get(id), now=this.now();
    const value:WorkspaceActivity={...current,id,savedAt:current?.savedAt ?? now,trackedAt:current?.trackedAt ?? now,clientSeenAt:now};
    await this.atomic(`workspace-activity/${id}.json`,value,1024);this.workspaceActivity.set(id,value);
  }); }
  async archiveUnused(protectedIds: ReadonlySet<string>): Promise<void> {
    await this.transaction(async () => {
      const now = this.now();
      for (const [id,current] of this.workspaceActivity) {
        if (current.archivedAt !== undefined || protectedIds.has(id) || now-Math.max(current.lastUsedAt ?? current.trackedAt,current.trackedAt,current.clientSeenAt ?? 0) < WORKSPACE_UNUSED_MS || this.workspaceHasDraft(id)) continue;
        const value = {...current,archivedAt:now};await this.atomic(`workspace-activity/${id}.json`,value,1024);this.workspaceActivity.set(id,value);
      }
    });
  }
  private workspaceHasDraft(id: string): boolean {
    if ([...this.targetRecords.values()].some(record => record.workspaceId === id && (record.draft.text.length > 0 || record.draft.images.length > 0))) return true;
    return [...this.operationRecords.values()].some(record => record.workspaceId === id && (!!record.retainedInput || !!record.input && record.inputResolved !== true || ['reserved','dispatched','uncertain'].includes(record.view.state)));
  }
  async workspacePage(archived: boolean, offset = 0, limit = 50): Promise<import('../shared/api.ts').WorkspacePage> {
    await this.queue;
    const rows = [...this.workspaces.values()].filter(value => (this.workspaceActivity.get(value.id)?.archivedAt !== undefined) === archived).sort((a,b)=>this.workspaceRecency(b.id)-this.workspaceRecency(a.id) || a.id.localeCompare(b.id));
    const count = (node: import('../shared/api.ts').PaneNode): number => node.kind === 'pane' ? node.tabs.length : count(node.first)+count(node.second);
    const items = rows.slice(offset,offset+limit).map(value => {
      const activity=this.workspaceActivity.get(value.id), primary=this.primaries.find(item=>item.key === value.primaryKey);
      return {id:value.id,name:primary?.sessionName ?? primary?.cwd.split('/').filter(Boolean).at(-1) ?? 'Workspace',tabCount:value.conversationLayout ? count(value.conversationLayout.root) : Number(!!value.primaryKey)+Number(value.selectedTarget?.kind === 'agent'),...(activity?.lastUsedAt !== undefined ? {lastUsedAt:new Date(activity.lastUsedAt).toISOString()} : {}),...(activity?.archivedAt !== undefined ? {archivedAt:new Date(activity.archivedAt).toISOString()} : {})};
    });
    return {items,nextCursor:offset+limit < rows.length ? String(offset+limit) : null,total:rows.length};
  }
  private async createWorkspaceRecord(): Promise<Workspace> {
    const value: Workspace = {id: randomUUID(), revision: 0, panelVisible: true, appearance: 'system'};
    await this.atomic(`workspaces/${value.id}.json`, value, 8192); this.workspaces.set(value.id, value);
    await this.useWorkspace(value.id);
    this.changed('workspace.changed', value, value.id); return structuredClone(value);
  }
  createWorkspace(): Promise<Workspace> { return this.transaction(() => this.createWorkspaceRecord()); }
  fileIdentityFailed():void {this.fileIdentity = 'uncertain';}
  private requireFileIdentity():void {
    if (this.fileIdentity === 'pending') throw new StateError('file_identity_busy','A file operation has not completed. Wait before another file or layout action.',503);
    if (this.fileIdentity === 'uncertain') throw new StateError('file_identity_uncertain','A file operation did not confirm its identity. Restart the backend and inspect both paths before another action.',503);
  }
  moveFiles(rootId:string,from:string,to:string,work:()=>Promise<FileMutation>):Promise<FileMutation> {return this.fileEntry(rootId,to,work,from);}
  createFiles(rootId:string,path:string,work:()=>Promise<FileMutation>):Promise<FileMutation> {return this.fileEntry(rootId,path,work);}
  /** Only admission and publication use the state queue; external file I/O never owns it. */
  private async fileEntry(rootId:string,to:string,work:()=>Promise<FileMutation>,from?:string):Promise<FileMutation> {
    await this.transaction(async()=> {
      this.requireFileIdentity();
      for (const current of this.workspaces.values()) {
        if (from !== undefined) movedWorkspace(current,rootId,from,to);
        else if (current.conversationLayout) moveLayoutFiles(structuredClone(current.conversationLayout.root),rootId,'',to,new Map());
      }
      this.fileIdentity = 'pending';
    });
    let timer:NodeJS.Timeout|undefined,confirmed = false;
    try {
      const deadline = new Promise<never>((_resolve,reject)=> {timer = setTimeout(()=>reject(new StateError('file_identity_uncertain','The file operation did not complete. Restart the backend and inspect both paths before another action.',503)),this.fileDeadlineMs);timer.unref();});
      const result = await Promise.race([work(),deadline]);confirmed = true;
      return await this.transaction(async()=> {
        if (this.fileIdentity !== 'pending') throw new StateError('file_identity_uncertain','File identities require a backend restart and inspection.',503);
        if (from !== undefined) {
          const changed = await this.persistMovedWorkspaces(rootId,from,to);
          if (this.fileIdentity !== 'pending') throw new StateError('file_identity_uncertain','File identities changed during workspace publication. Restart the backend and inspect both paths.',503);
          this.changed('files.changed',{rootId,directories:[],files:[],rescan:true,watch:'live',move:{from,to,kind:result.kind}});
          for (const value of changed) {this.workspaces.set(value.id,value);this.changed('workspace.changed',value,value.id);}
        }
        this.fileIdentity = 'ready';return result;
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const uncertain = this.fileIdentity === 'uncertain' || confirmed || code === 'file_identity_uncertain' || typeof code !== 'string';
      this.fileIdentity = uncertain ? 'uncertain' : 'ready';
      if (uncertain && code !== 'file_identity_uncertain') throw new StateError('file_identity_uncertain','The file operation did not confirm its complete identity. Restart the backend and inspect both paths.',503);
      throw error;
    } finally {clearTimeout(timer);}
  }
  private async persistMovedWorkspaces(rootId:string,from:string,to:string) {
    const changed = [...this.workspaces.values()].map(current=>movedWorkspace(current,rootId,from,to));
    try {for (const value of changed) await this.atomic(`workspaces/${value.id}.json`,value,LIMITS.requestBytes);}
    catch {throw new StateError('file_identity_uncertain','The file moved, but its workspace identity did not complete. Restart the backend and inspect both paths.',503);}
    return changed;
  }
  async workspaceList(includeArchived = false):Promise<Workspace[]> {await this.queue;return structuredClone([...this.workspaces.values()].filter(workspace=>includeArchived || this.workspaceActivity.get(workspace.id)?.archivedAt === undefined));}
  updateSelection(id: string, input: SelectionInput,guard?:(current:Workspace)=>void,layoutVersion?:number): Promise<Workspace> {
    return this.transaction(async () => {
      if (this.fileIdentity === 'uncertain' || input.conversationLayout !== undefined || input.filePositions !== undefined) this.requireFileIdentity();
      const current = this.requireWorkspace(id); revision(current.revision, input.expectedRevision, current);
      guard?.(structuredClone(current));
      validateSelection(input);validateLayoutWrite(current,input,layoutVersion);
      const value = selectedWorkspace(current, input,layoutVersion);
      await this.atomic(`workspaces/${id}.json`, value, LIMITS.requestBytes); this.workspaces.set(id, value);
      this.changed('workspace.changed', value, id); return structuredClone(value);
    });
  }
  private requireTarget(wid: string, key: string): StoredTarget {
    this.requireWorkspace(wid); const value = this.targetRecords.get(key);
    if (!value || value.workspaceId !== wid) throw new StateError('invalid_request', 'Unknown target key', 404); return value;
  }
  private targetView(value: StoredTarget): TargetState {
    const {workspaceId: _, imageLeases: __, draft: storedDraft, ...view} = value;
    const unconfirmed = [...this.inputPreviews.values()].filter(copy => copy.workspaceId === value.workspaceId && copy.targetKey === value.targetKey).map(copy => {
      const {targetKey: _, workspaceId: __, ...input} = copy;
      const record = this.operationRecords.get(copy.operationId);
      const origin = record?.queueRecovery ? {clearOperationId: record.queueRecovery.clearOperationId, recoveryOperationId: record.view.id} : copy.recoveryOrigin;
      return {...input, ...(record?.queueRecovery ? {queueRecovery: record.queueRecovery} : {}), ...(origin ? {sendGuard: this.recoveryGuard(origin)} : {})};
    });
    const retainedInputs: RetainedInput[] = [...this.operationRecords.values()].filter(record => record.workspaceId === value.workspaceId && record.input?.targetKey === value.targetKey && record.retainedInput).map(record => {
      const copy = this.retainedView(record); return {...copy, text: safeText(copy.text, 256), ...(copy.text.length > 256 ? {textTruncated: true as const} : {})};
    });
    const draft = this.draftView(storedDraft);
    const metadata = [...draft.images, ...unconfirmed.flatMap(copy => copy.images), ...retainedInputs.flatMap(copy => copy.images)];
    const imageAvailability = [...new Map(metadata.map(image => [image.digest, {digest: image.digest, state: this.imageReady(value.targetKey, image) ? 'ready' as const : 'unavailable' as const}])).values()];
    const result: TargetState = {...view, draft, unconfirmed: [], retainedInputs: [], imageAvailability, ...(this.imageIndex.error ? {imageStorageError: {code: 'image_storage_unavailable', message: this.imageIndex.error, retry: 'read' as const}} : {})};
    let bytes = Buffer.byteLength(JSON.stringify(result)) + 40;
    for (const input of unconfirmed) {
      const size = Buffer.byteLength(JSON.stringify(input)) + 1;
      if (bytes + size > LIMITS.displayBytes - 1024) { result.recoveryPreviewTruncated = true; continue; }
      result.unconfirmed.push(input); bytes += size;
    }
    for (const input of retainedInputs) {
      const size = Buffer.byteLength(JSON.stringify(input)) + 1;
      if (bytes + size > LIMITS.displayBytes - 1024) { result.recoveryPreviewTruncated = true; continue; }
      result.retainedInputs.push(input); bytes += size;
    }
    return structuredClone(result);
  }
  target(wid: string, target: Target): Promise<TargetState> {
    return this.transaction(async () => {
      this.requireWorkspace(wid); validateTarget(target);
      for (const value of this.targetRecords.values()) if (value.workspaceId === wid && sameTarget(value.target, target)) return this.targetView(value);
      if (this.targetRecords.size + this.refusedTargets.size >= LIMITS.targets) throw new StateError('capacity', 'Saved target limit reached', 429);
      const value: StoredTarget = {workspaceId: wid, targetKey: randomUUID(), target: structuredClone(target), draft: {revision: 0, text: '', mode: target.kind === 'agent' ? 'followUp' : 'prompt', images: [], persisted: true}, reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, presentation: {revision: 0, expanded: [], showThinking: false}};
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
    return [...this.targetRecords.values()].filter(value => value.workspaceId === wid).map(value => ({targetKey: value.targetKey, target: structuredClone(value.target), draftRevision: value.draft.revision, hasDraft: draftHasContent(value.draft), draftPreview: Array.from(value.draft.text).slice(0, LIMITS.draftPreviewChars).join(''), draftPreviewTruncated: Array.from(value.draft.text).length > LIMITS.draftPreviewChars, unconfirmedOperationIds: links.get(value.targetKey) ?? [], retainedInputOperationIds: [...this.operationRecords.values()].filter(record => record.workspaceId === wid && record.input?.targetKey === value.targetKey && record.retainedInput).map(record => record.view.id)}));
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
  async getRetainedInput(wid: string, id: string): Promise<RecoveryInput> {
    await this.queue; const record = this.record(id);
    if (record.workspaceId !== wid || !record.input || record.inputResolved && !record.retainedInput) throw new StateError('unknown_operation', 'No recovery copy exists', 404);
    const input = this.inputView(record);
    return record.retainedInput ? this.retainedView(record) : {...input, admission: 'unconfirmed'};
  }
  private async writeTarget(value: StoredTarget): Promise<void> {
    await this.atomic(`targets/${value.targetKey}.json`, value, 96 * 1024); this.targetRecords.set(value.targetKey, value);
  }
  putDraft(wid: string, key: string, input: DraftPut): Promise<DraftView> {
    return this.transaction(async () => {
      const value = this.requireTarget(wid, key); revision(value.draft.revision, input.expectedRevision, this.draftView(value.draft)); validateText(input.text); validateMode(input.mode);
      if (Object.keys(input).some(field => !['expectedRevision', 'text', 'mode', 'images', 'recoverySource'].includes(field))) throw new StateError('invalid_request', 'Unknown draft field');
      const images = normalizeDraftImages(input.images); this.validateDraftImageReferences(key, images);
      if (value.draft.recoveryOrigin && input.recoverySource !== undefined && input.recoverySource !== value.draft.recoveryOrigin.recoveryOperationId) throw new StateError('queue_recovery_provenance', 'Restore another saved copy before replacing this draft recovery source', 409);
      const recoveryOrigin = value.draft.recoveryOrigin ?? (input.recoverySource !== undefined ? this.sourceOrigin(wid, key, input.recoverySource) : undefined);
      const draft: StoredDraft = {revision: value.draft.revision + 1, text: input.text, mode: input.mode, images, persisted: true, ...(recoveryOrigin ? {recoveryOrigin} : {})};
      await this.writeTarget({...value, draft}); await this.cleanupImagesForMutation();
      const view = this.draftView(draft); this.changed('draft.changed', {targetKey: key, target: value.target, draft: view}, wid, value.target); return view;
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
      if (!Array.isArray(input.expanded) || input.expanded.length > 128 || input.expanded.some(id => typeof id !== 'string' || id.length > 256) || typeof input.showThinking !== 'boolean' || input.thinking !== undefined && !['shown', 'hidden'].includes(input.thinking) || input.transcriptView !== undefined && !['chronological', 'grouped'].includes(input.transcriptView)) throw new StateError('invalid_request', 'Invalid presentation preferences');
      const presentation: PresentationView = {revision: (value.presentation?.revision ?? 0) + 1, expanded: [...new Set(input.expanded)], showThinking: input.showThinking, ...(input.thinking ?? value.presentation?.thinking ? {thinking: input.thinking ?? value.presentation?.thinking} : {}), transcriptView: input.transcriptView ?? value.presentation?.transcriptView ?? 'chronological'};
      await this.writeTarget({...value, presentation}); return structuredClone(presentation);
    });
  }
  restoreRetainedInput(wid: string, id: string, expectedDraftRevision: number): Promise<DraftView> {
    return this.transaction(async () => {
      const record = this.record(id);
      if (record.workspaceId !== wid || !record.input || record.inputResolved && !record.retainedInput || record.view.state === 'dispatched') throw new StateError('unknown_operation', 'No settled recovery copy exists', 404);
      const value = this.requireTarget(wid, record.input.targetKey); revision(value.draft.revision, expectedDraftRevision, this.draftView(value.draft));
      const recoveryOrigin = record.queueRecovery ? this.sourceOrigin(wid, value.targetKey, id) : record.input.recoveryOrigin;
      const draft: StoredDraft = {revision: value.draft.revision + 1, text: record.input.text, mode: record.input.mode, images: normalizeDraftImages(record.input.images), persisted: true, ...(recoveryOrigin ? {recoveryOrigin} : {})};
      await this.writeTarget({...value, draft}); await this.cleanupImagesForMutation(); const view = this.draftView(draft);
      this.changed('draft.changed', {targetKey: value.targetKey, target: value.target, draft: view}, wid, value.target); return view;
    });
  }
  discardRetainedInput(wid: string, id: string): Promise<void> {
    return this.transaction(async () => {
      const record = this.record(id);
      if (record.workspaceId !== wid || !record.input) throw new StateError('unknown_operation', 'Unknown workspace recovery copy', 404);
      if (record.view.state === 'dispatched') throw new StateError('operation_conflict', 'An active dispatch copy cannot be discarded', 409);
      record.inputResolved = true; delete record.input; delete record.retainedInput; delete record.view.retainedInput;
      await this.writeOperation(record); await this.cleanupImagesForMutation();
    });
  }
  readSessionMetadata(): SessionMetadataRecord[] { return structuredClone(this.sessionMetadata); }
  getSessionMetadata(key:string):SessionMetadataRecord|undefined { return structuredClone(this.sessionMetadata.find(row=>row.key===key)); }
  putSessionMetadata(record: SessionMetadataRecord, action:'rename'|'archive'|'restore', guard: () => Promise<void>): Promise<void> {
    return this.transaction(async () => {
      await guard();
      const current=this.sessionMetadata.find(row=>row.key===record.key);
      const next={...record,...(action!=='rename'&&current?.name?{name:current.name}:{}),archived:action==='rename'?(current?.archived??record.archived):action==='archive'};
      const rows = this.sessionMetadata.filter(row => row.key !== record.key); rows.push(structuredClone(next));
      if (rows.length > LIMITS.rosterRows) throw new StateError('capacity','Session metadata capacity reached',429);
      await this.atomic('session-metadata.json',rows,LIMITS.rosterBytes); this.sessionMetadata = rows;
    });
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
    if (!value.input || value.inputResolved || value.retainedInput) { this.inputPreviews.delete(value.view.id); return; }
    const cached = this.inputPreviews.get(value.view.id);
    const text = cached && previous?.input?.text === value.input.text ? cached.text : safeText(value.input.text, 256);
    this.inputPreviews.set(value.view.id, {...value.input, images: normalizeDraftImages(value.input.images), workspaceId: value.workspaceId, text, ...(text !== value.input.text ? {textTruncated: true as const} : {})});
  }
  async writeOperation(value: OperationRecord): Promise<void> {
    if (!UUID.test(value.view.id)) throw new StateError('invalid_request', 'Invalid operation identity');
    if (this.refusedOperations.has(value.view.id)) throw new StateError('state_record_refused', 'A refused saved operation cannot be rewritten', 503);
    this.requireWorkspace(value.workspaceId); this.validateOperationInput(value);
    if (this.operationRecords.size + this.refusedOperations.size + (this.operationRecords.has(value.view.id) ? 0 : 1) + this.reservedQueueRows(value) > LIMITS.operations) throw new StateError('capacity', 'Operation record limit reached', 429);
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new StateError('payload_too_large', 'Operation exceeds its file limit', 413);
    const previous = this.operationRecords.get(value.view.id);
    const size = Buffer.byteLength(JSON.stringify(value));
    const total = this.operationBytes - (this.operationSizes.get(value.view.id) ?? 0) + size;
    if (total + this.refusedOperationBytes + this.reservedQueueRows(value) * 128 * 1024 > 32 * 1024 * 1024) throw new StateError('capacity', 'Operation store byte limit reached', 429);
    if (this.recoveryContentCount(value) + this.reservedQueueRows(value) > LIMITS.unconfirmed) throw new StateError('capacity', 'Recovery copy capacity is occupied', 429);
    await this.atomic(`operations/${value.view.id}.json`, value, 128 * 1024); this.operationRecords.set(value.view.id, structuredClone(value)); this.operationBytes = total; this.operationSizes.set(value.view.id, size);
    this.cacheInput(value, previous);
    this.changed('operation.changed', value.view, value.workspaceId, value.view.target); this.publishRecoveryGuards();
  }
  operationStoreBytes(): number { return this.operationBytes + this.refusedOperationBytes + this.reservedQueueRows() * 128 * 1024; }
  operationStoreCount(): number { return this.operationRecords.size + this.refusedOperations.size + this.reservedQueueRows(); }
  operationMetadata(): OperationMetadata[] {
    const protectedIds = this.protectedOperationIds();
    return [...this.operationRecords.values()].map(({view, workspaceId, input, inputResolved, retainedInput}) => ({workspaceId, inputResolved, ...(input ? {input: true as const} : {}), ...(retainedInput ? {retainedInput} : {}), ...(protectedIds.has(view.id) ? {protected: true} : {}), view: {id: view.id, kind: view.kind, state: view.state, createdAt: view.createdAt, updatedAt: view.updatedAt, ...(view.target ? {target: structuredClone(view.target)} : {})}}));
  }
  operationViews(wid: string): OperationView[] { return structuredClone([...this.operationRecords.values()].filter(value => value.workspaceId === wid && ['reserved', 'dispatched', 'uncertain'].includes(value.view.state)).map(value => value.view)); }
  unresolvedInputCount(): number { return this.retainedInputCount(); }
  retainedInputCount(): number { return this.recoveryContentCount() + this.reservedQueueRows(); }
  async deleteOperation(id: string): Promise<void> {
    const previous = this.operationRecords.get(id);
    if (!previous) throw new StateError('unknown_operation', 'Unknown operation', 404);
    if (this.protectedOperationIds().has(id) || previous.retainedInput) throw new StateError('operation_conflict', 'This operation still protects saved content', 409);
    await unlink(join(this.root, 'operations', `${id}.json`)); await syncDirectory(join(this.root, 'operations'));
    this.operationRecords.delete(id); this.operationBytes -= this.operationSizes.get(id) ?? 0; this.operationSizes.delete(id); this.inputPreviews.delete(id);
  }
  private validateOperationInput(record: OperationRecord): void {
    if (record.input) this.validateCapturedInput(record, record.input);
    if (record.queueRecovery) validateQueueRecovery(record.queueRecovery);
    this.validateRetainedInput(record);
    this.validateSentImages(record);
    this.validateQueueClear(record);
    record.view.retainedInput = record.retainedInput;
    if (!record.retainedInput) delete record.view.retainedInput;
  }
  private validateSentImages(record: OperationRecord): void {
    if (record.sentImages === undefined) return;
    try {
      const receipt = record.sentImages;
      if (Object.keys(receipt).length !== 3 || !UUID.test(receipt.targetKey) || record.view.kind !== 'agent.input' || record.view.state !== 'accepted' || record.view.receipt?.kind !== 'durable') throw new Error('Invalid sent-image receipt');
      const saved = this.requireTarget(record.workspaceId, receipt.targetKey);
      if (!sameTarget(saved.target, record.view.target) || saved.target.kind !== 'agent' || record.view.receipt.identity !== saved.target.identity) throw new Error('Wrong sent-image target');
      imageDigest(receipt.messageDigest); receipt.images = savedImages(receipt.images, 'input');
      if (!receipt.images.length) throw new Error('Empty sent-image receipt');
    } catch { throw new StateError('state_record_refused', 'Saved sent-image provenance is invalid', 503); }
  }
  /** Attachments are server-owned display metadata, never native input or recovery content. */
  enrichSentImages(wid: string, target: Target, entries: EntryView[], attachmentBytes = LIMITS.displayBytes - Buffer.byteLength(JSON.stringify(entries)) - 4096): number {
    if (!this.workspaces.has(wid)) return attachmentBytes;
    const receipts = this.sentImageReceipts(target);
    for (const entry of entries) for (const message of entry.messages ?? []) attachmentBytes = this.enrichSentImageMessage(message, receipts, attachmentBytes);
    return attachmentBytes;
  }
  private sentImageReceipts(target: Target): Map<string, SentImageSource> {
    const receipts = new Map<string, SentImageSource>();
    for (const record of this.operationRecords.values()) {
      if (!sameTarget(record.view.target, target)) continue;
      const receipt = record.sentImages;
      if (receipt) receipts.set(receipt.messageDigest, {workspaceId: record.workspaceId, receipt});
    }
    return receipts;
  }
  private enrichSentImageMessage(message: MessageView, receipts: ReadonlyMap<string, SentImageSource>, attachmentBytes: number): number {
    if (message.attachments) attachmentBytes += Buffer.byteLength(JSON.stringify({attachments: message.attachments})) - 1;
    delete message.attachments;
    const part = message.parts[0];
    if (message.role !== 'user' || message.parts.length !== 1 || part?.type !== 'text') return attachmentBytes;
    const source = receipts.get(imageMessageDigest(part.text));
    if (!source) return attachmentBytes;
    const attachments = sentImageAttachments(message, source.receipt, this.root, source.workspaceId);
    if (!attachments) return attachmentBytes;
    const bytes = Buffer.byteLength(JSON.stringify({attachments})) - 1;
    if (bytes <= attachmentBytes) { message.attachments = attachments; attachmentBytes -= bytes; }
    return attachmentBytes;
  }
  private validateRetainedInput(record: OperationRecord): void {
    if (!record.retainedInput) return;
    if (record.retainedInput === 'refused') {
      if (!record.input || record.view.state !== 'rejected' || record.inputResolved !== true) throw new StateError('operation_conflict', 'Refused recovery copy is invalid', 409);
      return;
    }
    if (!['queued-image', 'handled-image'].includes(record.retainedInput) || !record.input?.images?.length || record.view.receipt?.kind !== 'rpc' || record.view.receipt.disposition !== (record.retainedInput === 'queued-image' ? 'queued' : 'handled')) throw new StateError('operation_conflict', 'Protected image receipt is invalid', 409);
  }
  private retainedView(record: OperationRecord): RetainedInput {
    const input = this.inputView(record);
    if (record.retainedInput === 'refused') return {...input, admission: 'refused', ...(record.view.error ? {error: structuredClone(record.view.error)} : {})};
    if (!record.retainedInput || !record.view.receipt) throw new StateError('operation_conflict', 'Protected image receipt is unavailable', 409);
    return {...input, admission: record.retainedInput, receipt: structuredClone(record.view.receipt)};
  }
  private validateCapturedInput(record: OperationRecord, input: NonNullable<OperationRecord['input']>): void {
    validateText(input.text); validateMode(input.mode); validateTarget(input.target);
    if (this.refusedTargets.has(input.targetKey)) throw new StateError('state_record_refused', 'The captured input belongs to a refused saved target', 503);
    const saved = this.requireTarget(record.workspaceId, input.targetKey);
    if (!sameTarget(saved.target, input.target) || !sameTarget(record.view.target, input.target) || input.operationId !== record.view.id) throw new StateError('operation_conflict', 'Recovery copy target is invalid', 409);
    input.images = savedImages(input.images, 'input');
    if (input.recoveryOrigin) validateOrigin(input.recoveryOrigin);
    if (input.differentMessage !== undefined && input.differentMessage !== true) throw new StateError('invalid_request', 'Invalid different-message assertion');
  }
  private validateQueueClear(record: OperationRecord): void {
    if (record.queueClear) {
      const clear = record.queueClear;
      if (record.view.kind !== 'primary.control' || record.view.action !== 'clearQueue' || record.view.target?.kind !== 'primary' || clear.recoveryWorkspaceId !== record.workspaceId || !['prepared', 'retaining', 'retained', 'uncertain', 'refused'].includes(clear.phase) || !Number.isSafeInteger(clear.rowBudget) || clear.rowBudget < 0 || clear.rowBudget > LIMITS.unconfirmed || !Array.isArray(clear.imageCopies) || clear.imageCopies.length > LIMITS.unconfirmed) throw new StateError('queue_recovery_provenance', 'Queue clear metadata is invalid', 409);
      const ids = new Set<string>();
      for (const copy of clear.imageCopies) { if (!UUID.test(copy.workspaceId) || !UUID.test(copy.operationId) || ids.has(copy.operationId)) throw new StateError('queue_recovery_provenance', 'Queue clear member is invalid', 409); ids.add(copy.operationId); }
      if (clear.returned && (!Number.isSafeInteger(clear.returned.steering) || !Number.isSafeInteger(clear.returned.followUp) || clear.returned.steering < 0 || clear.returned.followUp < 0 || clear.returned.steering + clear.returned.followUp > LIMITS.unconfirmed)) throw new StateError('queue_recovery_provenance', 'Queue return counts are invalid', 409);
    }
  }
  private inputView(record: OperationRecord): UnconfirmedInput {
    if (!record.input) throw new StateError('unknown_operation', 'No recovery content exists', 404);
    const {targetKey: _, ...input} = record.input;
    const origin = record.queueRecovery ? {clearOperationId: record.queueRecovery.clearOperationId, recoveryOperationId: record.view.id} : input.recoveryOrigin;
    return {...structuredClone(input), images: normalizeDraftImages(input.images), ...(record.queueRecovery ? {queueRecovery: structuredClone(record.queueRecovery)} : {}), ...(origin ? {sendGuard: this.recoveryGuard(origin)} : {})};
  }
  private draftView(draft: StoredDraft): DraftView {
    return {...structuredClone(draft), images: normalizeDraftImages(draft.images), ...(draft.recoveryOrigin ? {recoverySendGuard: this.recoveryGuard(draft.recoveryOrigin)} : {})};
  }
  private sourceOrigin(wid: string, key: string, id: string): RecoveryOrigin {
    if (typeof id !== 'string' || !UUID.test(id)) throw new StateError('queue_recovery_provenance', 'Recovery source is invalid', 409);
    const source = this.operationRecords.get(id), saved = this.requireTarget(wid, key);
    if (!source?.queueRecovery || source.workspaceId !== wid || !sameTarget(source.view.target, saved.target) || source.input && source.input.targetKey !== key) throw new StateError('queue_recovery_provenance', 'Recovery source belongs to another target or is unavailable', 409);
    const origin = {clearOperationId: source.queueRecovery.clearOperationId, recoveryOperationId: id};
    if (this.recoveryGuard(origin).state === 'unavailable') throw new StateError('queue_recovery_provenance', 'Recovery provenance is unavailable', 409);
    return origin;
  }
  private clearImageMember(anchor: OperationRecord, member: QueueClearRecord['imageCopies'][number]): OperationRecord | undefined {
    const copy = this.operationRecords.get(member.operationId);
    return copy && copy.workspaceId === member.workspaceId && sameTarget(copy.view.target, anchor.view.target) && (copy.input || copy.inputResolved === true) ? copy : undefined;
  }
  private recoveryGuard(origin: RecoveryOrigin): RecoverySendGuard {
    const source = this.operationRecords.get(origin.recoveryOperationId), anchor = this.operationRecords.get(origin.clearOperationId);
    if (!source?.queueRecovery || source.queueRecovery.clearOperationId !== origin.clearOperationId || !anchor?.queueClear || !sameTarget(source.view.target, anchor.view.target) || source.workspaceId !== anchor.queueClear.recoveryWorkspaceId) return {state: 'unavailable', imageCopies: 0};
    let imageCopies = 0;
    for (const member of anchor.queueClear.imageCopies) {
      const record = this.clearImageMember(anchor, member);
      if (!record) return {state: 'unavailable', imageCopies};
      if (record.input?.images?.length && record.retainedInput !== 'refused' && (!record.inputResolved || record.retainedInput)) imageCopies++;
    }
    return {state: imageCopies ? 'blocked' : 'clear', imageCopies};
  }
  assertRecoverySendAllowed(origin: RecoveryOrigin, differentMessage?: true): void {
    validateOrigin(origin); const guard = this.recoveryGuard(origin);
    if (guard.state === 'unavailable') throw new StateError('queue_recovery_provenance', 'Recovery provenance is unavailable', 409);
    if (guard.state === 'blocked' && differentMessage !== true) throw new StateError('queue_recovery_guard', 'Image copies from this clear remain. Confirm that this is a different message before Send.', 409, guard);
  }
  private publishRecoveryGuards(): void {
    for (const value of this.targetRecords.values()) if (value.draft.recoveryOrigin) this.changed('draft.changed', {targetKey: value.targetKey, target: value.target, draft: this.draftView(value.draft)}, value.workspaceId, value.target);
  }
  private recoveryContentCount(next?: OperationRecord): number {
    let total = 0;
    for (const record of this.operationRecords.values()) if (record.view.id !== next?.view.id && record.input && (!record.inputResolved || record.retainedInput)) total++;
    return total + (next?.input && (!next.inputResolved || next.retainedInput) ? 1 : 0);
  }
  private reservedQueueRows(next?: OperationRecord): number {
    const rows = new Map<string, number>(), anchors = new Map<string, number>();
    const add = (record: OperationRecord) => {
      if (record.queueClear && !['retained', 'refused'].includes(record.queueClear.phase)) anchors.set(record.view.id, record.queueClear.rowBudget);
      if (record.queueRecovery) rows.set(record.queueRecovery.clearOperationId, (rows.get(record.queueRecovery.clearOperationId) ?? 0) + 1);
    };
    for (const record of this.operationRecords.values()) if (record.view.id !== next?.view.id) add(record);
    if (next) add(next);
    return [...anchors].reduce((sum, [id, budget]) => sum + Math.max(0, budget - (rows.get(id) ?? 0)), 0);
  }
  private protectOrigin(ids: Set<string>, origin?: RecoveryOrigin): void {
    if (origin) { ids.add(origin.clearOperationId); ids.add(origin.recoveryOperationId); }
  }
  private protectInputRecord(ids: Set<string>, record: OperationRecord): void {
    if (record.retainedInput || record.sentImages) ids.add(record.view.id);
    if (record.queueClear && !['retained', 'refused'].includes(record.queueClear.phase) && (record.queueClear.rowBudget || record.queueClear.returned)) ids.add(record.view.id);
    if (!record.input || record.inputResolved && !record.retainedInput) return;
    if (record.queueRecovery) ids.add(record.queueRecovery.clearOperationId);
    this.protectOrigin(ids, record.input.recoveryOrigin);
  }
  private protectClearMembers(ids: Set<string>, record: OperationRecord): void {
    if (!record.queueClear) return;
    for (const member of record.queueClear.imageCopies) {
      ids.add(member.operationId);
      if (!this.clearImageMember(record, member)) ids.add(record.view.id);
    }
  }
  private protectedOperationIds(): Set<string> {
    const ids = new Set<string>();
    for (const target of this.targetRecords.values()) this.protectOrigin(ids, target.draft.recoveryOrigin);
    for (const record of this.operationRecords.values()) this.protectInputRecord(ids, record);
    for (const record of this.operationRecords.values()) this.protectClearMembers(ids, record);
    for (const record of this.operationRecords.values()) if (record.queueRecovery && ids.has(record.queueRecovery.clearOperationId)) ids.add(record.view.id);
    return ids;
  }
  private assertClearImageProvenance(record: OperationRecord): void {
    if (!record.queueClear) return;
    for (const member of record.queueClear.imageCopies) {
      if (!this.clearImageMember(record, member)) throw new StateError('image_storage_unavailable', 'A clear-event image reference is incomplete; image deletion is not permitted', 503);
    }
  }
  private assertInputImageProvenance(record: OperationRecord): void {
    if (!record.input || record.inputResolved && !record.retainedInput) return;
    const origin = record.queueRecovery ? {clearOperationId: record.queueRecovery.clearOperationId, recoveryOperationId: record.view.id} : record.input.recoveryOrigin;
    if (origin && this.recoveryGuard(origin).state === 'unavailable') throw new StateError('image_storage_unavailable', 'An input recovery source is incomplete; image deletion is not permitted', 503);
  }
  private assertImageProvenance(): void {
    for (const target of this.targetRecords.values()) if (target.draft.recoveryOrigin && this.recoveryGuard(target.draft.recoveryOrigin).state === 'unavailable') throw new StateError('image_storage_unavailable', 'Recovery provenance is incomplete; image deletion is not permitted', 503);
    for (const record of this.operationRecords.values()) { this.assertClearImageProvenance(record); this.assertInputImageProvenance(record); }
  }
  private addInputImagePins(record: OperationRecord, add: (key: string, image: ValidatedImage, pin: {unresolved?: string; retained?: string}) => void): void {
    if (!record.input || record.inputResolved && !record.retainedInput) return;
    for (const image of record.input.images) add(record.input.targetKey, image, record.retainedInput ? {retained: record.view.id} : {unresolved: record.view.id});
  }
  imageGraphForMutation(): BlobReferenceGraph {
    this.assertImageProvenance();
    const graph: BlobReferenceGraph = {targetKeys: [...this.targetRecords.keys()], references: []};
    const entries = new Map<string, BlobReferenceGraph['references'][number]>();
    const add = (targetKey: string, image: ValidatedImage, pin: {draft?: boolean; unresolved?: string; retained?: string; lease?: string}) => {
      const id = `${targetKey}:${image.digest}`, previous = entries.get(id);
      if (previous && !sameImageContent(previous.image, image)) throw new StateError('image_storage_unavailable', 'Image references disagree about intrinsic metadata', 503);
      const value = previous ?? {targetKey, image: {digest: image.digest, mimeType: image.mimeType, bytes: image.bytes, width: image.width, height: image.height}, draft: false, unresolvedOperationIds: [], retainedOperationIds: []};
      if (pin.draft) value.draft = true;
      if (pin.unresolved) value.unresolvedOperationIds.push(pin.unresolved);
      if (pin.retained) value.retainedOperationIds.push(pin.retained);
      if (pin.lease) value.leaseExpiresAt = pin.lease;
      entries.set(id, value);
    };
    for (const target of this.targetRecords.values()) {
      for (const image of target.draft.images) add(target.targetKey, image, {draft: true});
      for (const lease of target.imageLeases ?? []) if (Date.parse(lease.expiresAt) > this.now()) add(target.targetKey, lease.image, {lease: lease.expiresAt});
    }
    for (const record of this.operationRecords.values()) {
      this.addInputImagePins(record, add);
      const receipt = record.sentImages;
      if (receipt) for (const image of receipt.images) add(receipt.targetKey, image, {retained: record.view.id});
    }
    graph.references = [...entries.values()]; return graph;
  }
  private checkAcknowledgedImageReferences(index: BlobIndex, graph: BlobReferenceGraph): void {
    index.unavailable = [];
    for (const reference of graph.references) {
      const entry = index.entries.find(value => value.targetKey === reference.targetKey && value.image.digest === reference.image.digest);
      if (entry && sameImageContent(entry.image, reference.image)) continue;
      index.unavailable.push({targetKey: reference.targetKey, digest: reference.image.digest});
      if (entry) index.error ??= 'Stored image metadata disagrees with its acknowledged reference; no cleanup or upload is permitted.';
    }
  }
  private async refreshImageIndex(): Promise<void> {
    if (this.imageRecordsRefused) { this.imageIndex.error = 'Saved image metadata is unavailable. Image cleanup and upload are disabled; saved bytes remain unchanged.'; return; }
    try {
      const graph = this.imageGraphForMutation();
      const index = await this.images.scan({targetKeys: graph.targetKeys, references: []});
      this.checkAcknowledgedImageReferences(index, graph); this.imageIndex = index;
    } catch { this.imageIndex.error = 'Image storage index is unavailable. No cleanup or upload is permitted.'; }
  }
  private async cleanupImagesForMutation(): Promise<void> {
    if (this.imageIndex.error) await this.refreshImageIndex();
    if (this.imageIndex.error) return;
    const graph = this.imageGraphForMutation();
    for (const entry of [...this.imageIndex.entries]) {
      if (graph.references.some(reference => reference.targetKey === entry.targetKey && reference.image.digest === entry.image.digest)) continue;
      try { await this.images.remove(entry); this.imageIndex.entries.splice(this.imageIndex.entries.indexOf(entry), 1); }
      catch { this.imageIndex.error = 'Image cleanup could not verify unreferenced content; no further cleanup or upload is permitted.'; return; }
    }
    for (const temp of [...this.imageIndex.temps]) {
      if (this.uploads.has(temp.id)) continue;
      try { await this.images.remove(temp); this.imageIndex.temps.splice(this.imageIndex.temps.indexOf(temp), 1); }
      catch { this.imageIndex.error = 'Image temporary cleanup failed; no further cleanup or upload is permitted.'; return; }
    }
  }
  private imageReady(targetKey: string, image: ValidatedImage): boolean {
    return !this.imageIndex.error && !this.imageIndex.unavailable?.some(entry => entry.targetKey === targetKey && entry.digest === image.digest) && this.imageIndex.entries.some(entry => entry.targetKey === targetKey && sameImageContent(entry.image, image));
  }
  validateDraftImageReferences(targetKey: string, images: readonly DraftImage[]): void {
    if (!images.length) return;
    const unavailableIndexes = images.flatMap((image, index) => this.imageIndex.unavailable?.some(entry => entry.targetKey === targetKey && entry.digest === image.digest) ? [index] : []);
    if (unavailableIndexes.length) throw new StateError('image_unavailable', 'Acknowledged image bytes are unavailable; their references remain recoverable', 409, {targetKey, missingIndexes: unavailableIndexes});
    if (this.imageIndex.error) throw new StateError('image_storage_unavailable', this.imageIndex.error, 503);
    const graph = this.imageGraphForMutation(); const missingIndexes: number[] = [];
    for (const [index, image] of images.entries()) {
      const entry = this.imageIndex.entries.find(value => value.targetKey === targetKey && value.image.digest === image.digest);
      if (entry && !sameImageContent(entry.image, image)) throw new StateError('invalid_image_reference', 'Image metadata does not match stored bytes', 409);
      const reference = graph.references.find(value => value.targetKey === targetKey && value.image.digest === image.digest);
      if (!entry || !reference) missingIndexes.push(index);
      else if (!sameImageContent(reference.image, image)) throw new StateError('invalid_image_reference', 'Image metadata does not match its reference', 409);
    }
    if (missingIndexes.length) throw new StateError('unknown_image_digest', 'Staged images expired or are unavailable; reacquire their local bytes before saving', 409, {targetKey, missingIndexes});
  }
  blobReadSpecForOperation(wid: string, key: string, images: readonly DraftImage[]): BlobReadSpec {
    this.requireTarget(wid, key); this.validateDraftImageReferences(key, images);
    return {root: this.root, targetKey: key, images: structuredClone([...images])};
  }
  reserveImageUpload(wid: string, key: string, input: {name: string; mimeType: DraftImage['mimeType']; epoch?: number; declaredBytes?: number}, guard: () => void): Promise<UploadReservation> {
    return this.transaction(async () => {
      const target = this.requireTarget(wid, key); guard();
      if (target.target.kind === 'primary' ? input.epoch !== target.target.epoch : input.epoch !== undefined) throw new StateError('stale_epoch', 'The image upload target changed', 409);
      if (!['image/png', 'image/jpeg'].includes(input.mimeType)) throw new StateError('invalid_request', 'Only PNG and JPEG uploads are supported');
      const name = imageName(input.name), maxBytes = input.declaredBytes ?? LIMITS.imageBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.imageBytes) throw new StateError('payload_too_large', 'Image intake exceeds its byte bound', 413);
      await this.cleanupImagesForMutation();
      if (this.imageIndex.error) throw new StateError('image_storage_unavailable', this.imageIndex.error, 503);
      this.assertImageUploadCapacity(key, maxBytes);
      const reservation: UploadReservation = {id: randomUUID(), workspaceId: wid, targetKey: key, target: structuredClone(target.target), mimeType: input.mimeType, name, maxBytes, ...(input.declaredBytes !== undefined ? {declaredBytes: input.declaredBytes} : {}), receiveDeadlineAt: Date.now() + LIMITS.imageReceiveMs};
      this.uploads.set(reservation.id, reservation); return structuredClone(reservation);
    });
  }
  private assertImageUploadCapacity(key: string, maxBytes: number): void {
      const leases = [...this.targetRecords.values()].flatMap(value => (value.imageLeases ?? []).filter(lease => Date.parse(lease.expiresAt) > this.now()).map(lease => ({targetKey: value.targetKey, lease})));
      const reservations = [...this.uploads.values()];
      const bytes = this.imageIndex.entries.reduce((sum, entry) => sum + entry.image.bytes, 0) + this.imageIndex.temps.filter(entry => !this.uploads.has(entry.id)).reduce((sum, entry) => sum + entry.bytes, 0) + reservations.reduce((sum, item) => sum + item.maxBytes, 0);
      if (reservations.length >= LIMITS.imageUploads || leases.length + reservations.length >= LIMITS.stagedImages || leases.filter(lease => lease.targetKey === key).length + reservations.filter(item => item.targetKey === key).length >= LIMITS.stagedImagesPerTarget || this.imageIndex.entries.length + this.imageIndex.temps.filter(entry => !this.uploads.has(entry.id)).length + reservations.length * 2 + 2 + new Set([...this.imageIndex.directories, ...reservations.map(item => item.targetKey), key]).size > LIMITS.blobEntries || bytes + maxBytes > LIMITS.blobStoreBytes) throw new StateError('capacity', 'Image storage or intake capacity is occupied', 429);
  }
  beginImageUpload(reservation: UploadReservation): Promise<BlobIntake> {
    return this.transaction(async () => {
      const held = this.uploads.get(reservation.id);
      if (!held || held.targetKey !== reservation.targetKey) throw new StateError('invalid_request', 'No image reservation exists');
      const intake = await this.images.begin(held);
      if (!this.imageIndex.directories.includes(held.targetKey)) this.imageIndex.directories.push(held.targetKey);
      return intake;
    });
  }
  finishImageUpload(reservation: UploadReservation, image: ValidatedImage, guard: () => void): Promise<ImageUploadView> {
    return this.transaction(async () => {
      const held = this.uploads.get(reservation.id);
      if (!held || !sameTarget(held.target, reservation.target) || held.targetKey !== reservation.targetKey) throw new StateError('invalid_request', 'No exact image reservation exists');
      const value = this.requireTarget(held.workspaceId, held.targetKey); guard();
      if (!sameTarget(value.target, held.target) || image.bytes > held.maxBytes || held.declaredBytes !== undefined && image.bytes !== held.declaredBytes || image.mimeType !== held.mimeType) throw new StateError('invalid_image_reference', 'The image intake does not match its reservation');
      normalizeDraftImages([{...image, name: held.name}]);
      const reference = this.imageGraphForMutation().references.find(entry => entry.targetKey === held.targetKey && entry.image.digest === image.digest);
      if (reference && !sameImageContent(reference.image, image)) throw new StateError('invalid_image_reference', 'Replacement bytes disagree with their acknowledged metadata', 409);
      try { await this.images.publish(held, image); } catch (error) { this.imageIndex.error = 'Image publication is uncertain; no cleanup or upload is permitted until storage is verified.'; throw error; }
      if (!this.imageIndex.entries.some(entry => entry.targetKey === held.targetKey && entry.image.digest === image.digest)) this.imageIndex.entries.push({targetKey: held.targetKey, image: structuredClone(image)});
      guard();
      const expiresAt = new Date(this.now() + LIMITS.imageLeaseMs).toISOString();
      const imageLeases = (value.imageLeases ?? []).filter(lease => lease.image.digest !== image.digest && Date.parse(lease.expiresAt) > this.now()); imageLeases.push({image: structuredClone(image), expiresAt});
      await this.writeTarget({...value, imageLeases}); this.uploads.delete(held.id);
      this.imageIndex.unavailable = this.imageIndex.unavailable?.filter(entry => entry.targetKey !== held.targetKey || entry.digest !== image.digest);
      return {targetKey: held.targetKey, target: structuredClone(held.target), image: {...image, name: held.name}, leaseExpiresAt: expiresAt};
    });
  }
  cancelImageUpload(reservation: UploadReservation): Promise<void> {
    const run = this.queue.then(async () => {
      const held = this.uploads.get(reservation.id); if (!held) return;
      try { await this.images.cancel(held); this.uploads.delete(held.id); }
      catch (error) { this.imageIndex.error = 'Image intake cleanup failed; reserved capacity remains occupied.'; throw error; }
    });
    this.queue = run.catch(() => {}); return run;
  }
  readDraftImage(wid: string, key: string, digest: string): Promise<ImageBytes> {
    return this.transaction(async () => {
      this.requireTarget(wid, key);
      const reference = this.imageGraphForMutation().references.find(value => value.targetKey === key && value.image.digest === digest);
      if (!reference) throw new StateError('image_unavailable', 'This target has no image reference or active lease', 404);
      return this.images.read(key, reference.image);
    });
  }

  async verifyImageCopiesBeforeQueueClear(target: Extract<Target, {kind: 'primary'}>): Promise<QueueClearRecord['imageCopies']> {
    const verified = new Set<string>();
    const copies: QueueClearRecord['imageCopies'] = [];
    for (const record of this.operationRecords.values()) {
      if (!record.input?.images?.length || record.retainedInput === 'refused' || !sameTarget(record.view.target, target) || record.inputResolved && !record.retainedInput) continue;
      this.validateDraftImageReferences(record.input.targetKey, record.input.images);
      for (const image of record.input.images) {
        const key = `${record.input.targetKey}:${image.digest}`;
        if (!verified.has(key)) { await this.images.verify(record.input.targetKey, image); verified.add(key); }
      }
      copies.push({workspaceId: record.workspaceId, operationId: record.view.id});
    }
    return copies;
  }
  canDiscardUnknownQueueClear(id: string): boolean {
    const record = this.operationRecords.get(id);
    if (!record?.queueClear || record.view.state !== 'uncertain' || record.queueClear.returned) return false;
    if (record.queueClear.imageCopies.some(member => !this.clearImageMember(record, member))) return false;
    return ![...this.operationRecords.values()].some(value => value.queueRecovery?.clearOperationId === id || value.input?.recoveryOrigin?.clearOperationId === id) && ![...this.targetRecords.values()].some(value => value.draft.recoveryOrigin?.clearOperationId === id);
  }
  draftForOperation(wid: string, key: string): TargetState { return this.targetView(this.requireTarget(wid, key)); }

  async clearSubmittedDraft(wid: string, input: NonNullable<OperationRecord['input']>): Promise<void> {
    const value = this.requireTarget(wid, input.targetKey);
    const matching = sameDraftTuple({...value.draft,mode:input.mode},input);
    if (value.draft.revision !== input.submittedDraftRevision && !(matching && value.draft.revision === input.submittedDraftRevision + 1)) return;
    // Advancing the captured revision fences an older save without discarding different draft content.
    const draft: StoredDraft = {...value.draft, revision: value.draft.revision + 1,...(matching ? {text:'',images:[],mode:input.mode} : {})};
    if (matching) delete draft.recoveryOrigin;
    await this.writeTarget({...value, draft}); await this.cleanupImagesForMutation();
    const view = this.draftView(draft); this.changed('draft.changed', {targetKey: value.targetKey, target: value.target, draft: view}, wid, value.target);
  }
}
