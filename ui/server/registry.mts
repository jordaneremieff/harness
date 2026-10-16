import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AgentError, createAgentService, type AgentService, type AgentServiceOptions } from '../agents/index.mts';
import { PrimarySession, type PrimarySessionOptions } from '../rpc/session.mts';
import { LIMITS, type AgentCapabilities, type Bootstrap, type EventData, type EventName, type PrimaryView, type ProjectedFrame, type Snapshot, type Target, type TargetPreparation } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import * as v from './validate.mts';
import { Journal, type Measure } from './journal.mts';
import { Operations } from './operations.mts';
import { StateStore } from './state.mts';
import { projectFrame, projectRoster, safeText } from './projection.mts';
import { pageEntries } from './history.mts';
import { budgetSnapshot } from './snapshot.mts';
import type { RequestContext, ImageUploadContext, ImageUploadHeaders } from './http.mts';
import { dispatchPrimary } from './routes-primary.mts';
import { dispatchAgent } from './routes-agent.mts';
import { dispatchView } from './routes-view.mts';
import { StoredAgentStarter, startIdentity, type StartOptions } from './agent-start.mts';
import { validateSessionProject } from './sessions.mts';
import type {Control} from './control.mts';
import type {OwnerConnection} from './owner-client.mts';
import type {OwnerDescriptor, OwnerStateIdentity, OwnerRecovery} from '../shared/owner.ts';

export type AgentAdapter = Pick<AgentService, 'roster' | 'rosterRow' | 'prepare' | 'refresh' | 'select' | 'hide' | 'reconnect' | 'history' | 'image' | 'imageInputAvailable' | 'inspect' | 'submit' | 'retrySubmit' | 'abort' | 'configure' | 'disconnectWorkspace' | 'close'> & {readonly available?:boolean};
export type RegistryOptions = {stateDir: string; cwd: string; executable: string; agentStore: string;
  agents?: (options: AgentServiceOptions) => AgentAdapter; primary?: (options: PrimarySessionOptions) => PrimarySession; measure?: Measure;
  agentStart?: Pick<StartOptions,'spawn'|'timeoutMs'|'agentDir'>;
  owner?: OwnerConnection; connectOwner?: (state: OwnerStateIdentity) => Promise<OwnerConnection>};
const live = (view: PrimaryView) => !['stopped','failed'].includes(view.lifecycle);
const ownsWriter = (session: PrimarySession) => !!session.client.child && !session.client.exited;
const needsStorage = (session: PrimarySession) => ownsWriter(session) || session.queueRecoveryPending;
const owned = (session: PrimarySession) => live(session.view) || ownsWriter(session);
async function canonicalMatch(path: string, expected: string): Promise<boolean> {
  try {return await realpath(path) === expected;} catch {return false;}
}
function preparationAvailability(code: string): TargetPreparation['availability'] {
  if(code === 'stored') return 'stored';
  return ['contract_mismatch','protocol_error','unsupported'].includes(code) ? 'incompatible' : 'unavailable';
}
interface AgentObservationSlot {epoch: number; afterEpoch: number; started: boolean; failed?: boolean}
interface WorkspaceObservation {version: number; dirty: boolean; desired: Map<string,AgentObservationSlot>; attached: Map<string,AgentObservationSlot>; running?: Promise<void>}
/** Process ownership is independent of browser connections and saved view state. */
export class Registry {
  control?:Control;
  readonly journal: Journal;
  readonly operations: Operations;
  readonly sessions = new Map<string, PrimarySession>();
  readonly saved = new Map<string, PrimaryView>();
  readonly availability = new Map<string, Map<string, EventData['agent.availability']>>();
  readonly frames = new Map<string, Map<string, {identity: string; connectionEpoch: number; frame: ProjectedFrame}>>();
  private readonly observations = new Map<string, WorkspaceObservation>();
  readonly agents: AgentAdapter;
  private readonly starter: StoredAgentStarter;
  private readonly starts = new Map<string,{identity:string; promise:Promise<TargetPreparation>}>();
  private closing = false;
  private shutdownReady = false;
  private finalization?: Promise<void>;
  private closePromise?: Promise<void>;
  private opens = new Set<Promise<string>>();
  private rosterRevision = 0;
  private metadataWrite: Promise<void> = Promise.resolve();
  private pendingMetadata?: PrimaryView[];
  private metadataDigest = '';
  private pathClaims = new Map<string, string>();
  private openingKeys = new Set<string>();
  readonly queueWorkspaces = new Map<string,string>();
  readonly store:StateStore; readonly options:RegistryOptions;
  private constructor(store: StateStore, options: RegistryOptions, journal: Journal) {
    this.store=store;this.options=options;this.journal = journal; this.operations = new Operations(store);
    this.starter = new StoredAgentStarter({store:options.agentStore,executable:options.executable,...options.agentStart});
    this.agents = (options.agents ?? createAgentService)({store: options.agentStore, stateDir: store.root, installationId: store.instanceId, agentDir: options.agentStart?.agentDir,
      onRoster: page => {
        const roster = projectRoster({...page,rows:page.changed??page.rows});
        this.rosterRevision++;
        for (let i = 0; i < roster.rows.length || i === 0; i += 16) this.journal.publish('agent.roster', undefined,
          {revision: this.rosterRevision, changed: roster.rows.slice(i,i+16), removed: i===0 ? page.removed??[] : [], scan: roster.scan, observedAt: roster.observedAt, stale: roster.stale});
      },
      onFrame: (workspaceId, identity, connectionEpoch, source) => {
        if (!this.admitObservation(workspaceId,identity,connectionEpoch)) return;
        const frame = projectFrame(source);
        const frames = this.frames.get(workspaceId) ?? new Map();
        frames.set(identity,{identity,connectionEpoch,frame}); this.frames.set(workspaceId,frames);
        this.journal.publish('agent.frame', {kind:'agent', identity}, {identity, connectionEpoch, frame}, workspaceId);
      },
      onAvailability: (workspaceId, identity, connectionEpoch, state, reason, supported) => {
        if (!this.admitObservation(workspaceId,identity,connectionEpoch)) return;
        const slot = this.observations.get(workspaceId)?.desired.get(identity);
        if(slot) slot.failed = state !== 'live';
        const capabilities = this.capabilities(identity,supported);
        const data={identity,connectionEpoch,state,...(reason ? {reason:safeText(reason,512)} : {}),capabilities};
        const availability = this.availability.get(workspaceId) ?? new Map();
        availability.set(identity,data); this.availability.set(workspaceId,availability);
        this.journal.publish('agent.availability', {kind:'agent',identity}, data, workspaceId);
      }});
  }
  static async open(options: RegistryOptions) {
    const journal = new Journal(undefined, options.measure);
    const store = await StateStore.open(options.stateDir, {recoverDeadLock:true,onChange: (name,data,workspace,target) => journal.publish(name,target,data,workspace)});
    try {
      if (options.connectOwner) options.owner = await options.connectOwner({root: store.root, instanceId: store.instanceId});
      const registry = new Registry(store, options, journal);
      for (const previous of await store.readPrimaries()) {
        registry.saved.set(previous.key, {...previous,lifecycle:'stopped',activity:'unknown',retry:undefined,responseOutcome:undefined,pid:undefined,pendingDialogs:[],contextUsage:undefined,usage:undefined,extension:undefined,
          capabilities: {input:false,control:false,handoff:false,history:false},lastError:{code:'not_ready',message:'Explicit resume is required after backend restart.',retry:'manual'}});
      }
      if (options.owner) await registry.attachOwned(options.owner);
      return registry;
    } catch (error) { await store.close(); throw error; }
  }
  private async attachOwned(owner: OwnerConnection) {
    if (owner.hello.state.root !== this.store.root || owner.hello.state.instanceId !== this.store.instanceId) throw new ApiError('operation_conflict', 'The raw owner belongs to another state identity.', 409);
    this.operations.retainWith({
      complete: async (record, result) => {const target = record.view.target; if (target?.kind === 'primary' && record.digest) await owner.complete(target.key, target.epoch, record.view.id, record.digest, result);},
      reconcile: async record => {const target = record.view.target; if (target?.kind === 'primary' && record.digest) return owner.reconcile(target.key, target.epoch, record.view.id, record.digest);},
      acknowledged: async record => {const target = record.view.target; if (target?.kind === 'primary' && record.digest) await owner.acknowledge(target.key, target.epoch, record.view.id);}
    });
    await this.importOwnerRecovery(owner);
    for (const descriptor of owner.hello.primaries) {
      if (descriptor.exited) continue;
      const previous = this.saved.get(descriptor.key);
      if (previous && previous.epoch !== descriptor.epoch) throw new ApiError('stale_epoch', 'Retained metadata and raw owner epochs differ.', 409);
      const session = this.createPrimary(descriptor.key, descriptor.cwd, descriptor.sessionFile, previous, descriptor);
      this.sessions.set(descriptor.key, session); this.saved.set(descriptor.key, session.view);
      this.queueWorkspaces.set(descriptor.key, descriptor.recoveryWorkspaceId);
      await session.start();
    }
    for (const record of this.store.operationMetadata()) if (record.view.target?.kind === 'primary' && ['uncertain', 'dispatched'].includes(record.view.state)) await this.operations.reconcile(record.view.id);
  }
  private async importOwnerRecovery(owner: OwnerConnection) {
    for (const recovery of await owner.request<OwnerRecovery[]>({kind: 'recoveries'})) {
      if (recovery.state.root !== this.store.root || recovery.state.instanceId !== this.store.instanceId || recovery.status !== 'returned' || recovery.response?.success !== true) throw new ApiError('not_ready', 'Raw owner queue recovery remains unresolved.', 503, 'manual');
      const queue = recovery.response.data as {steering?: unknown; followUp?: unknown};
      if (!queue || !Array.isArray(queue.steering) || !Array.isArray(queue.followUp) || [...queue.steering, ...queue.followUp].some(v => typeof v !== 'string')) throw new ApiError('not_ready', 'Raw owner queue recovery is malformed.', 503, 'manual');
      await this.operations.importOwnerQueue(recovery.id, recovery.workspaceId, {kind: 'primary', key: recovery.primary.key, epoch: recovery.primary.epoch}, recovery.pendingCount, queue as {steering: string[]; followUp: string[]});
      await owner.request({kind: 'recovery-ack', id: recovery.id});
    }
  }
  private capabilities(identity: string, supported?: Record<string,boolean>): AgentCapabilities {
    return {history: supported?.snapshot === true, observe: ['observe-open','observe-frame','observe-close','snapshot'].every(key=>supported?.[key] === true),
      input:supported?.['task-submit'] === true,images:supported?.['task-submit'] === true && this.agents.imageInputAvailable(identity),abort:supported?.abort === true,configure:false,inspect:supported?.inspect === true};
  }
  async prepareTarget(workspace: string, target: Extract<Target,{kind:'agent'}>): Promise<TargetPreparation> {
    let availability: TargetPreparation['availability'] = 'live';
    let supported: Record<string,boolean> | undefined;
    let reason: string | undefined;
    try { supported = await this.agents.prepare(target.identity); }
    catch(error) {
      if(error instanceof AgentError && ['stored','host_unavailable','not_ready','capacity','contract_mismatch','protocol_error','unsupported'].includes(error.code)) {
        availability = preparationAvailability(error.code);
        reason = safeText(error.message,512) || 'The agent host is unavailable.';
      } else if(error instanceof AgentError) throw new ApiError(error.code,safeText(error.message,512));
      else throw new ApiError('internal','Agent preparation failed.',500,'manual');
    }
    const record = this.observations.get(workspace); const slot = record?.desired.get(target.identity);
    if(availability === 'live' && record && slot?.failed) {
      record.desired.set(target.identity,{epoch:0,afterEpoch:slot.epoch,started:false});
      this.frames.get(workspace)?.delete(target.identity); this.availability.get(workspace)?.delete(target.identity);
      await this.observe(workspace);
    }
    return {targetState:await this.store.target(workspace,target),availability,capabilities:this.capabilities(target.identity,supported),...(reason ? {reason} : {})};
  }
  /** Request receipts are separate from input operations and never contain composer text. */
  startAgent(workspace: string, identity: string, requestId: string): Promise<TargetPreparation> {
    startIdentity(identity);
    if(!/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)) throw new ApiError('invalid_request','The agent start request ID is invalid.');
    if(this.closing) throw new ApiError('not_ready','The backend no longer accepts work.',503);
    const key = `${workspace}:${requestId}`; const prior = this.starts.get(key);
    if(prior) {
      if(prior.identity !== identity) throw new ApiError('operation_conflict','The start request ID belongs to another agent.',409);
      return prior.promise;
    }
    if(this.starts.size >= 2048) throw new ApiError('capacity','The agent start receipt capacity is full.',429);
    const promise = this.startAgentOnce(workspace,identity);
    this.starts.set(key,{identity,promise}); return promise;
  }
  private async startAgentOnce(workspace: string, identity: string): Promise<TargetPreparation> {
    await this.starter.start(identity);
    if(this.closing) throw new ApiError('not_ready','The backend closed. Agent work continues independently.',503,'read');
    await this.agents.refresh();
    let result: TargetPreparation;
    try { result = await this.prepareTarget(workspace,{kind:'agent',identity}); }
    catch { throw new ApiError('not_ready','Agent connection is not confirmed. Check connection; the host was not stopped.',503,'read'); }
    if(result.availability === 'live') await this.observe(workspace);
    return result;
  }
  async workspace(id?: string) { return (await this.store.workspace(id)).id; }
  moveFiles(rootId:string,from:string,to:string,work:()=>Promise<import('../shared/files.ts').FileMutation>) {return this.store.moveFiles(rootId,from,to,work);}
  createFiles(rootId:string,path:string,work:()=>Promise<import('../shared/files.ts').FileMutation>) {return this.store.createFiles(rootId,path,work);}
  fileIdentityFailed():void {this.store.fileIdentityFailed();}
  views() { return [...this.saved.values()].map(view=>structuredClone(this.sessions.get(view.key)?.view ?? view)); }
  primary(key: string, epoch?: number, requireReady = false) {
    const session = this.sessions.get(key);
    if (!session) throw new ApiError('not_ready', 'The primary requires explicit resume.', 503, 'manual');
    if (epoch !== undefined && epoch !== session.view.epoch) throw new ApiError('stale_epoch', 'The primary conversation changed.', 409, 'read');
    if (requireReady && session.view.lifecycle !== 'ready') throw new ApiError('not_ready', 'The primary is not ready.', 503, 'read');
    return session;
  }
  async validatePath(path: string, directory: boolean) {
    if (!isAbsolute(path) || path.length > LIMITS.pathChars) throw new ApiError('invalid_request', 'Use an absolute local path.');
    try {
      const canonical = await realpath(path); const info = await stat(canonical);
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('kind');
      return canonical;
    } catch { throw new ApiError('invalid_request', directory ? 'The project directory does not exist.' : 'The saved session file does not exist.'); }
  }
  async claimPath(path: string, key: string) {
    const owner = this.pathClaims.get(path);
    if (owner && owner !== key) throw new ApiError('operation_conflict', 'This saved session already has a backend writer.', 409, 'manual');
    this.pathClaims.set(path,key);
    try { await this.checkWriters(path,key); }
    catch(error) { if(owner !== key) this.releasePath(path,key); throw error; }
  }
  private async checkWriters(path:string,key:string) {
    for(const session of this.sessions.values()) {
      if(session.view.key === key || !owned(session) || !session.view.sessionFile) continue;
      let existing:string;
      try { existing=await realpath(session.view.sessionFile); }
      catch(error) {
        if(error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw new ApiError('not_ready','The existing primary writer path is unavailable.',503,'manual');
      }
      if(existing === path) throw new ApiError('operation_conflict','This saved session already has a backend writer.',409,'manual');
    }
  }
  private admitPrimary(reuse: boolean) {
    if (this.closing) throw new ApiError('not_ready','The backend no longer accepts primaries.',503);
    if ([...this.sessions.values()].filter(owned).length >= LIMITS.primaries || !reuse && this.saved.size >= 128) throw new ApiError('capacity','The primary capacity is full.',429);
  }
  private async retainedPrimary(cwd: string, path: string, workspaceId?: string): Promise<PrimaryView | undefined> {
    const matches: PrimaryView[] = [];
    for(const view of this.saved.values()) {
      if(view.sessionFile && await canonicalMatch(view.sessionFile,path)) matches.push(view);
    }
    if(!matches.length) return;
    const id = await validateSessionProject(cwd,path); const project = await realpath(cwd);
    const identities: PrimaryView[] = [];
    for(const view of matches) {
      if(view.sessionId === id && await canonicalMatch(view.cwd,project)) identities.push(view);
    }
    if(!identities.length) throw new ApiError('operation_conflict','The saved file no longer matches its retained conversation identity.',409,'manual');
    const workspace = workspaceId ? await this.store.workspace(workspaceId) : undefined;
    const preferred = identities.find(view => view.key === workspace?.primaryKey) ??
      identities.find(view => workspace?.selectedTarget?.kind === 'primary' && view.key === workspace.selectedTarget.key && view.epoch === workspace.selectedTarget.epoch);
    if(preferred) return preferred;
    if(identities.length !== 1) throw new ApiError('operation_conflict','More than one retained primary matches this saved conversation. Select its workspace first.',409,'manual');
    return identities[0];
  }
  releasePath(path: string, key: string) { if(this.pathClaims.get(path) === key) this.pathClaims.delete(path); }
  openPrimary(cwd: string, sessionFile?: string, workspaceId?: string) {
    const run=this.openOnce(cwd,sessionFile,workspaceId); this.opens.add(run);
    void run.finally(()=>this.opens.delete(run)).catch(()=>{}); return run;
  }
  private async queueWorkspace(key:string,workspaceId?:string):Promise<string|undefined> {
    if(!workspaceId&&this.options.owner)workspaceId=await this.workspace();
    if(workspaceId)this.queueWorkspaces.set(key,workspaceId);return workspaceId;
  }
  private async openOnce(cwd: string, sessionFile?: string, workspaceId?: string) {
    this.admitPrimary(true);
    if(sessionFile) sessionFile = await this.validatePath(sessionFile,false);
    const previous = sessionFile ? await this.retainedPrimary(cwd,sessionFile,workspaceId) : undefined;
    const key = previous?.key ?? randomUUID();
    const priorSession = this.sessions.get(key); const priorWorkspace = this.queueWorkspaces.get(key);
    if(this.openingKeys.has(key) || priorSession && (owned(priorSession) || needsStorage(priorSession))) throw new ApiError('operation_conflict','This primary already has a backend writer or an open in progress.',409,'manual');
    this.openingKeys.add(key);
    let session: PrimarySession; let claimed = false;
    try {
      if(sessionFile) {await this.claimPath(sessionFile,key); claimed = true;}
      workspaceId=await this.queueWorkspace(key,workspaceId);
      this.admitPrimary(previous !== undefined);
      session = this.createPrimary(key,cwd,sessionFile,previous);
      this.sessions.set(key,session); this.saved.set(key,session.view);
      await this.store.savePrimaries(this.views());
      if(this.closing) throw new ApiError('not_ready','The backend no longer accepts primaries.',503);
    } catch (error) {
      if(claimed && sessionFile) this.releasePath(sessionFile,key);
      await this.rollbackPrimary(key,previous,priorSession,priorWorkspace);
      throw error;
    } finally {this.openingKeys.delete(key);}
    void session.start().catch(()=>{}).finally(()=>this.metadataChanged());
    return key;
  }
  private createPrimary(key: string, cwd: string, sessionFile?: string, previous?: PrimaryView, descriptor?: OwnerDescriptor) {
    const owner = this.options.owner, epoch = descriptor?.epoch ?? previous?.epoch ?? 1;
    const recoveryWorkspaceId = descriptor?.recoveryWorkspaceId ?? this.queueWorkspaces.get(key);
    const primary = {key, cwd, sessionFile, epoch, executable: this.options.executable, recoveryWorkspaceId: recoveryWorkspaceId ?? ''};
    const session = (this.options.primary ?? (options=>new PrimarySession(options)))({key,cwd,sessionFile,epoch,executable:this.options.executable,
      ...(owner ? {transport: owner.factory(primary, descriptor), attach: !!descriptor, recoveryWorkspaceId, ownerIdentity: `${owner.hello.ownerIncarnation}:${key}:${epoch}`} : {}),
      measure:this.options.measure ? (stage,id,at,bytes)=>this.options.measure?.(stage,`${key}:${id}`,at,bytes) : undefined,
      publish: (name,target,data) => this.publish(name,target,data), onChange:()=>this.metadataChanged(),
      onBeforeClearQueue: async (target, pendingCount) => this.operations.beginQueueClear(this.queueWorkspaces.get(key) ?? await this.workspace(), target, pendingCount),
      onRecoveredQueue: (clearOperationId, queue) => this.operations.retainQueue(clearOperationId, queue),
      onQueueClearFailed: (clearOperationId, uncertain) => this.operations.settleQueueClearFailure(clearOperationId, uncertain)});
    if(previous) {session.view.sessionId = previous.sessionId; session.view.sessionFile = sessionFile;}
    return session;
  }
  private async rollbackPrimary(key: string, previous: PrimaryView | undefined, priorSession: PrimarySession | undefined, priorWorkspace: string | undefined) {
    if(priorSession) this.sessions.set(key,priorSession); else this.sessions.delete(key);
    if(previous) this.saved.set(key,previous); else this.saved.delete(key);
    if(priorWorkspace) this.queueWorkspaces.set(key,priorWorkspace); else this.queueWorkspaces.delete(key);
    try {await this.store.savePrimaries(this.views());} catch {this.journal.publish('notice',undefined,{level:'error',code:'state_write_failed',message:'Primary metadata rollback was not saved.'});}
  }
  publish(name: EventName, target: Target | undefined, data: EventData[EventName]) {
    this.journal.publish(name,target,data);
    if (name === 'primary.state' && target?.kind === 'primary') {
      const view = data as PrimaryView; this.saved.set(view.key,view);
      this.releaseExited(view.key);
      if (!live(view)) void this.operations.markUncertain(target).catch(()=>{});
      this.finalizeAfterExit();
    }
  }
  private releaseExited(key:string) {
    const session=this.sessions.get(key); if(session && owned(session)) return;
    for(const [path,owner] of this.pathClaims) if(owner === key) this.pathClaims.delete(path);
  }
  private finalizeAfterExit() {
    if(this.closing && this.shutdownReady && ![...this.sessions.values()].some(needsStorage)) void this.finalize().catch(()=>{});
  }
  private metadataChanged() {
    const values = this.views(); const digest = JSON.stringify(values.map(({activity:_,pendingDialogs:__,...view})=>view));
    if (digest === this.metadataDigest) return; this.metadataDigest = digest; this.pendingMetadata = values;
    this.metadataWrite = this.metadataWrite.then(async()=> {
      const next = this.pendingMetadata; this.pendingMetadata = undefined;
      if(next) await this.store.savePrimaries(next);
    }).catch(()=> { this.journal.publish('notice',undefined,{level:'error',code:'state_write_failed',message:'Primary metadata was not saved.'}); });
  }
  private visibleAgents(workspace: Snapshot['workspace']): string[] {
    const identities: string[] = [];
    const visit = (node: NonNullable<Snapshot['workspace']['conversationLayout']>['root']) => {
      if(node.kind === 'split') {visit(node.first);visit(node.second);return;}
      const target = node.tabs.find(tab => tab.kind === 'agent' && `agent:${tab.identity}` === node.active);
      if(target?.kind === 'agent') identities.push(target.identity);
    };
    if(workspace.conversationLayout) visit(workspace.conversationLayout.root);
    return identities;
  }
  private admitObservation(workspace: string, identity: string, epoch: number): boolean {
    const slot = this.observations.get(workspace)?.desired.get(identity);
    if(this.closing || !this.journal.workspaceClients(workspace) || !slot?.started || !Number.isSafeInteger(epoch) || epoch <= slot.afterEpoch || epoch < slot.epoch) return false;
    if(slot.epoch !== epoch) this.frames.get(workspace)?.delete(identity);
    slot.epoch = epoch; return true;
  }
  async snapshot(workspaceId?: string, bootstrap = false): Promise<Snapshot | Bootstrap> {
    const workspace = await this.store.workspace(workspaceId);
    if (workspace.primaryKey) {
      const view = this.sessions.get(workspace.primaryKey)?.view ?? this.saved.get(workspace.primaryKey);
      if(view) await this.store.target(workspace.id,{kind:'primary',key:view.key,epoch:view.epoch});
    }
    for(const identity of this.visibleAgents(workspace)) await this.store.target(workspace.id,{kind:'agent',identity});
    return this.store.transaction(async()=> {
      const cut = this.store.snapshot(workspace.id); const primaries = this.views();
      const active = primaries.find(view=>view.key === cut.workspace.primaryKey);
      const identities = this.visibleAgents(cut.workspace);
      const targets = cut.targets.filter(state=>(state.target.kind === 'primary' && state.target.key === active?.key && state.target.epoch === active.epoch) ||
        (state.target.kind === 'agent' && identities.includes(state.target.identity)));
      const selected = cut.workspace.selectedTarget;
      const observations = identities.map(identity => {
        const slot = this.observations.get(workspace.id)?.desired.get(identity);
        const cached = this.frames.get(workspace.id)?.get(identity);
        return {identity,connectionEpoch:slot?.epoch ?? 0,...(cached && cached.connectionEpoch === slot?.epoch ? {frame:structuredClone(cached.frame)} : {omitted:true as const})};
      });
      const primary = selected?.kind === 'primary' ? this.sessions.get(selected.key) : active ? this.sessions.get(active.key) : undefined;
      const result: Snapshot = {observations,bootId:this.journal.bootId,cursor:this.journal.cursor,workspace:cut.workspace,primaries,roster:projectRoster(this.agents.roster({limit:20})),
        notices:this.journal.notices(workspace.id),dialogs:primaries.flatMap(view=>view.pendingDialogs),targetIndex:cut.targetIndex,pendingOperations:this.store.operationViews(workspace.id).filter(view=>['reserved','dispatched','uncertain'].includes(view.state)),targets,
        ...(primary ? {selectedPage:pageEntries(primary.entries,primary.target,primary.coverage,{limit:50})} : {})};
      return bootstrap ? budgetSnapshot({...result,limits:LIMITS,launchCwd:this.options.cwd}) : budgetSnapshot(result);
    });
  }
  async observe(workspaceId: string): Promise<void> {
    let record = this.observations.get(workspaceId);
    if(!record) {
      if(this.observations.size >= 16) throw new ApiError('capacity','Workspace observation capacity reached.',429);
      record = {version:0,dirty:false,desired:new Map(),attached:new Map()}; this.observations.set(workspaceId,record);
    }
    const version = ++record.version;
    const workspace = await this.store.workspace(workspaceId);
    if(record.version !== version || this.closing) return;
    const identities = this.journal.workspaceClients(workspaceId) ? this.visibleAgents(workspace) : [];
    const next = new Map<string, AgentObservationSlot>();
    for(const identity of identities) next.set(identity,record.desired.get(identity) ?? {epoch:0,afterEpoch:record.attached.get(identity)?.epoch ?? 0,started:false});
    record.desired = next; record.dirty = true;
    this.pruneObservationCache(workspaceId,next);
    await this.runObservations(workspaceId,record);
    this.pruneEmptyObservations(workspaceId,record,version);
  }
  private pruneEmptyObservations(workspace: string, record: WorkspaceObservation, version: number): void {
    if(record.version === version && !record.desired.size && !record.attached.size && this.observations.get(workspace) === record) {
      this.observations.delete(workspace); this.frames.delete(workspace); this.availability.delete(workspace);
    }
  }
  private pruneObservationCache(workspace: string, wanted: ReadonlyMap<string,AgentObservationSlot>): void {
    for(const identity of this.frames.get(workspace)?.keys() ?? []) if(!wanted.has(identity)) this.frames.get(workspace)?.delete(identity);
    for(const identity of this.availability.get(workspace)?.keys() ?? []) if(!wanted.has(identity)) this.availability.get(workspace)?.delete(identity);
  }
  private runObservations(workspace: string, record: WorkspaceObservation): Promise<void> {
    record.running ??= this.reconcileObservations(workspace,record).finally(() => {
      record.running = undefined;
      if(record.dirty && !this.closing) return this.observe(workspace);
    });
    return record.running;
  }
  private async removeDepartedObservations(workspace: string, record: WorkspaceObservation): Promise<void> {
    for(const [identity,slot] of record.attached) if(record.desired.get(identity) !== slot) {
      await this.agents.hide(workspace,identity); record.attached.delete(identity);
    }
  }
  private async selectDesiredObservations(workspace: string, record: WorkspaceObservation): Promise<void> {
    for(const [identity,slot] of record.desired) {
      if(this.closing) return;
      if(record.attached.get(identity) === slot) continue;
      slot.started = true; record.attached.set(identity,slot);
      try {await this.agents.select(workspace,identity);}
      catch(error) {slot.failed = true; this.journal.publish('notice',{kind:'agent',identity},{level:'warning',code:'observation_unavailable',message:safeText(error instanceof Error ? error.message : 'Agent observation failed.',512)},workspace);}
      if(record.dirty) return;
    }
  }
  private async reconcileObservations(workspace: string, record: WorkspaceObservation): Promise<void> {
    while(record.dirty && !this.closing) {
      record.dirty = false;
      await this.removeDepartedObservations(workspace,record);
      await this.selectDesiredObservations(workspace,record);
      if(record.dirty) continue;
      if(!record.desired.size && !this.journal.workspaceClients(workspace)) await this.agents.disconnectWorkspace(workspace);
    }
  }
  detached(workspaceId: string) {
    if(!this.journal.workspaceClients(workspaceId)) void this.observe(workspaceId).catch(()=>{});
  }
  async uploadImage(context: ImageUploadContext, headers: ImageUploadHeaders, body: AsyncIterable<Uint8Array>): Promise<unknown> {
    const workspace = v.string(context.parts[2], 'workspace ID'), key = v.string(context.parts[4], 'target key');
    const saved = await this.store.getTarget(workspace, key);
    const allowed = saved.target.kind === 'primary' ? ['name', 'epoch'] : ['name'];
    for (const name of context.url.searchParams.keys()) if (!allowed.includes(name) || context.url.searchParams.getAll(name).length !== 1) throw new ApiError('invalid_request', 'Image intake query is invalid.');
    if (context.url.searchParams.getAll('name').length !== 1) throw new ApiError('invalid_request', 'Image intake requires one display name.');
    const name = v.imageName(context.url.searchParams.get('name'));
    const epoch = saved.target.kind === 'primary' ? v.integer(Number(context.url.searchParams.get('epoch')), 'primary epoch', 1) : undefined;
    if (saved.target.kind === 'primary' && context.url.searchParams.getAll('epoch').length !== 1) throw new ApiError('invalid_request', 'Image intake requires one primary epoch.');
    context.checkActive();
    if (this.closing) throw new ApiError('not_ready', 'The backend no longer accepts work.', 503);
    if (saved.target.kind === 'agent') await this.agents.prepare(saved.target.identity);
    const guard = () => {
      context.checkActive();
      if (this.closing) throw new ApiError('not_ready', 'The backend no longer accepts work.', 503);
      if (saved.target.kind === 'primary') this.primary(saved.target.key, saved.target.epoch, true);
      else if (!this.agents.imageInputAvailable(saved.target.identity)) throw new ApiError('unsupported', 'This connection does not accept images. Use a file reference.', 409);
    };
    const reservation = await this.store.reserveImageUpload(workspace, key, {name, mimeType: headers.mimeType, epoch, declaredBytes: headers.declaredBytes}, guard);
    try {
      const intake = await this.store.beginImageUpload(reservation);
      for await (const chunk of body) { guard(); await intake.write(chunk); }
      guard(); const image = await intake.finish();
      return await this.store.finishImageUpload(reservation, image, guard);
    } finally { await this.store.cancelImageUpload(reservation); }
  }
  async dispatch(context: RequestContext): Promise<unknown> {
    if(this.closing) throw new ApiError('not_ready','The backend no longer accepts work.',503);
    const family = context.parts[1];
    if(family === 'primaries') return dispatchPrimary(this,context);
    if(family === 'agents') return dispatchAgent(this,context);
    return dispatchView(this,context);
  }
  async detach(): Promise<void> {
    this.closing = true; this.starter.close();
    await Promise.all([...this.opens]);
    await Promise.all([...this.sessions.values()].map(session => session.detach()));
    await this.agents.close(); await this.metadataWrite; await this.store.savePrimaries(this.views());
    await this.store.close(); this.options.owner?.close(); this.journal.close();
  }
  close():Promise<void> {
    if(this.shutdownReady && ![...this.sessions.values()].some(needsStorage)) return this.finalize();
    this.closePromise ??= this.closeOnce().catch(error => {this.closePromise = undefined; throw error;}); return this.closePromise;
  }
  private async closeOnce() {
    this.closing = true; this.starter.close(); this.journal.close();
    await Promise.allSettled([...this.opens]);
    const results = await Promise.allSettled([...this.sessions.values()].map(session=>session.close()).concat(this.agents.close()));
    this.shutdownReady=true;
    if([...this.sessions.values()].some(needsStorage)) throw new ApiError('not_ready','A primary writer or queue recovery remains owned; the state lock stays held.',503,'manual');
    await this.finalize();
    if(results.some(result=>result.status === 'rejected')) throw new ApiError('not_ready','A primary did not confirm orderly exit.',503,'manual');
  }
  private finalize() {
    if([...this.sessions.values()].some(needsStorage)) return Promise.reject(new ApiError('not_ready','Primary queue recovery or writer ownership prevents state closure.',503,'manual'));
    this.finalization ??= (async()=> {await this.metadataWrite; await this.store.savePrimaries(this.views()); await this.store.close();})()
      .catch(error => {this.finalization = undefined; throw error;});
    return this.finalization;
  }
}
