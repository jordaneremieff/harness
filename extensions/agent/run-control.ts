import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import * as native from "@earendil-works/pi-durable";
import type { CommitPublication, ConversationId, Harness, SubmissionId, TaskId, Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { agentChildrenDoc, type AgentChild } from "./children.ts";
import { canonicalIdentity } from "./identity.ts";
import { ResultReferenceSchema, type ResultReference } from "./result-reference.ts";
import { agentRunControlDoc } from "./run-control-state.ts";

const Children = agentChildrenDoc(native);
const RunControl = agentRunControlDoc(native);
const MAX_DELEGATIONS = 64;
const MAX_INPUTS = 200;
export type RunScope = { sessionId: string; runId: number | null; taskId: number | null; inputs: ResultReference[]; delegations: Delegation[]; coverage: { complete: boolean; omitted: number } };
export type Delegation = { sessionId: string; createdBy: number; result?: ResultReference; reporterTaskId?: number; anchorTaskId?: number; ownership: "created" | "reused" };
export type StoppedDelegation = { sessionId: string; runId?: number; state: "stopped" | "settled" | "cancelled" | "protected" | "unavailable"; reason?: string };
export type RunStop = { sessionId: string; runId: number; state: "stopped" | "settled" | "partial" | "protected"; inputs: ResultReference[]; delegations: StoppedDelegation[]; coverage: { complete: boolean; omitted: number }; effects: "partial-effects-possible" };
export type ForeignStop = (results: readonly ResultReference[], context: Context) => Promise<StoppedDelegation>;
type Control = (method: string, input: Record<string, unknown>) => Promise<unknown>;
type StopOptions = { inputs?: readonly ResultReference[]; foreign?: ForeignStop; visited?: Set<string> };
type Target = { harness: Harness; storageId: string; conversationId: ConversationId; runId: SubmissionId; context: Context; identity: string };
type Group = { identity: string; runId?: SubmissionId; taskId?: TaskId; inputs: ResultReference[]; inputCount: number; complete: boolean };
type ScopeRows = { delegations: Delegation[]; omitted: number };
type NativeTask = NonNullable<Awaited<ReturnType<Tx["task"]>>>;

function delegationState(state: string): StoppedDelegation["state"] {
	switch (state) { case "stopped": case "settled": case "protected": return state; default: return "unavailable"; }
}
function targetReferences(references: readonly ResultReference[]): string {
	const sessionId = references[0]?.sessionId;
	if (!sessionId || references.length > MAX_DELEGATIONS || references.some(reference => reference.sessionId !== sessionId)) throw new Error("Foreign cancellation requires one bounded target group");
	return sessionId;
}
async function withdrawReferences(references: readonly ResultReference[], cancel: (reference: ResultReference) => Promise<{ state: string }>) {
	let cancelled = false;
	const remaining: ResultReference[] = [];
	for (const reference of references) {
		const receipt = await cancel(reference);
		if (receipt.state === "aborted") cancelled = true;
		else if (receipt.state === "already_placed" || receipt.state === "settled") remaining.push(reference);
		else throw new Error("The exact delegated input did not confirm its cancellation state");
	}
	return { cancelled, remaining };
}
async function stopOwnedGroups(references: readonly ResultReference[], context: Context, stop: (reference: ResultReference) => Promise<RunStop>): Promise<RunStop[]> {
	const covered = new Set<number>(), rows: RunStop[] = [];
	for (const reference of references) {
		if (covered.has(reference.submissionId)) continue;
		context.abortSignal?.throwIfAborted();
		const row = await stop(reference); rows.push(row);
		covered.add(reference.submissionId);
		for (const input of row.inputs) if (input.sessionId === reference.sessionId) covered.add(input.submissionId);
	}
	return rows;
}
function delegationSummary(sessionId: string, rows: readonly RunStop[], cancelled: boolean): StoppedDelegation {
	const states = rows.map(row => delegationState(row.state));
	if (states.includes("unavailable")) return { sessionId, state: "unavailable", reason: "A delegated native group did not confirm complete cancellation" };
	if (states.includes("protected")) return { sessionId, state: "protected", reason: "Unrelated input shares a delegated native group" };
	return { sessionId, state: states.includes("stopped") ? "stopped" : cancelled ? "cancelled" : "settled", ...(rows.length === 1 ? { runId: rows[0].runId } : {}) };
}
export async function stopForeignReferences(control: Control, references: readonly ResultReference[], context: Context): Promise<StoppedDelegation> {
	const sessionId = targetReferences(references);
	const withdrawn = await withdrawReferences(references, async result => await control("request-cancel", { sessionId, result }) as { state: string });
	const rows = await stopOwnedGroups(withdrawn.remaining, context, async reference => await control("run-stop", { sessionId, runId: reference.submissionId, inputs: references }) as RunStop);
	return delegationSummary(sessionId, rows, withdrawn.cancelled);
}

async function underTask(tx: Tx, taskId: TaskId, root: TaskId): Promise<boolean> {
	const seen = new Set<number>();
	let selected: TaskId | undefined = taskId;
	while (selected !== undefined && seen.size < 64 && !seen.has(selected)) {
		if (selected === root) return true;
		seen.add(selected);
		selected = (await tx.task(selected))?.owner;
	}
	return false;
}
async function belongsToGroup(tx: Tx, taskId: TaskId, group: Group): Promise<boolean> {
	if (group.taskId !== undefined && await underTask(tx, taskId, group.taskId)) return true;
	const task = await tx.task(taskId);
	if (!task) return false;
	const state = await tx.doc(RunControl, task.conversationId, String(taskId), null);
	if (group.taskId === undefined && state.recorded && !state.complete) group.complete = false;
	const related = state.recorded && state.inputs.some(id => group.inputs.some(input => input.submissionId === id));
	if (related) includeRecordedInputs(group, state.inputs, state.complete);
	return related;
}
function includeRecordedInputs(group: Group, ids: readonly number[], complete: boolean): void {
	group.complete &&= complete;
	for (const id of ids) {
		if (group.inputs.some(input => input.submissionId === id)) continue;
		if (group.inputs.length === MAX_INPUTS) { group.complete = false; continue; }
		group.inputs.push({ sessionId: group.identity, submissionId: id });
		group.inputCount = Math.max(group.inputCount, group.inputs.length);
	}
}
function selectGroup(live: native.LiveState, identity: string, selected?: SubmissionId): Group {
	const runId = selected ?? live.run?.inputs[0];
	const active = runId !== undefined && live.run?.inputs.includes(runId) ? live.run : undefined;
	const ids = active?.inputs ?? (runId === undefined ? [] : [runId]);
	return { identity, runId, taskId: active?.taskId, inputs: ids.slice(0, MAX_INPUTS).map(submissionId => ({ sessionId: identity, submissionId })), inputCount: ids.length, complete: true };
}
function appendDelegation(rows: ScopeRows, row: Delegation): void {
	const existing = rows.delegations.find(item => item.sessionId === row.sessionId && item.createdBy === row.createdBy);
	if (existing) { Object.assign(existing, row, { ownership: existing.ownership === "created" ? "created" : row.ownership }); return; }
	if (rows.delegations.length === MAX_DELEGATIONS) { rows.omitted++; return; }
	rows.delegations.push(row);
}
function createdRow(storageId: string, child: AgentChild): Delegation {
	return { sessionId: child.foreignSessionId ?? canonicalIdentity(storageId, child.conversationId as ConversationId), createdBy: child.createdBy, ownership: "created", ...(child.anchorTaskId === undefined ? {} : { anchorTaskId: child.anchorTaskId }), ...(child.result === undefined ? {} : { result: { ...child.result } }) };
}
async function collectCreated(tx: Tx, storageId: string, conversationId: ConversationId, group: Group, rows: ScopeRows): Promise<void> {
	const children = (await tx.doc(Children, conversationId)).children;
	rows.omitted += Math.max(0, children.length - 256);
	for (const child of children.slice(-256)) if (await belongsToGroup(tx, child.createdBy, group)) appendDelegation(rows, createdRow(storageId, child));
}
async function collectDispatch(tx: Tx, group: Group, rows: ScopeRows, task: NativeTask): Promise<void> {
	const state = await tx.doc(RunControl, task.conversationId, String(task.id), null);
	if (!await belongsToGroup(tx, task.id, group) || !state.dispatch) return;
	if (!Value.Check(ResultReferenceSchema, state.result)) { rows.omitted++; return; }
	appendDelegation(rows, { sessionId: state.result.sessionId, createdBy: task.id, result: { ...state.result }, ownership: "reused" });
}
async function collectDispatches(tx: Tx, conversationId: ConversationId, group: Group, rows: ScopeRows): Promise<void> {
	let cursor: native.Cursor | undefined;
	for (let index = 0; index < 2; index++) {
		const page = await tx.scanTasks({ conversationId, kind: native.ToolTask.definition.name, order: "descending" }, 128, cursor);
		for (const task of page.items) await collectDispatch(tx, group, rows, task);
		cursor = page.next;
		if (!cursor) break;
	}
	if (cursor) rows.omitted++;
}
function reporterTarget(task: NativeTask | undefined): ConversationId | undefined {
	const input = task?.input;
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	return typeof input.conversationId === "number" ? input.conversationId as ConversationId : undefined;
}
async function collectReporter(tx: Tx, storageId: string, group: Group, rows: ScopeRows, createdBy: TaskId, reporterId: TaskId): Promise<void> {
	if (!await belongsToGroup(tx, createdBy, group)) return;
	const target = reporterTarget(await tx.task(reporterId));
	if (target === undefined) { rows.omitted++; return; }
	const sessionId = canonicalIdentity(storageId, target);
	const submission = await tx.submissionByRequest(target, `agent-deliver:${reporterId}`);
	const result = submission === undefined ? undefined : { sessionId, submissionId: submission.id, ...(submission.requestId === undefined ? {} : { requestId: submission.requestId }) };
	appendDelegation(rows, { sessionId, createdBy, reporterTaskId: reporterId, ownership: "reused", ...(result === undefined ? {} : { result }) });
}
async function collectReporters(tx: Tx, storageId: string, conversationId: ConversationId, group: Group, rows: ScopeRows): Promise<void> {
	const reporters = Object.entries((await tx.doc(Children, conversationId)).reporters);
	rows.omitted += Math.max(0, reporters.length - 256);
	for (const [createdBy, reporterId] of reporters.slice(-256)) await collectReporter(tx, storageId, group, rows, Number(createdBy) as TaskId, reporterId as TaskId);
}
async function scopeInCommit(tx: Tx, storageId: string, conversationId: ConversationId, selected?: SubmissionId, inputCount?: { total: number }): Promise<RunScope> {
	const group = selectGroup(await tx.doc(native.LiveDoc, conversationId), canonicalIdentity(storageId, conversationId), selected);
	const rows: ScopeRows = { delegations: [], omitted: 0 };
	if (group.runId !== undefined) {
		await collectDispatches(tx, conversationId, group, rows);
		await collectCreated(tx, storageId, conversationId, group, rows);
		await collectReporters(tx, storageId, conversationId, group, rows);
	}
	if (inputCount) inputCount.total = group.inputCount;
	rows.omitted += Math.max(0, group.inputCount - MAX_INPUTS) + (!group.complete && group.inputCount <= MAX_INPUTS ? 1 : 0);
	return { sessionId: group.identity, runId: group.runId ?? null, taskId: group.taskId ?? null, inputs: group.inputs, delegations: rows.delegations, coverage: { complete: rows.omitted === 0, omitted: rows.omitted } };
}
export async function readRunScope(harness: Harness, storageId: string, conversationId: ConversationId, context: Context): Promise<RunScope> {
	const scope = await harness.commit(tx => scopeInCommit(tx, storageId, conversationId), context);
	for (const input of scope.inputs) {
		const record = await (await harness.submission(input.submissionId as SubmissionId, context))?.status(context);
		if (record?.requestId !== undefined) input.requestId = record.requestId;
	}
	return scope;
}
export async function cancelRequest(harness: Harness, storageId: string, result: ResultReference, conversationId: ConversationId, context: Context) {
	if (result.sessionId !== canonicalIdentity(storageId, conversationId)) throw new Error("Cancellation result belongs to another conversation");
	const status = await (await harness.submission(result.submissionId as SubmissionId, context))?.status(context);
	if (status?.type !== "input" || status.conversationId !== conversationId || result.requestId !== undefined && result.requestId !== status.requestId) throw new Error("Cancellation result does not identify the admitted input");
	const state = await harness.abortSubmission(result.submissionId as SubmissionId, context, conversationId);
	return { result, state, effects: state === "aborted" ? "not-started" : "partial-effects-possible" };
}

/** The observer and the abort mark share the native mutation line; no admission gate or scheduler is added. */
class GroupGuard {
	readonly controller = new AbortController();
	readonly context: Context;
	readonly allowed?: ReadonlySet<number>;
	taskId?: TaskId;
	marked = false;
	unrelated = false;
	inputObserved = false;
	inputs: ResultReference[] = [];
	omitted = 0;
	readonly target: Target;
	constructor(target: Target, references?: readonly ResultReference[]) {
		this.target = target;
		this.context = withAbortSignal(AbortSignal.any([this.controller.signal, ...(target.context.abortSignal ? [target.context.abortSignal] : [])]), target.context);
		if (references) this.allowed = new Set(references.filter(row => row.sessionId === target.identity).map(row => row.submissionId));
	}
	observe(publication: CommitPublication): void {
		for (const change of publication.changes) {
			if (change.type === "task" && change.value.id === this.taskId && change.value.abortRequested) this.marked = true;
			if (this.marked || change.type !== "document" || change.record.kind !== native.LiveDoc.definition.kind || change.conversationId !== this.target.conversationId || !change.value) continue;
			this.observeLive(change.value as unknown as native.LiveState);
		}
	}
	private observeLive(live: native.LiveState): void {
		if (live.run?.inputs.includes(this.target.runId)) {
			this.inputObserved = true;
			this.inputs = live.run.inputs.slice(0, MAX_INPUTS).map(submissionId => ({ sessionId: this.target.identity, submissionId }));
			this.omitted = Math.max(0, live.run.inputs.length - MAX_INPUTS);
			if (!this.matches(live.run.inputs)) { this.unrelated = true; this.controller.abort(new Error("Unrelated input joined the delegated native group")); }
		}
		if (this.taskId !== undefined && live.run?.taskId !== this.taskId) this.controller.abort(new Error("The native generation changed"));
	}
	private matches(ids: readonly number[]): boolean { return this.allowed === undefined || ids.every(id => this.allowed?.has(id)); }
	protects(scope: RunScope): boolean { return this.allowed !== undefined && (!scope.coverage.complete || !this.matches(scope.inputs.map(row => row.submissionId))); }
	select(scope: RunScope, count: number): void {
		this.taskId = scope.taskId as TaskId;
		if (!this.inputObserved) { this.inputs = scope.inputs; this.omitted = Math.max(0, count - MAX_INPUTS); }
	}
}
type Attempt = { kind: "retry" | "protected" | "settled" | "stopped" | "exhausted"; scope: RunScope; inputs: ResultReference[]; omitted: number };
function attemptResult(kind: Attempt["kind"], scope: RunScope, guard: GroupGuard): Attempt { return { kind, scope, inputs: guard.inputs, omitted: guard.omitted }; }
async function markGeneration(target: Target, guard: GroupGuard): Promise<Attempt["kind"]> {
	const taskId = guard.taskId;
	if (taskId === undefined) return "settled";
	try { await target.harness.abortTask(taskId, guard.context); }
	catch (error) {
		if (!guard.controller.signal.aborted || guard.marked) throw error;
		return guard.unrelated ? "protected" : "retry";
	}
	const task = await target.harness.getTask(taskId, target.context);
	if (!guard.marked && !task?.abortRequested) return "retry";
	await target.harness.waitForTask(taskId, target.context);
	return "stopped";
}
async function stopGeneration(target: Target, options: StopOptions): Promise<Attempt> {
	const guard = new GroupGuard(target, options.inputs);
	const unsubscribe = target.harness.subscribeCommits(publication => guard.observe(publication));
	try {
		const count = { total: 0 };
		const scope = await target.harness.commit(tx => scopeInCommit(tx, target.storageId, target.conversationId, target.runId, count), target.context);
		if (guard.protects(scope)) return attemptResult("protected", scope, guard);
		if (scope.taskId === null) return attemptResult("settled", scope, guard);
		guard.select(scope, count.total);
		if (guard.controller.signal.aborted) return attemptResult(guard.unrelated ? "protected" : "retry", scope, guard);
		return attemptResult(await markGeneration(target, guard), scope, guard);
	} finally { unsubscribe(); }
}
async function stopSelectedGroup(target: Target, options: StopOptions): Promise<Attempt> {
	let result: Attempt | undefined;
	for (let index = 0; index < 16; index++) {
		result = await stopGeneration(target, options);
		if (result.kind !== "retry") return result;
	}
	if (!result) throw new Error("Native group observation is unavailable");
	return { ...result, kind: "exhausted" };
}
function stoppedResult(target: Target, scope: RunScope, state: RunStop["state"], delegations: StoppedDelegation[] = []): RunStop {
	return { sessionId: target.identity, runId: target.runId, state, inputs: scope.inputs, delegations, coverage: scope.coverage, effects: "partial-effects-possible" };
}
async function stopLocalDelegation(target: Target, sessionId: string, references: readonly ResultReference[], options: StopOptions): Promise<StoppedDelegation[]> {
	if (!references.length) return [{ sessionId, state: "protected", reason: "The delegated group has no confirmed exact input" }];
	const childId = (sessionId === target.storageId ? native.ROOT_CONVERSATION_ID : Number(sessionId.slice(target.storageId.length + 1))) as ConversationId;
	const withdrawn = await withdrawReferences(references, reference => cancelRequest(target.harness, target.storageId, reference, childId, target.context));
	const rows = await stopOwnedGroups(withdrawn.remaining, target.context, reference => stopRun(target.harness, target.storageId, childId, reference.submissionId as SubmissionId, target.context, { ...options, inputs: references }));
	return [delegationSummary(sessionId, rows, withdrawn.cancelled), ...rows.flatMap(row => row.delegations)];
}
async function stopDelegatedTarget(target: Target, sessionId: string, items: readonly Delegation[], options: StopOptions): Promise<StoppedDelegation[]> {
	const references = items.flatMap(item => item.result ? [item.result] : []);
	try {
		if (sessionId.startsWith(`${target.storageId}:`) || sessionId === target.storageId) return await stopLocalDelegation(target, sessionId, references, options);
		if (options.foreign && references.length) return [await options.foreign(references, target.context)];
		return [{ sessionId, state: "protected", reason: "The delegated group has no confirmed exact cancellation route" }];
	} catch {
		target.context.abortSignal?.throwIfAborted();
		return [{ sessionId, state: "unavailable", reason: "The delegated native group did not confirm cancellation" }];
	}
}
async function stopDelegations(target: Target, scope: RunScope, options: StopOptions): Promise<StoppedDelegation[]> {
	for (const item of scope.delegations) if (item.reporterTaskId !== undefined) await target.harness.abortTask(item.reporterTaskId as TaskId, target.context);
	const grouped = new Map<string, Delegation[]>();
	for (const item of scope.delegations) grouped.set(item.sessionId, [...grouped.get(item.sessionId) ?? [], item]);
	const stopped: StoppedDelegation[] = [];
	for (const [sessionId, items] of grouped) {
		for (const row of await stopDelegatedTarget(target, sessionId, items, options)) {
			if (stopped.length < MAX_DELEGATIONS) stopped.push(row); else scope.coverage.omitted++;
		}
	}
	scope.coverage.complete = scope.coverage.omitted === 0;
	return stopped;
}
async function validateSelectedInput(target: Target): Promise<void> {
	const selected = await (await target.harness.submission(target.runId, target.context))?.status(target.context);
	if (selected?.type !== "input" || selected.conversationId !== target.conversationId || selected.status === "queued") throw new Error("The selector does not identify an admitted native input group");
}
function completionState(attempt: Attempt, scope: RunScope, rows: readonly StoppedDelegation[]): RunStop["state"] {
	if (!scope.coverage.complete || rows.some(row => row.state === "protected" || row.state === "unavailable")) return "partial";
	if (attempt.kind === "stopped" || rows.some(row => row.state === "stopped" || row.state === "cancelled")) return "stopped";
	return "settled";
}

/** Stop one native admitted-input group across generation handovers, with no conversation-wide fallback. */
export async function stopRun(harness: Harness, storageId: string, conversationId: ConversationId, runId: SubmissionId, context: Context, options: StopOptions = {}): Promise<RunStop> {
	const target: Target = { harness, storageId, conversationId, runId, context, identity: canonicalIdentity(storageId, conversationId) };
	await validateSelectedInput(target);
	const visited = options.visited ?? new Set<string>();
	const key = `${target.identity}/${runId}`;
	if (visited.has(key) || visited.size >= MAX_DELEGATIONS) return stoppedResult(target, { sessionId: target.identity, runId, taskId: null, inputs: [], delegations: [], coverage: { complete: false, omitted: 1 } }, "partial");
	visited.add(key);
	const attempt = await stopSelectedGroup(target, options);
	if (attempt.kind === "protected") return stoppedResult(target, attempt.scope, "protected");
	const scope = await harness.commit(tx => scopeInCommit(tx, storageId, conversationId, runId), context);
	scope.coverage.omitted += attempt.omitted + (attempt.kind === "exhausted" ? 1 : 0);
	if (attempt.inputs.length) scope.inputs = attempt.inputs;
	const rows = await stopDelegations(target, scope, { ...options, visited });
	return stoppedResult(target, scope, completionState(attempt, scope, rows), rows);
}
