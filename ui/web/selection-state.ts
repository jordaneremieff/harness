import type { EventData, TargetPreparation, Workspace } from '../shared/api.ts';
import type {ControlProvenance} from '../shared/control.ts';
import type { SelectionChange } from './actions.ts';
import {movedWorkspaceFiles, type FileMove} from './file-identity.ts';
export function navigationState(workspace: Workspace | undefined, narrow: boolean, drawerOpen = false): {sidebarVisible: boolean; agentSelected: boolean; editor: 'primary-editor' | 'agent-editor'} {
  const agentSelected = workspace?.selectedTarget?.kind === 'agent';
  return {sidebarVisible: narrow ? drawerOpen : workspace?.sidebarVisible !== false, agentSelected, editor: agentSelected ? 'agent-editor' : 'primary-editor'};
}
export function visibleReceipt(workspace?: Workspace): 'primary-receipt' | 'agent-receipt' {
  return workspace?.selectedTarget?.kind === 'agent' ? 'agent-receipt' : 'primary-receipt';
}
export type MessageCapture = {workspaceId: string; identity: string; generation: number; prepared?: TargetPreparation; preparing: boolean; invalidated?: boolean; error?: string};
type MessageHooks = {workspace: () => Workspace | undefined; prepare: (workspaceId: string, target: {kind: 'agent'; identity: string}) => Promise<TargetPreparation>; paint: () => void};
export class MessageTarget {
  private generation = 0;
  current?: MessageCapture;
  private hooks: MessageHooks;
  constructor(hooks: MessageHooks) { this.hooks = hooks; }
  close(): void { this.generation++; this.current = undefined; }
  valid(captured: MessageCapture): boolean {
    const workspace = this.hooks.workspace();
    return this.current === captured && captured.generation === this.generation && workspace?.id === captured.workspaceId;
  }
  rosterChanged(data: EventData['agent.roster']): void {
    const current = this.current; if (!current) return;
    const changed = data.changed.find(row => row.identity === current.identity);
    if (data.removed.includes(current.identity) || (changed && changed.availability !== 'live')) this.invalidate();
  }
  availabilityChanged(data: EventData['agent.availability']): void {
    if (data.identity === this.current?.identity && (data.state !== 'live' || !data.capabilities.input)) this.invalidate();
  }
  private invalidate(): void {
    const current = this.current; if (!current) return;
    current.invalidated = true; current.error = 'Message access changed. Your draft is unchanged.';
  }
  async open(identity: string): Promise<void> {
    const workspace = this.hooks.workspace(); if (!workspace) return;
    const captured: MessageCapture = {workspaceId: workspace.id, identity, generation: ++this.generation, preparing: true};
    this.current = captured; this.hooks.paint();
    try {
      const prepared = await this.hooks.prepare(captured.workspaceId, {kind: 'agent', identity: captured.identity});
      if (!this.valid(captured)) return;
      if (prepared.targetState.target.kind !== 'agent' || prepared.targetState.target.identity !== captured.identity) throw new Error('The message recipient changed. Your draft is unchanged.');
      captured.prepared = prepared;
    } catch (error) {
      if (!this.valid(captured)) return;
      captured.error = error instanceof Error ? error.message : String(error);
    }
    captured.preparing = false; this.hooks.paint();
  }
  recovery(): {label: string; run: () => Promise<void>} | undefined {
    const captured = this.current;
    if (!captured || !this.valid(captured) || captured.preparing || this.ready || (!captured.error && !captured.prepared)) return undefined;
    return {label: captured.error && !captured.invalidated ? 'Try again' : 'Check agent', run: () => this.retry(captured)};
  }
  private async retry(captured: MessageCapture): Promise<void> {
    if (!this.valid(captured) || captured.preparing) return;
    await this.open(captured.identity);
  }
  get ready(): boolean { const current = this.current; return !!current && this.valid(current) && !current.invalidated && current.prepared?.availability === 'live' && current.prepared.capabilities.input; }
}
export type SelectionHooks = {current: () => Workspace | undefined; save: (workspace: Workspace, change: SelectionChange, control?:ControlProvenance) => Promise<Workspace>; reload: () => Promise<void>; paint: (workspace: Workspace, pending: boolean) => void};
/** Cached selection appears immediately; backend revisions advance in one ordered lane. */
export class SelectionQueue {
  private lanes = new Map<string,{committed:Workspace; pending:Map<number,SelectionChange>}>();
  private serial = 0;
  private tail = Promise.resolve();
  private inFlight = 0;
  private hooks: SelectionHooks;
  get unsettled(): boolean {return this.inFlight > 0;}
  async drain(): Promise<void> {let tail: Promise<void>; do {tail = this.tail; await tail;} while (tail !== this.tail);}
  constructor(hooks: SelectionHooks) {this.hooks = hooks;}
  private lane(workspace:Workspace) {
    let lane = this.lanes.get(workspace.id);
    if (!lane) {lane = {committed:workspace,pending:new Map()};this.lanes.set(workspace.id,lane);}
    else if (workspace.revision > lane.committed.revision) lane.committed = workspace;
    return lane;
  }
  private overlay(lane:{committed:Workspace;pending:Map<number,SelectionChange>}):Workspace {
    let workspace = lane.committed;
    for (const change of lane.pending.values()) workspace = {...workspace,...change,selectedTarget:change.selectedTarget === null ? undefined : change.selectedTarget ?? workspace.selectedTarget,filePositions:{...workspace.filePositions,...change.filePositions}};
    return workspace;
  }
  private paint(workspaceId:string):void {
    const lane = this.lanes.get(workspaceId);
    if (lane && this.hooks.current()?.id === workspaceId) this.hooks.paint(this.overlay(lane),lane.pending.size > 0);
  }
  observe(workspace:Workspace):Workspace {return this.overlay(this.lane(workspace));}
  remapFiles(workspaceId:string,move:FileMove):Workspace|undefined {
    const lane = this.lanes.get(workspaceId);if (!lane) return;
    lane.committed = movedWorkspaceFiles(lane.committed,move);
    for (const [id,change] of lane.pending) {const moved = movedWorkspaceFiles({id:workspaceId,revision:0,...change} as Workspace,move);lane.pending.set(id,{...change,...(change.conversationLayout ? {conversationLayout:moved.conversationLayout} : {}),...(change.filePositions ? {filePositions:moved.filePositions} : {})});}
    return this.overlay(lane);
  }
  private async failed(workspaceId:string,id:number,error:unknown):Promise<void> {
    const lane = this.lanes.get(workspaceId);if (!lane) return;
    lane.pending.delete(id);this.paint(workspaceId);
    if (this.hooks.current()?.id !== workspaceId) return;
    if (!lane.pending.size) await this.hooks.reload();
    if (this.hooks.current()?.id === workspaceId) throw error;
  }
  select(input:SelectionChange):Promise<void> {return this.enqueue(input).then(()=>undefined);}
  selectControl(input:SelectionChange,control:ControlProvenance):Promise<Workspace> {
    if(this.unsettled) return Promise.reject(new Error('The selection lane is busy.'));
    return this.enqueue(input,structuredClone(control)).then(value=> {if(!value)throw new Error('The workspace changed.');return value;});
  }
  private enqueue(input:SelectionChange,control?:ControlProvenance):Promise<Workspace|undefined> {
    const current = this.hooks.current(); if (!current) return Promise.resolve(undefined);
    const workspaceId = current.id, lane = this.lane(current), id = ++this.serial, change = structuredClone(input);
    this.inFlight++;lane.pending.set(id,change);this.paint(workspaceId);
    const task = this.tail.then(async()=> {
      let saved:Workspace;
      try {
        const result = await this.hooks.save(lane.committed,lane.pending.get(id) ?? change,control);
        if (result.id !== workspaceId) throw new Error('The saved workspace identity changed.');
        this.observe(result);saved = result;
      } catch (error) {await this.failed(workspaceId,id,error);if(control)throw error;return;}
      lane.pending.delete(id);this.paint(workspaceId);
      if (!lane.pending.size && this.hooks.current()?.id === workspaceId) {
        await this.hooks.reload();
        const current = this.hooks.current(); if (current?.id === workspaceId) {this.observe(current);this.paint(workspaceId);}
      }
      return saved;
    }).finally(()=> {this.inFlight--;});
    this.tail = task.then(()=>undefined,()=>undefined);return task;
  }
}
