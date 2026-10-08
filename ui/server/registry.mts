import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createAgentService, type AgentService, type AgentServiceOptions } from '../agents/index.mts';
import { PrimarySession, type PrimarySessionOptions } from '../rpc/session.mts';
import { LIMITS, type AgentCapabilities, type Bootstrap, type EventData, type EventName, type PrimaryView, type ProjectedFrame, type Snapshot, type Target } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import { Journal, type Measure } from './journal.mts';
import { Operations } from './operations.mts';
import { StateStore } from './state.mts';
import { projectFrame, projectRoster, safeText } from './projection.mts';
import { pageEntries } from './history.mts';
import { budgetSnapshot } from './snapshot.mts';
import type { RequestContext } from './http.mts';
import { dispatchPrimary } from './routes-primary.mts';
import { dispatchAgent } from './routes-agent.mts';
import { dispatchView } from './routes-view.mts';

export type AgentAdapter = Pick<AgentService, 'roster' | 'rosterRow' | 'refresh' | 'select' | 'hide' | 'reconnect' | 'history' | 'inspect' | 'submit' | 'retrySubmit' | 'abort' | 'configure' | 'disconnectWorkspace' | 'close'>;
export type RegistryOptions = {stateDir: string; cwd: string; executable: string; agentStore: string;
  agents?: (options: AgentServiceOptions) => AgentAdapter; primary?: (options: PrimarySessionOptions) => PrimarySession; measure?: Measure};
const live = (view: PrimaryView) => !['stopped','failed'].includes(view.lifecycle);
const ownsWriter = (session: PrimarySession) => !!session.client.child && !session.client.exited;
const owned = (session: PrimarySession) => live(session.view) || ownsWriter(session);
/** Process ownership is independent of browser connections and saved view state. */
export class Registry {
  readonly journal: Journal;
  readonly operations: Operations;
  readonly sessions = new Map<string, PrimarySession>();
  readonly saved = new Map<string, PrimaryView>();
  readonly availability = new Map<string, EventData['agent.availability']>();
  readonly frames = new Map<string, {identity: string; connectionEpoch: number; frame: ProjectedFrame}>();
  readonly agents: AgentAdapter;
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
  readonly queueWorkspaces = new Map<string,string>();
  readonly store:StateStore; readonly options:RegistryOptions;
  private constructor(store: StateStore, options: RegistryOptions, journal: Journal) {
    this.store=store;this.options=options;this.journal = journal; this.operations = new Operations(store);
    this.agents = (options.agents ?? createAgentService)({store: options.agentStore, installationId: store.instanceId,
      onRoster: page => {
        const roster = projectRoster({...page,rows:page.changed??page.rows});
        this.rosterRevision++;
        for (let i = 0; i < roster.rows.length || i === 0; i += 16) this.journal.publish('agent.roster', undefined,
          {revision: this.rosterRevision, changed: roster.rows.slice(i,i+16), removed: i===0 ? page.removed??[] : [], scan: roster.scan, observedAt: roster.observedAt, stale: roster.stale});
      },
      onFrame: (workspaceId, identity, connectionEpoch, source) => {
        const frame = projectFrame(source); this.frames.set(workspaceId, {identity, connectionEpoch, frame});
        this.journal.publish('agent.frame', {kind:'agent', identity}, {identity, connectionEpoch, frame}, workspaceId);
      },
      onAvailability: (workspaceId, identity, state, reason, supported) => {
        const capabilities = this.capabilities(supported);
        const data={identity,state,...(reason ? {reason:safeText(reason,512)} : {}),capabilities};
        this.availability.set(workspaceId,data);
        this.journal.publish('agent.availability', {kind:'agent',identity}, data, workspaceId);
      }});
  }
  static async open(options: RegistryOptions) {
    const journal = new Journal(undefined, options.measure);
    const store = await StateStore.open(options.stateDir, {onChange: (name,data,workspace,target) => journal.publish(name,target,data,workspace)});
    try {
      const registry = new Registry(store, options, journal);
      for (const previous of await store.readPrimaries()) {
        registry.saved.set(previous.key, {...previous,lifecycle:'stopped',activity:'unknown',pid:undefined,pendingDialogs:[],contextUsage:undefined,usage:undefined,extension:undefined,
          capabilities: {input:false,control:false,handoff:false,history:false},lastError:{code:'not_ready',message:'Explicit resume is required after backend restart.',retry:'manual'}});
      }
      return registry;
    } catch (error) { await store.close(); throw error; }
  }
  private capabilities(supported?: Record<string,boolean>): AgentCapabilities {
    return {history: supported?.snapshot === true, observe: ['observe-open','observe-frame','observe-close','snapshot'].every(key=>supported?.[key] === true),
      input:supported?.['task-submit'] === true,abort:supported?.abort === true,configure:false,inspect:supported?.inspect === true};
  }
  async workspace(id?: string) { return (await this.store.workspace(id)).id; }
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
  private admitPrimary() {
    if (this.closing) throw new ApiError('not_ready','The backend no longer accepts primaries.',503);
    if ([...this.sessions.values()].filter(owned).length >= LIMITS.primaries || this.saved.size >= 128) throw new ApiError('capacity','The primary capacity is full.',429);
  }
  releasePath(path: string, key: string) { if(this.pathClaims.get(path) === key) this.pathClaims.delete(path); }
  openPrimary(cwd: string, sessionFile?: string, workspaceId?: string) {
    const run=this.openOnce(cwd,sessionFile,workspaceId); this.opens.add(run);
    void run.finally(()=>this.opens.delete(run)).catch(()=>{}); return run;
  }
  private async openOnce(cwd: string, sessionFile?: string, workspaceId?: string) {
    this.admitPrimary();
    const key = randomUUID(); let session: PrimarySession;
    try {
      if(sessionFile) await this.claimPath(sessionFile,key);
      this.admitPrimary();
      session = (this.options.primary ?? (options=>new PrimarySession(options)))({key,cwd,sessionFile,executable:this.options.executable,
        measure:this.options.measure ? (stage,id,at,bytes)=>this.options.measure?.(stage,`${key}:${id}`,at,bytes) : undefined,
        publish: (name,target,data) => this.publish(name,target,data), onChange:()=>this.metadataChanged(),
        onRecoveredQueue:async queue=>this.operations.retainQueue(this.queueWorkspaces.get(key)??await this.workspace(),{kind:'primary',key,epoch:session.view.epoch},queue)});
      this.sessions.set(key,session); this.saved.set(key,session.view);
      if(workspaceId) this.queueWorkspaces.set(key,workspaceId);
      await this.store.savePrimaries(this.views());
      if(this.closing) throw new ApiError('not_ready','The backend no longer accepts primaries.',503);
    } catch (error) { if(sessionFile) this.releasePath(sessionFile,key); this.sessions.delete(key); this.saved.delete(key); throw error; }
    void session.start().catch(()=>{}).finally(()=>this.metadataChanged());
    return key;
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
    if(this.closing && this.shutdownReady && ![...this.sessions.values()].some(ownsWriter)) void this.finalize().catch(()=>{});
  }
  private metadataChanged() {
    const values = this.views(); const digest = JSON.stringify(values.map(({activity:_,pendingDialogs:__,...view})=>view));
    if (digest === this.metadataDigest) return; this.metadataDigest = digest; this.pendingMetadata = values;
    this.metadataWrite = this.metadataWrite.then(async()=> {
      const next = this.pendingMetadata; this.pendingMetadata = undefined;
      if(next) await this.store.savePrimaries(next);
    }).catch(()=> { this.journal.publish('notice',undefined,{level:'error',code:'state_write_failed',message:'Primary metadata was not saved.'}); });
  }
  private selectedAgent(workspaceId:string,target?:Target) {
    if(target?.kind !== 'agent') return;
    const source=this.agents.rosterRow(target.identity); if(!source) return;
    const row=projectRoster({rows:[source]}).rows[0]; if(!row) return;
    const observed=this.availability.get(workspaceId);
    return observed?.identity === target.identity ? {...row,availability:observed.state,capabilities:structuredClone(observed.capabilities)} : row;
  }
  async snapshot(workspaceId?: string, bootstrap = false): Promise<Snapshot | Bootstrap> {
    const workspace = await this.store.workspace(workspaceId);
    if (workspace.primaryKey) {
      const view = this.sessions.get(workspace.primaryKey)?.view ?? this.saved.get(workspace.primaryKey);
      if(view) await this.store.target(workspace.id,{kind:'primary',key:view.key,epoch:view.epoch});
    }
    if(workspace.selectedTarget) await this.store.target(workspace.id,workspace.selectedTarget);
    return this.store.transaction(async()=> {
      const cut = this.store.snapshot(workspace.id); const primaries = this.views();
      const active = primaries.find(view=>view.key === cut.workspace.primaryKey);
      const targets = cut.targets.filter(state=>(state.target.kind === 'primary' && state.target.key === active?.key && state.target.epoch === active.epoch) ||
        (state.target.kind === 'agent' && cut.workspace.selectedTarget?.kind === 'agent' && state.target.identity === cut.workspace.selectedTarget.identity));
      const selected = cut.workspace.selectedTarget;
      const frame = this.frames.get(workspace.id);
      const primary = selected?.kind === 'primary' ? this.sessions.get(selected.key) : active ? this.sessions.get(active.key) : undefined;
      const result: Snapshot = {selectedAgent:this.selectedAgent(workspace.id,selected),bootId:this.journal.bootId,cursor:this.journal.cursor,workspace:cut.workspace,primaries,roster:projectRoster(this.agents.roster({limit:20})),
        notices:this.journal.notices(workspace.id),dialogs:primaries.flatMap(view=>view.pendingDialogs),targetIndex:cut.targetIndex,pendingOperations:this.store.operationViews(workspace.id).filter(view=>['reserved','dispatched','uncertain'].includes(view.state)),targets,
        ...(selected?.kind === 'agent' && frame?.identity === selected.identity ? {selectedFrame:structuredClone(frame.frame)} : {}),
        ...(primary ? {selectedPage:pageEntries(primary.entries,primary.target,primary.coverage,{limit:50})} : {})};
      return bootstrap ? budgetSnapshot({...result,limits:LIMITS,launchCwd:this.options.cwd}) : budgetSnapshot(result);
    });
  }
  async observe(workspaceId: string) {
    const workspace = await this.store.workspace(workspaceId);
    if(workspace.panelVisible !== false && workspace.selectedTarget?.kind === 'agent') await this.agents.select(workspaceId,workspace.selectedTarget.identity);
  }
  detached(workspaceId: string) {
    if (!this.journal.workspaceClients(workspaceId)) void this.agents.disconnectWorkspace(workspaceId).catch(()=>{});
  }
  async dispatch(context: RequestContext): Promise<unknown> {
    if(this.closing) throw new ApiError('not_ready','The backend no longer accepts work.',503);
    const family = context.parts[1];
    if(family === 'primaries') return dispatchPrimary(this,context);
    if(family === 'agents') return dispatchAgent(this,context);
    return dispatchView(this,context);
  }
  close():Promise<void> {
    if(this.shutdownReady && ![...this.sessions.values()].some(ownsWriter)) return this.finalize();
    this.closePromise ??= this.closeOnce(); return this.closePromise;
  }
  private async closeOnce() {
    this.closing = true; this.journal.close();
    await Promise.allSettled([...this.opens]);
    const results = await Promise.allSettled([...this.sessions.values()].map(session=>session.close()).concat(this.agents.close()));
    this.shutdownReady=true;
    if([...this.sessions.values()].some(ownsWriter)) throw new ApiError('not_ready','A primary writer remains owned; the state lock stays held.',503,'manual');
    await this.finalize();
    if(results.some(result=>result.status === 'rejected')) throw new ApiError('not_ready','A primary did not confirm orderly exit.',503,'manual');
  }
  private finalize() {
    this.finalization ??= (async()=> {await this.metadataWrite; await this.store.savePrimaries(this.views()); await this.store.close();})();
    return this.finalization;
  }
}
