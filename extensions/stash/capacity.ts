import type {
	BoundaryResult,
	ContextUsage,
	ExtensionContext,
	SessionBoundaryDraft,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

export const CAPACITY_STATE = "stash-capacity-state";
export const CAPACITY_REQUEST = "stash-capacity-request";
const MAX_ANCESTORS = 4096;

export interface CapacityConfig {
	enabled: boolean;
	checkpointPercent: number;
	decisionPercent: number;
	intakeTokenBudget?: number;
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

function configuredNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
	const raw = env[key]?.trim();
	if (!raw) return;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number.`);
	return value;
}

export function capacityConfig(env: NodeJS.ProcessEnv): CapacityConfig {
	const enabled = env.PI_STASH_CAPACITY?.trim() || "1";
	if (enabled !== "0" && enabled !== "1") throw new Error("PI_STASH_CAPACITY must be 0 or 1.");
	if (enabled === "0") return { enabled: false, checkpointPercent: 60, decisionPercent: 70 };
	const checkpointPercent = configuredNumber(env, "PI_STASH_CHECKPOINT_PERCENT") ?? 60;
	const decisionPercent = configuredNumber(env, "PI_STASH_DECISION_PERCENT") ?? 70;
	if (checkpointPercent >= decisionPercent || decisionPercent > 100) {
		throw new Error("Stash capacity thresholds must satisfy 0 < checkpoint < decision <= 100.");
	}
	const intakeTokenBudget = configuredNumber(env, "PI_STASH_INTAKE_TOKEN_BUDGET");
	if (intakeTokenBudget !== undefined && !Number.isSafeInteger(intakeTokenBudget)) {
		throw new Error("PI_STASH_INTAKE_TOKEN_BUDGET must be a positive safe integer.");
	}
	return { enabled: true, checkpointPercent, decisionPercent, intakeTokenBudget };
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

function requestText(state: CapacityState, checkpoint: boolean, decision: boolean, config: CapacityConfig): string {
	const observation =
		state.usage.kind === "host_estimate"
			? `Pi estimates context use at ${state.usage.percent.toFixed(1)}% (${Math.round(state.usage.tokens)} tokens). This is not a safe remaining budget.`
			: `Current context use is unknown. Estimated text intake reached the configured ${config.intakeTokenBudget}-token budget (text characters / 4, not a context percentage).`;
	const instructions = [
		"Stash capacity notice from the local extension, not a new operator request.",
		observation,
		"Follow the governing capacity instructions and preserve the operator's scope and authority.",
	];
	if (checkpoint) {
		instructions.push(
			"If substantial work remains, call stash_write with checkpoint: true to preserve a concise working synthesis: decisions, checked sources and their limits, open questions, authority limits, and exact next actions. Do not copy the transcript. If no work remains, finish the answer instead.",
		);
	}
	if (decision) {
		instructions.push(
			"Before further broad intake, choose and execute the authorized continuity path: checked compaction for the same effort, or stash_write without checkpoint for a fresh-session handover. If the governing stop threshold is reached, stop substantive work and deliver the result or handover now. Resolve live worker ownership before exit; a saved artifact does not transfer workers. This notice does not authorize compaction, session replacement, or worker cancellation.",
		);
	}
	instructions.push(
		"The notice records a request, not successful preservation. Report a failed or unavailable save. Do not reset the capacity episode merely to repeat this notice.",
	);
	return instructions.join("\n\n");
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
	const { checkpoint, decision } = requestLevels(state, config, actionable);
	state.checkpointRequested ||= checkpoint;
	state.decisionRequested ||= decision;
	const entries: SessionBoundaryDraft[] = [...event.entries];
	if (checkpoint || decision) {
		// Persist the request before its latch. Pi validates the batch but appends nontransactionally.
		entries.push({
			type: "custom_message",
			customType: CAPACITY_REQUEST,
			content: requestText(state, checkpoint, decision, config),
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
		`Thresholds: checkpoint ${config.checkpointPercent}%; continuity decision ${config.decisionPercent}%.`,
		state.usage.kind === "unknown"
			? "Last boundary context use: unknown."
			: `Last boundary host estimate: ${state.usage.percent.toFixed(1)}%. This is not a live reading.`,
		`Requests in this episode: checkpoint ${state.checkpointRequested}; decision ${state.decisionRequested}.`,
		`Estimated text intake: ${Math.ceil(state.intakeChars / 4)} tokens; configured budget: ${config.intakeTokenBudget ?? "none"}.`,
		"Requests do not prove a checkpoint was saved. /stash capacity reset explicitly starts a new episode.",
	].join("\n");
}
