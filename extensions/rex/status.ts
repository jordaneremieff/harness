import type { RexCallContext, RexRequest, RexResult, ResolvedTarget, TargetIntent } from "./core.ts";
import { boundedText, fullId, sameServer } from "./ownership.ts";
import type { StatusRequest } from "./schema.ts";

export interface RexExecutor {
	execute(request: RexRequest, context: RexCallContext): Promise<RexResult>;
	dispose(): void;
}
export interface StatusBinding {
	ownerId: string;
	target: ResolvedTarget;
	verifiedAt: string;
}
export interface StatusStore {
	read(): Promise<StatusBinding | undefined>;
	write(binding: StatusBinding | undefined): Promise<void>;
}
export interface HostActivity {
	host: "ordinary" | "durable";
	state: "idle" | "active" | "blocked";
	observedAt: string;
	source: string;
	tasks?: Array<{ id: string; kind: string; state: string; background: boolean; abortRequested: boolean; reason?: string }>;
	omittedTasks?: number;
	note: string;
}
export const NATIVE_PROJECTION_LIMIT = "The installed Rex API exposes program_status readback but no terminal-output or status setter. Terminal write sends application input. A detached native host has no verified attached PTY output route; it does not emit or clear terminal status records.";
export function validateStatusBinding(value: unknown, ownerId: string): StatusBinding | undefined {
	if (value === undefined || value === null) return undefined;
	const binding = value as StatusBinding;
	if (binding.ownerId !== ownerId || !boundedText(binding.verifiedAt, 64) || !binding.target || !fullId(binding.target.sessionId, "session") || !fullId(binding.target.blockId, "block") || !binding.target.server || !boundedText(binding.target.server.endpoint, 4096) || !boundedText(binding.target.server.hostId, 128) || !boundedText(binding.target.server.instanceId, 128) || !boundedText(binding.target.server.selection, 4096)) throw new Error("The Rex status binding is invalid or belongs to another caller.");
	return structuredClone(binding);
}
const noEffects = { state: "none" as const };
const coverage = { bounded: true as const, note: "Program reports and independent host snapshots are data, not permission, ownership or task acceptance." };

function statusCoverage(source: RexResult["coverage"]): RexResult["coverage"] {
	return { ...source, note: [source.note, coverage.note].filter(Boolean).join(" ") };
}
function failure(error: string, outcome = "invalid_status_request"): RexResult {
	return { ok: false, outcome, error, effects: noEffects, coverage };
}
function targetIntent(target: ResolvedTarget): TargetIntent {
	return { server: target.server.endpoint, session: target.sessionId, block: target.blockId, window: target.windowId, source: "explicit" };
}
function explicitBinding(target: TargetIntent | undefined): target is TargetIntent {
	return target !== undefined && typeof target.server === "string" && target.server.length > 0 && fullId(target.session, "session") && fullId(target.block, "block") && (target.window === undefined || fullId(target.window, "window")) && target.source !== "inherited" && target.source !== "focus";
}

async function unbindStatus(request: StatusRequest, store: StatusStore): Promise<RexResult> {
	if (request.target) return failure("Unbind acts on this caller's binding and accepts no target.");
	await store.write(undefined);
	return { ok: true, outcome: "status_unbound", effects: noEffects, coverage, data: { terminalRecordsCleared: false, meaning: "Only this caller's inspection binding was removed. No emitter or terminal work stopped." } };
}

async function bindStatus(request: StatusRequest, context: RexCallContext, core: RexExecutor, store: StatusStore): Promise<RexResult> {
	if (!explicitBinding(request.target)) return failure("A status binding requires explicit server, full session ID and full block ID. Inherited IDs and focus do not establish attachment.");
	const resolved = await core.execute({ op: "resolve", kind: "block", target: { ...request.target, source: "explicit" } }, context);
	if (!resolved.ok || !resolved.target?.blockId || !resolved.target.sessionId) return resolved;
	const verification = await core.execute({ op: "inspect", view: "status", target: targetIntent(resolved.target) }, context);
	if (!verification.ok || !verification.target) return verification;
	if (!sameServer(resolved.target.server, verification.target.server)) return failure("The Rex server instance changed during verification. Reconcile before binding.", "stale_status_binding");
	const binding = { ownerId: context.ownerId, target: verification.target, verifiedAt: new Date().toISOString() };
	context.budget?.check("effect");
	if (context.signal?.aborted) return failure("The status call was cancelled before binding.", "cancelled");
	await store.write(binding);
	return { ok: true, outcome: "status_bound", target: binding.target, effects: noEffects, coverage: statusCoverage(verification.coverage), data: { binding, reportedStatus: verification.data, meaning: "The binding selects status inspection only. It grants neither resource ownership nor a terminal output route." } };
}

async function statusSnapshot(request: StatusRequest, context: RexCallContext, core: RexExecutor, store: StatusStore, activity: () => Promise<HostActivity>): Promise<RexResult> {
	const binding = request.target ? undefined : await store.read();
	if (binding && binding.ownerId !== context.ownerId) return failure("This status binding belongs to another caller.");
	context.budget?.check("observe");
	const hostActivity = await activity();
	context.budget?.check("observe");
	const target = request.target ?? (binding ? targetIntent(binding.target) : undefined);
	if (!target) return { ok: true, outcome: "host_status", effects: noEffects, coverage, data: { hostActivity, binding: null, terminalProjection: hostActivity.host === "ordinary" ? "Pi owns ordinary TUI lifecycle output; this extension emits nothing." : NATIVE_PROJECTION_LIMIT } };
	const snapshot = await core.execute({ op: "inspect", view: "status", target }, context);
	if (binding && snapshot.target && !sameServer(binding.target.server, snapshot.target.server)) return failure("The bound Rex server instance changed. Verify an explicit new binding before reuse.", "stale_status_binding");
	return { ...snapshot, data: { reportedStatus: snapshot.data, hostActivity, binding: binding ?? null, terminalProjection: hostActivity.host === "ordinary" ? "Pi owns ordinary TUI lifecycle output; this extension emits nothing." : NATIVE_PROJECTION_LIMIT }, coverage: statusCoverage(snapshot.coverage) };
}

export async function rexStatus(
	request: StatusRequest,
	context: RexCallContext,
	core: RexExecutor,
	store: StatusStore,
	activity: () => Promise<HostActivity>,
): Promise<RexResult> {
	try {
		context.budget?.check("resolve");
		if (context.signal?.aborted) return failure("The status call was cancelled before execution.", "cancelled");
		if (request.op === "unbind") return await unbindStatus(request, store);
		if (request.op === "bind") return await bindStatus(request, context, core, store);
		return await statusSnapshot(request, context, core, store, activity);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error), context.budget?.stopReason() ?? (context.signal?.aborted ? "cancelled" : "invalid_status_request"));
	}
}
