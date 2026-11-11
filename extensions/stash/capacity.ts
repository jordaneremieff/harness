import type {
	BoundaryResult,
	ContextUsage,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import type { StashSettings } from "./settings.ts";

export const CAPACITY_STATE = "stash-capacity-state";
export const CAPACITY_REQUEST = "stash-capacity-request";
const MAX_ANCESTORS = 4096;

export interface CapacityConfig {
	enabled: boolean;
	checkpointPercent: number;
	decisionPercent: number;
	stopPercent: number;
	intakeTokenBudget?: number;
}

export type Measure = { kind: "unknown" } | { kind: "known"; tokens: number; contextWindow: number; percent: number };
export type Band = "normal" | "decision" | "stop";
export type GateDecision = { kind: "allow" } | { kind: "block"; reason: string; terminate: boolean };
export type ContinuityTool = { name: string; act: "compaction" | "worker-resolution"; accepts?: (input: unknown) => boolean };
export type Declared = ReadonlyMap<string, Omit<ContinuityTool, "name">>;
export const STOP_ROUNDS_BEFORE_TERMINATE = 2;
export const CONTINUITY_TOOLS = "harness:continuity-tools";

/** Collect only declarations made synchronously during this evaluation. */
export function continuityTools(bus: { emit(channel: string, data: unknown): void }): Declared {
	const declarations = new Map<string, Omit<ContinuityTool, "name">>();
	let open = true;
	try {
		bus.emit(CONTINUITY_TOOLS, {
			version: 1,
			declare(tool: ContinuityTool) {
				if (!open || !tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name)) return;
				if (tool.act !== "compaction" && tool.act !== "worker-resolution") return;
				if (tool.accepts !== undefined && typeof tool.accepts !== "function") return;
				declarations.set(tool.name, { act: tool.act, accepts: tool.accepts });
			},
		});
	} finally { open = false; }
	return declarations;
}

export function measureUsage(read: () => ContextUsage | undefined): Measure {
	const usage = usageSnapshot(read);
	return usage.kind === "unknown" ? usage : { ...usage, kind: "known" };
}

export function band(measure: Measure, config: CapacityConfig): Band {
	if (measure.kind === "unknown") return "normal";
	return measure.percent >= config.stopPercent ? "stop" : measure.percent >= config.decisionPercent ? "decision" : "normal";
}

export function isContinuityCall(name: string, args: unknown, declared: Declared): boolean {
	if (name === "stash_write") return true;
	const tool = declared.get(name);
	if (!tool) return false;
	if (tool.accepts === undefined) return tool.act === "compaction";
	try { return tool.accepts(args) === true; } catch { return false; }
}

export function gate(input: {
	measure: Measure; toolName: string; args: unknown; config: CapacityConfig; declared: Declared;
	released: boolean; decisionRoundOpen: boolean; blockedRounds: number;
}): GateDecision {
	const { measure, config, declared } = input;
	const current = band(measure, config);
	if (!config.enabled || input.released || current === "normal" || isContinuityCall(input.toolName, input.args, declared)) return { kind: "allow" };
	if (current === "decision" && !input.decisionRoundOpen) return { kind: "allow" };
	if (measure.kind === "unknown") return { kind: "allow" };
	const tools = (act: ContinuityTool["act"]) => [...declared].filter(([, value]) => value.act === act).map(([name]) => name).join(", ") || "none declared";
	const observed = `${measure.percent.toFixed(1)}% (${Math.round(measure.tokens)} of ${measure.contextWindow} tokens)`;
	if (current === "decision") return { kind: "block", terminate: false, reason: `Stash decision round: context use is at ${observed}, at or above the ${config.decisionPercent}% decision threshold. This call was not run. In this response choose one continuity act: compaction for the same effort (a declared continuity tool such as ${tools("compaction")}), a handover with stash_write, or the final answer. Your next tool calls run normally until ${config.stopPercent}%.` };
	return { kind: "block", terminate: input.blockedRounds >= STOP_ROUNDS_BEFORE_TERMINATE, reason: `Stash stop: context use is at ${observed}, at or above the ${config.stopPercent}% stop threshold. This call was not run. Stop substantive work: compact with a declared continuity tool (${tools("compaction")}), write a handover with stash_write, or give the final answer. Settle live workers you own with a declared worker-resolution tool (${tools("worker-resolution")}), and name any that keep running in the handover or answer. The operator can lift this with /stash capacity release, compact with /compact, or start a fresh session.` };
}

export type GateState = {
	episode: string | null; decisionRoundUsed: boolean; released: boolean; blockedRounds: number;
	blockedCalls: Set<string>; measure?: Measure; decisionRoundOpen?: boolean; failureReported?: boolean;
};
export function gateState(states: Map<string, GateState>, key: string, episode: string | null): GateState {
	let state = states.get(key);
	if (!state || state.episode !== episode) {
		state = { episode, decisionRoundUsed: false, released: false, blockedRounds: 0, blockedCalls: new Set() };
		states.set(key, state);
	}
	return state;
}

export function capacityEpisode(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	let id = ctx.sessionManager.getLeafId();
	for (let visited = 0; id !== null && visited < MAX_ANCESTORS; visited++) {
		const entry = ctx.sessionManager.getEntry(id);
		if (!entry) return null;
		if (entry.type === "compaction") return entry.id;
		id = entry.parentId;
	}
	return null;
}

type PiCompaction = { enabled?: boolean; reserveTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number }> };
type CapacityModel = { provider: string; id: string; contextWindow: number };
export function piAutoThreshold(compaction: PiCompaction | undefined, model: CapacityModel | undefined): number | undefined {
	if (compaction?.enabled === false || !model || !(model.contextWindow > 0)) return;
	const reserve = compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens ?? compaction?.reserveTokens ?? 16384;
	return (model.contextWindow - reserve) / model.contextWindow * 100;
}
export function effectiveCheckpointPercent(config: CapacityConfig, piThreshold: number | undefined): number {
	return piThreshold !== undefined && piThreshold > 5 ? Math.min(config.checkpointPercent, piThreshold - 5) : config.checkpointPercent;
}

export function gateStatus(state: GateState, config: CapacityConfig, declared: Declared, piThreshold?: number): string {
	return [
		`Band: ${band(state.measure ?? { kind: "unknown" }, config)}; stop threshold: ${config.stopPercent}%; episode: ${state.episode ?? "initial"}.`,
		`Decision round used: ${state.decisionRoundUsed}; released: ${state.released}; refused rounds: ${state.blockedRounds}.`,
		`Declared continuity tools: ${[...declared.keys()].join(", ") || "none declared"}.`,
		`Pi automatic compaction: ${piThreshold === undefined ? "disabled or unknown" : `enabled at ${piThreshold.toFixed(1)}%`}.`,
	].join("\n");
}

type Usage = { kind: "unknown" } | { kind: "host_estimate"; tokens: number; contextWindow: number; percent: number };

export interface CapacityState {
	sessionId: string;
	turnEntryId: string | null;
	checkpointRequested: boolean;
	decisionRequested: boolean;
	intakeChars: number;
	usage: Usage;
}

type CapacityContext = Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "signal">;

export function invalidCapacityFields(values: StashSettings): (keyof StashSettings & string)[] {
	if (!values.capacity) return [];
	const fields = new Set<keyof StashSettings & string>();
	if (values.checkpointPercent >= values.decisionPercent) {
		fields.add("checkpointPercent");
		fields.add("decisionPercent");
	}
	if (values.decisionPercent >= values.stopPercent) {
		fields.add("decisionPercent");
		fields.add("stopPercent");
	}
	return [...fields];
}

export function capacityConfig(values: StashSettings): CapacityConfig {
	const { capacity: enabled, checkpointPercent, decisionPercent, stopPercent, intakeTokenBudget } = values;
	if (invalidCapacityFields(values).length) {
		throw new Error(
			"Stash settings require stash.checkpointPercent < stash.decisionPercent < stash.stopPercent. Capacity controls are unavailable until the thresholds are corrected.",
		);
	}
	return { enabled, checkpointPercent, decisionPercent, stopPercent, intakeTokenBudget };
}

function freshState(sessionId: string): CapacityState {
	return {
		sessionId,
		turnEntryId: null,
		checkpointRequested: false,
		decisionRequested: false,
		intakeChars: 0,
		usage: { kind: "unknown" },
	};
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object" || !("kind" in value)) return false;
	if (value.kind === "unknown") return true;
	return (
		value.kind === "host_estimate" &&
		"tokens" in value &&
		finiteNonnegative(value.tokens) &&
		"contextWindow" in value &&
		finiteNonnegative(value.contextWindow) &&
		value.contextWindow > 0 &&
		"percent" in value &&
		finiteNonnegative(value.percent)
	);
}

function stateFrom(data: unknown, sessionId: string): CapacityState {
	if (!data || typeof data !== "object" || !("sessionId" in data) || typeof data.sessionId !== "string") {
		throw new Error("Stash capacity state is malformed. Use /stash capacity reset to start a new episode.");
	}
	// Forks carry parent custom entries; a different session never inherits its latches.
	if (data.sessionId !== sessionId) return freshState(sessionId);
	if (
		!("turnEntryId" in data) ||
		(data.turnEntryId !== null && typeof data.turnEntryId !== "string") ||
		!("checkpointRequested" in data) ||
		typeof data.checkpointRequested !== "boolean" ||
		!("decisionRequested" in data) ||
		typeof data.decisionRequested !== "boolean" ||
		(data.decisionRequested && !data.checkpointRequested) ||
		!("intakeChars" in data) ||
		!Number.isSafeInteger(data.intakeChars) ||
		!finiteNonnegative(data.intakeChars) ||
		!("usage" in data) ||
		!isUsage(data.usage)
	) {
		throw new Error("Stash capacity state is malformed. Use /stash capacity reset to start a new episode.");
	}
	return {
		sessionId,
		turnEntryId: data.turnEntryId,
		checkpointRequested: data.checkpointRequested,
		decisionRequested: data.decisionRequested,
		intakeChars: data.intakeChars,
		usage: data.usage,
	};
}

function textSize(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let size = 0;
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") size += part.text.length;
	}
	return size;
}

function intakeSize(entry: SessionEntry | SessionBoundaryDraft): number {
	if (entry.type === "custom_message" && entry.customType !== CAPACITY_REQUEST) return textSize(entry.content);
	if (entry.type !== "message") return 0;
	if (entry.message.role === "user" || entry.message.role === "toolResult") return textSize(entry.message.content);
	return 0;
}

function retainedState(entry: SessionEntry | SessionBoundaryDraft, sessionId: string): CapacityState | undefined {
	if (entry.type === "custom" && entry.customType === CAPACITY_STATE) return stateFrom(entry.data, sessionId);
	if (entry.type === "custom_message" && entry.customType === CAPACITY_REQUEST)
		return stateFrom(entry.details, sessionId);
	return;
}

/** Restore active-branch state without a whole-session scan or a parallel transcript. */
export function readCapacityState(ctx: Pick<ExtensionContext, "sessionManager">): CapacityState {
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	if (!sessionId) throw new Error("Stash capacity requires a session identity.");
	let id = manager.getLeafId();
	let intakeChars = 0;
	for (let visited = 0; id !== null && visited < MAX_ANCESTORS; visited++) {
		const entry = manager.getEntry(id);
		if (!entry) throw new Error("Stash capacity ancestry is unavailable. Use /stash capacity reset after inspection.");
		const state = retainedState(entry, sessionId);
		if (state) {
			return { ...state, intakeChars: Math.min(Number.MAX_SAFE_INTEGER, state.intakeChars + intakeChars) };
		}
		if (entry.type === "compaction") return { ...freshState(sessionId), intakeChars };
		intakeChars = Math.min(Number.MAX_SAFE_INTEGER, intakeChars + intakeSize(entry));
		id = entry.parentId;
	}
	if (id !== null)
		throw new Error("Stash capacity ancestry exceeds its scan limit. Use /stash capacity reset after inspection.");
	return { ...freshState(sessionId), intakeChars };
}

function usageSnapshot(read: () => ContextUsage | undefined): Usage {
	try {
		const usage = read();
		if (
			usage &&
			finiteNonnegative(usage.tokens) &&
			finiteNonnegative(usage.percent) &&
			finiteNonnegative(usage.contextWindow) &&
			usage.contextWindow > 0
		)
			return {
				kind: "host_estimate",
				tokens: usage.tokens,
				contextWindow: usage.contextWindow,
				percent: usage.percent,
			};
	} catch {
		// An unavailable host estimate never becomes a zero or a stale percentage.
	}
	return { kind: "unknown" };
}

function requestText(state: CapacityState, checkpoint: boolean, decision: boolean, config: CapacityConfig, piThreshold?: number): string {
	const observation =
		state.usage.kind === "host_estimate"
			? `Pi estimates context use at ${state.usage.percent.toFixed(1)}% (${Math.round(state.usage.tokens)} tokens). This is not a safe remaining budget.`
			: `Current context use is unknown. Estimated text intake reached the configured ${config.intakeTokenBudget}-token budget (text characters / 4, not a context percentage).`;
	const lead = piThreshold !== undefined && effectiveCheckpointPercent(config, piThreshold) < config.checkpointPercent
		? `Pi automatic compaction starts at ${piThreshold.toFixed(1)}%; the effective checkpoint threshold is ${effectiveCheckpointPercent(config, piThreshold).toFixed(1)}%.` : undefined;
	return [CAPACITY_NOTICE_HEADER, observation, lead, ...capacityDirectiveLines(checkpoint, decision, config.stopPercent)].filter(Boolean).join("\n\n");
}

export const CAPACITY_NOTICE_HEADER = "Stash capacity notice from the local extension, not a new operator request.";

/** Directive sentences after the observation; shared with the Durable capacity hook. */
export function capacityDirectiveLines(checkpoint: boolean, decision: boolean, stopPercent = 95): string[] {
	const instructions = [
		"Follow the governing capacity instructions and preserve the operator's scope and authority.",
	];
	if (checkpoint) {
		instructions.push(
			"If substantial work remains, call stash_write with checkpoint: true to preserve a concise working synthesis: decisions, checked sources and their limits, open questions, authority limits, and exact next actions. Do not copy the transcript. If no work remains, finish the answer instead. When you later compact, put this checkpoint's identifier in the compaction summary.",
		);
	}
	if (decision) {
		instructions.push(
			`Before further broad intake, choose and execute the authorized continuity path: checked compaction for the same effort, or stash_write without checkpoint for a fresh-session handover. If the governing stop threshold is reached, stop substantive work and deliver the result or handover now. Resolve live worker ownership before exit; a saved artifact does not transfer workers. This notice grants no authority; the governing instructions decide which continuity act you may take. At ${stopPercent}% tools stop except stash_write and declared continuity tools.`,

		);
	}
	instructions.push(
		"The notice records a request, not successful preservation. Report a failed or unavailable save. Do not reset the capacity episode merely to repeat this notice.",
	);
	return instructions;
}

function requestLevels(state: CapacityState, config: CapacityConfig, actionable: boolean) {
	if (!actionable) return { checkpoint: false, decision: false };
	const overBudget =
		state.usage.kind === "unknown" &&
		config.intakeTokenBudget !== undefined &&
		Math.ceil(state.intakeChars / 4) >= config.intakeTokenBudget;
	const percent = state.usage.kind === "host_estimate" ? state.usage.percent : 0;
	return {
		checkpoint: !state.checkpointRequested && (overBudget || percent >= config.checkpointPercent),
		decision: !state.decisionRequested && (overBudget || percent >= config.decisionPercent),
	};
}

export function capacityTurnEnd(
	event: TurnEndEvent,
	ctx: CapacityContext,
	config: CapacityConfig,
	piThreshold?: number,
): BoundaryResult | undefined {
	if (!config.enabled) return;
	const usage = usageSnapshot(() => ctx.getContextUsage());
	let state = readCapacityState(ctx);
	for (const entry of event.entries) {
		if (entry.type === "compaction") state = freshState(state.sessionId);
		const retained = retainedState(entry, state.sessionId);
		if (retained) state = retained;
		else state.intakeChars = Math.min(Number.MAX_SAFE_INTEGER, state.intakeChars + intakeSize(entry));
	}
	if (state.turnEntryId === event.messageEntryId) return;
	// A draft compaction invalidates the pre-commit host estimate in this boundary.
	if (event.entries.some((entry) => entry.type === "compaction")) state.usage = { kind: "unknown" };
	else state.usage = usage;
	state.turnEntryId = event.messageEntryId;
	const actionable = event.outcome === "completed" && !ctx.signal?.aborted;
	const { checkpoint, decision } = requestLevels(state, { ...config, checkpointPercent: effectiveCheckpointPercent(config, piThreshold) }, actionable);
	state.checkpointRequested ||= checkpoint;
	state.decisionRequested ||= decision;
	const entries: SessionBoundaryDraft[] = [...event.entries];
	if (checkpoint || decision) {
		// Persist the request before its latch. Pi validates the batch but appends nontransactionally.
		entries.push({
			type: "custom_message",
			customType: CAPACITY_REQUEST,
			content: requestText(state, checkpoint, decision, config, piThreshold),
			display: true,
			details: state,
		});
	}
	entries.push({ type: "custom", customType: CAPACITY_STATE, data: state });
	return checkpoint || decision ? { entries, continue: true } : { entries };
}

export function capacityReset(ctx: Pick<ExtensionContext, "sessionManager">): CapacityState {
	const id = ctx.sessionManager.getSessionId();
	if (!id) throw new Error("Stash capacity requires a session identity.");
	return freshState(id);
}

export function capacityStatus(ctx: Pick<ExtensionContext, "sessionManager">, config: CapacityConfig): string {
	const state = readCapacityState(ctx);
	return [
		`Stash capacity: ${config.enabled ? "enabled" : "disabled"}.`,
		`Thresholds: checkpoint ${config.checkpointPercent}%; continuity decision ${config.decisionPercent}%; stop ${config.stopPercent}%.`,
		state.usage.kind === "unknown"
			? "Last boundary context use: unknown."
			: `Last boundary host estimate: ${state.usage.percent.toFixed(1)}%. This is not a live reading.`,
		`Requests in this episode: checkpoint ${state.checkpointRequested}; decision ${state.decisionRequested}.`,
		`Estimated text intake: ${Math.ceil(state.intakeChars / 4)} tokens; configured budget: ${config.intakeTokenBudget ?? "none"}.`,
		"Requests do not prove a checkpoint was saved. /stash capacity reset explicitly starts a new episode.",
	].join("\n");
}
