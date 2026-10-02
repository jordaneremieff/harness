/**
 * Native Pi Durable form of the policy slice.
 *
 * Ordinary Pi drives policy evaluation from agent events (`tool_call`,
 * `tool_result`, `context`, `turn_start`). A Durable conversation has no such
 * events: each tool call is a `ToolTask` and each model request belongs to
 * `GenerationTask`. This module maps the same approved-rule interpreter onto
 * those tasks:
 *
 * - `beforeTool` is the input phase. A deny becomes `block`; an enforce-mode
 *   correction becomes replacement `arguments`.
 * - `afterTool` is the result and completion phase. Assert-error corrections
 *   and guide annotations replace the tool result; observation completion,
 *   retained guidance, and provenance are committed to `policy.state`.
 * - `beforeRequest` is the context phase. Context programs, retained guidance,
 *   and the one-time shell contract card append user messages to that request
 *   only, which is the native equivalent of the ordinary `context` event.
 * - Compaction carries no policy decision and installs no hook.
 *
 * Observation periods are conversation-scoped because Durable turns and
 * replay identity are conversation-scoped; the ordinary runtime keeps one
 * session-wide state. `policy.state` holds the serialized `ObservationState`,
 * retained guidance, the delivered shell card, the last counted turn, and a
 * bounded ring of completed calls with the result effect each decided. Every
 * update recomputes inside one in-process tail and commits the state and the
 * dedupe entry together, so a replay after process loss returns the recorded
 * decision instead of deciding again. A hook decision that survives process
 * loss by itself uses `api.memo()` on the tool task. The rule store stays
 * external and revision-checked; only decisions and evidence live in the
 * document.
 *
 * `notice` mode has no terminal surface in a Durable agent. It records the
 * same metadata as the other modes and adds no notice; guidance and
 * corrections remain annotate/enforce only. Telemetry writes are
 * at-most-once: a newly applied completion writes one record after its state
 * commit.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { authoringGuide, checkDraft, type DraftCheckContext } from "./authoring.ts";
import { captureFor, ruleScopeMatches } from "./classify.ts";
import { compileRule } from "./compiler.ts";
import {
	applyControl,
	controlResult,
	POLICY_CONTROL_DESCRIPTION,
	PolicyControlParams,
	previewControl,
	validateControl,
} from "./control.ts";
import { cloneJson, snapshotData, UNKNOWN } from "./data.ts";
import {
	makeRuleAudit,
	MAX_RULE_EVENT_BYTES,
	proposalRevision,
	RuleRegistry,
	type RuleSnapshot,
} from "./local-rules.ts";
import { type PolicyMode, resolvePolicyModeValue } from "./mode.ts";
import { readRecentActivity, terminalSafe } from "./panel.ts";
import {
	type EvaluationContext,
	evaluatePrograms,
	type InputPlan,
	observationSelected,
	planInput,
	type ProgramEvaluation,
	type ProgramRule,
	programFacts,
	programSteps,
	captureProgramEvidence,
} from "./program.ts";
import {
	boundedRows,
	guidanceText,
	markUnavailable,
	metadata,
	publicState,
	relevantEvaluations,
	samePin,
} from "./runtime.ts";
import {
	type CallEffects,
	type CallOutcome,
	type ContentLike,
	finishCall,
	MAX_PENDING,
	type PendingCall,
	type PolicyRecord,
	startCall,
	textContentBytes,
} from "./record.ts";
import {
	type AgentRuleAudit,
	contentRevision,
	effectiveState,
	type OperatorRuleAudit,
	ruleGuidance,
	type RuleMatchContext,
} from "./rule.ts";
import { shellContractCard } from "./shell-card.ts";
import { ObservationState, type StatePin, type StateView } from "./state.ts";
import { appendRecord, resolvePolicyDir } from "./store.ts";
import { formatTelemetry, readTelemetry } from "./telemetry.ts";
import {
	approvalReadback,
	boundedInspection,
	formatCatalog,
	formatDataView,
	formatRulesTool,
	type PolicyInspectionView,
	POLICY_APPROVE_DESCRIPTION,
	POLICY_PROPOSE_DESCRIPTION,
	POLICY_RULES_DESCRIPTION,
	type PolicyToolContext,
	type PolicyToolScope,
	parseAuthoringDraft,
	PolicyApproveParams,
	PolicyProposeParams,
	PolicyRulesParams,
	pendingProposalOutput,
	submitProposal,
	type ToolDeps,
	validateInspectionParams,
	validateProposal,
} from "./tools.ts";

const MAX_CATALOG_TOOLS = 1024;
const MAX_MEMO_INPUT_BYTES = 16 * 1024;
const COMPLETED_CALLS = 512;
const PROJECTION_MODES: readonly PolicyMode[] = ["annotate", "enforce"];

/** One Durable contribution emitted by the ordinary factory. */
export interface PolicyDurableContribution {
	readonly name: string;
	readonly source: string;
	readonly create: (host: PolicyDurableHost) => Durable.Extension | Promise<Durable.Extension>;
}

/** What the agent session host installs, complete before the first `create()`. */
export interface PolicyDurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	readonly ordinaryOnly: readonly string[];
}

/** The agent session host supplies these values; this slice reads only `durable` and `agentDir`. */
export interface PolicyDurableHost {
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly signal: AbortSignal;
	readonly inventory: PolicyDurableInventory;
}

/** Result effect of one completed call, recorded so a rerun replays it unchanged. */
type StoredCompletedCall = { id: string; guidance?: string; correction?: boolean };
type StoredRetainedGuidance = {
	id: string;
	revision: string;
	generation: number;
	evaluation: JsonValue;
};
type PolicyStateValue = Durable.JsonObject & {
	generation: number;
	turn: number;
	observation: JsonValue;
	retainedGuidance: JsonValue[];
	completedCalls: JsonValue[];
	shellCardDelivered: boolean;
};

/** What `beforeTool` records on the tool task for `afterTool` and for recovery. */
type PolicyCallMemo = {
	tool: string;
	callId: string;
	at: string;
	startedAt: number;
	captured?: string;
	complete: boolean;
	pins: Array<{ id: string; revision: string; generation: number }>;
	classes: string[];
	corrections: PolicyCorrection[];
	inputEvaluations: JsonValue[];
	decision?: string;
	original?: JsonValue;
};

type PolicyResult = { content?: ContentLike[]; isError?: boolean; details?: unknown; usage?: unknown };
type PolicyFacts = Record<string, unknown>;
type PolicyCorrection = { id: string; stage: "logical-target" | "keys" | "values"; path: string[] };
type PolicySessionFacts = {
	session: string;
	mode: string;
	cwd: string;
	model: string | null;
	thinkingLevel: string | null;
	projectContext: boolean;
	ruleStoreDegraded: boolean;
};

interface ObservedCall {
	tool: string;
	callId: string;
	at: string;
	startedAt: number;
	pending: PendingCall;
	sessionFacts: PolicySessionFacts;
	captured?: string;
	requested?: Record<string, unknown>;
	input?: Record<string, unknown>;
	rules: ProgramRule[];
	pins: Map<string, StatePin>;
	matches: Set<string>;
	classes: string[];
	corrections: PolicyCorrection[];
	inputEvaluations: JsonValue[];
	evaluations: ProgramEvaluation[];
	effects: CallEffects;
	context: EvaluationContext;
	generation: number;
	turn: number;
	complete: boolean;
	resultSeen: boolean;
	abortRequested?: boolean;
	preGuidanceBytes?: number;
	outputBytes?: number;
	decision?: string;
}

/** The read, agent, and commit surface shared by tool executions and task hooks. */
interface PolicySurface {
	readonly registry: Durable.RegistrySnapshot;
	readonly conversationId: Durable.ConversationId;
	agent(context: Context): Promise<Durable.Agent>;
	snapshot<T extends Durable.JsonObject>(
		token: Durable.ConversationDocToken<T>,
		conversationId: Durable.ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	commit<T>(change: (tx: Durable.Tx) => T | Promise<T>, context: Context): Promise<T>;
}

/** Adds the task facilities the harness passes to hooks beyond the declared `HookApi`. */
interface PolicyTaskSurface extends PolicySurface {
	readonly signal: AbortSignal;
	now(): number;
	context(conversationId: Durable.ConversationId, context: Context): Promise<Durable.ContextView>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}

const toolScope = (scope: RuleMatchContext, model: Durable.Agent["model"]): PolicyToolScope => ({
	cwd: scope.cwd,
	model: model ? { provider: model.provider, id: model.modelId } : null,
});

/**
 * Build the native extension for one host. Runtime values come from
 * `host.durable`; the package is imported for types only. The policy store
 * directory resolves from `PI_POLICY_DIR` or the host's agent directory, the
 * same resolution a primary session uses.
 */
export function createPolicyDurableExtension(host: PolicyDurableHost): Durable.Extension {
	const { defineDoc, defineExtension, defineTool, hook, section, GenerationTask, ToolTask } = host.durable;
	const dir = resolvePolicyDir(process.env, host.agentDir);
	const registry = new RuleRegistry(dir, {
		onNotice(message) {
			try {
				console.warn(terminalSafe(`[policy] ${message}`));
			} catch {
				/* Reporting has no policy authority. */
			}
		},
	});
	const resolved = resolveDurableMode();
	const StateDoc = defineDoc<PolicyStateValue>({
		kind: "policy.state",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: initialPolicyStateValue,
	});
	const runtime = new DurablePolicyRuntime({
		dir,
		registry,
		storageId: host.storageId,
		cwd: host.cwd,
		mode: resolved.mode,
		modeValid: resolved.valid,
		stateDoc: StateDoc,
	});

	const rulesTool = {
		...defineTool({
			name: "policy_rules",
			description: POLICY_RULES_DESCRIPTION,
			parameters: PolicyRulesParams,
			replay: "safe",
			execute: (args, api, context) => runtime.executeRules(args, api, context),
		}),
		outputSchema: Type.Object({
			structuredContent: Type.Object({
				rules: Type.Number(),
				pending: Type.Number(),
				ruleStoreDegraded: Type.Boolean(),
				ruleStorePath: Type.String(),
			}),
		}),
	};
	const proposeTool = {
		...defineTool({
			name: "policy_propose",
			description: POLICY_PROPOSE_DESCRIPTION,
			parameters: PolicyProposeParams,
			replay: "unsafe",
			execute: (args, api, context) => runtime.executePropose(args, api, context),
		}),
		outputSchema: Type.Object({
			structuredContent: Type.Object({
				proposalId: Type.String(),
				proposalRevision: Type.String(),
				state: Type.Literal("pending"),
				operation: Type.String(),
				ruleId: Type.String(),
			}),
		}),
	};
	const approveTool = {
		...defineTool({
			name: "policy_approve",
			description: POLICY_APPROVE_DESCRIPTION,
			parameters: PolicyApproveParams,
			replay: "unsafe",
			execute: (args, api, context) => runtime.executeApprove(args, api, context),
		}),
		outputSchema: Type.Object({
			structuredContent: Type.Object({
				proposalId: Type.String(),
				proposalRevision: Type.String(),
				decision: Type.Literal("approved"),
				operation: Type.String(),
				ruleId: Type.String(),
				ruleRevision: Type.String(),
				state: Type.String(),
				effect: Type.String(),
				matcherAvailable: Type.Boolean(),
				staleOverride: Type.Boolean(),
				scope: Type.String(),
				mode: Type.String(),
				registryHealth: Type.String(),
				boundary: Type.String(),
			}),
		}),
	};
	const controlTool = {
		...defineTool({
			name: "policy_control",
			description: POLICY_CONTROL_DESCRIPTION,
			parameters: PolicyControlParams,
			replay: "unsafe",
			execute: (args, api, context) => runtime.executeControl(args, api, context),
		}),
		outputSchema: Type.Object({ structuredContent: Type.Record(Type.String(), Type.Unknown()) }),
	};

	return defineExtension({
		name: "policy",
		tools: [rulesTool, proposeTool, approveTool, controlTool],
		sections: [
			section(
				"policy",
				() =>
					"Policy tools govern operator-approved rules for this conversation. Inspect with policy_rules before authoring, and use view=authoring then view=check before proposing. policy_propose records an inert proposal; it is never approval. policy_approve activates one proposal only under a clear operator decision carried in the conversation, and your own inference, a recommendation, or a quoted third party is not approval. policy_control carries contextual operator decisions to revision-checked controls; resolve the exact target and revision from inspection first, and report the returned state and mode instead of presumed enforcement. Approved input rules can deny or correct tool calls, result rules can mark or annotate results, and context rules can add guidance to a request.",
			),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: (call, api, context) => runtime.beforeTool(call, api, context),
				afterTool: (call, result, api, context) => runtime.afterTool(call, result, api, context),
			}),
			hook(GenerationTask, {
				beforeRequest: (request, api, context) => runtime.beforeRequest(request, api, context),
			}),
		],
	});
}

function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveDurableMode(): { mode: PolicyMode; valid: boolean } {
	const raw = process.env.PI_POLICY_MODE?.trim();
	if (raw === undefined || raw === "") return { mode: "observe", valid: true };
	try {
		return { mode: resolvePolicyModeValue(raw, "PI_POLICY_MODE"), valid: true };
	} catch (error) {
		try {
			console.warn(terminalSafe(`[policy] Invalid mode configuration: ${failureText(error)}`));
		} catch {
			/* Reporting has no policy authority. */
		}
		return { mode: "observe", valid: false };
	}
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Strict-JSON copy of one input object, or undefined when it is not bounded JSON. */
function inputSnapshot(value: unknown): Record<string, unknown> | undefined {
	const source = objectValue(value);
	if (!source) return undefined;
	try {
		return cloneJson({ ...source });
	} catch {
		return undefined;
	}
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function initialObservationValue(): JsonValue {
	return { nextGeneration: 0, periods: [] };
}

function initialPolicyStateValue(): PolicyStateValue {
	return {
		generation: 0,
		turn: 0,
		observation: initialObservationValue(),
		retainedGuidance: [],
		completedCalls: [],
		shellCardDelivered: false,
	};
}

function isStoredGuidance(value: JsonValue): value is StoredRetainedGuidance {
	const entry = objectValue(value);
	return (
		entry !== undefined &&
		typeof entry.id === "string" &&
		typeof entry.revision === "string" &&
		safeInteger(entry.generation) !== undefined &&
		entry.evaluation !== undefined
	);
}

function isStoredCompleted(value: JsonValue): value is StoredCompletedCall {
	const entry = objectValue(value);
	return entry !== undefined && typeof entry.id === "string";
}

function normalizePolicyState(raw: Readonly<PolicyStateValue> | undefined): PolicyStateValue {
	if (!raw) return initialPolicyStateValue();
	const value = raw as Partial<PolicyStateValue>;
	return {
		generation: safeInteger(value.generation) ?? 0,
		turn: safeInteger(value.turn) ?? 0,
		observation: value.observation ?? initialObservationValue(),
		retainedGuidance: Array.isArray(value.retainedGuidance) ? value.retainedGuidance.filter(isStoredGuidance) : [],
		completedCalls: Array.isArray(value.completedCalls)
			? value.completedCalls.filter(isStoredCompleted).slice(-COMPLETED_CALLS)
			: [],
		shellCardDelivered: value.shellCardDelivered === true,
	};
}

interface DurablePolicyRuntimeOptions {
	dir: string;
	registry: RuleRegistry;
	storageId: string;
	cwd: string;
	mode: PolicyMode;
	modeValid: boolean;
	stateDoc: Durable.ConversationDocToken<PolicyStateValue>;
}

class DurablePolicyRuntime {
	private readonly dir: string;
	private readonly registry: RuleRegistry;
	private readonly storageId: string;
	private readonly cwd: string;
	private readonly mode: PolicyMode;
	private readonly modeValid: boolean;
	private readonly stateDoc: Durable.ConversationDocToken<PolicyStateValue>;
	private readonly resetIdentity = crypto.randomUUID();
	private readonly pendingCalls = new Map<string, true>();
	private stateTail: Promise<unknown> = Promise.resolve();
	private incomplete = 0;
	private stale = 0;
	private telemetryFailure?: string;

	constructor(options: DurablePolicyRuntimeOptions) {
		this.dir = options.dir;
		this.registry = options.registry;
		this.storageId = options.storageId;
		this.cwd = options.cwd;
		this.mode = options.mode;
		this.modeValid = options.modeValid;
		this.stateDoc = options.stateDoc;
	}

	getMode(): PolicyMode | "unavailable" {
		return this.modeValid ? this.mode : "unavailable";
	}

	private async snapshot(): Promise<RuleSnapshot> {
		return this.registry.snapshot();
	}

	private sessionLabel(conversationId: Durable.ConversationId): string {
		return `${this.storageId}:${conversationId}`;
	}

	private effectiveMode(snapshot: RuleSnapshot): PolicyMode {
		return snapshot.health.status === "degraded" && this.mode !== "observe" ? "notice" : this.mode;
	}

	/** Run one read from the serialized state tail; writers never interleave with it. */
	private readState<T>(
		surface: PolicySurface,
		context: Context,
		work: (state: PolicyStateValue) => T | Promise<T>,
	): Promise<T> {
		const run = this.stateTail.then(async () => {
			const raw = await surface.snapshot(this.stateDoc, surface.conversationId, context);
			return work(normalizePolicyState(raw));
		});
		this.stateTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Run one read-modify-write in a single commit, serialized with every other state change. */
	private withState<T>(
		surface: PolicySurface,
		context: Context,
		work: (state: PolicyStateValue) => T | Promise<T>,
	): Promise<T> {
		const run = this.stateTail.then(async () => {
			let result!: T;
			await surface.commit(async (tx) => {
				const draft = await tx.doc(this.stateDoc, surface.conversationId);
				result = await work(draft as unknown as PolicyStateValue);
			}, context);
			return result;
		});
		this.stateTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private observationOf(state: PolicyStateValue): ObservationState {
		return ObservationState.fromJSON(state.observation) ?? new ObservationState();
	}

	private retainedGuidanceOf(state: PolicyStateValue): StoredRetainedGuidance[] {
		return Array.isArray(state.retainedGuidance) ? state.retainedGuidance.filter(isStoredGuidance) : [];
	}

	private completedCallsOf(state: PolicyStateValue): StoredCompletedCall[] {
		return Array.isArray(state.completedCalls) ? state.completedCalls.filter(isStoredCompleted) : [];
	}

	private statesOf(state: ObservationState, now: number, turn: number): Record<string, StateView> {
		return Object.fromEntries(state.snapshot(now, turn).map((view) => [view.id, view] as const));
	}

	private async activeRules(
		surface: PolicySurface,
		context: Context,
	): Promise<{ snapshot: RuleSnapshot; agent: Durable.Agent; scope: RuleMatchContext; rules: ProgramRule[]; installed: string[] }> {
		const snapshot = await this.snapshot();
		const agent = await surface.agent(context);
		const installed = [...new Set(surface.registry.tools().map((entry) => entry.tool.name))];
		const model = agent.model;
		const scope: RuleMatchContext = {
			provider: model?.provider,
			model: model ? `${model.provider}/${model.modelId}` : undefined,
			cwd: agent.cwd ?? this.cwd,
		};
		const rules = [...snapshot.records.values()]
			.filter(
				(record) =>
					effectiveState(record) === "active" &&
					record.matcherAvailable &&
					ruleScopeMatches(record.definition.scope, scope),
			)
			.map(compileRule);
		return { snapshot, agent, scope, rules, installed };
	}

	private publicContext(
		snapshot: RuleSnapshot,
		agent: Durable.Agent,
		turn: number,
		installed: readonly string[],
	): Record<string, unknown> {
		if (installed.length > MAX_CATALOG_TOOLS || agent.tools.length > MAX_CATALOG_TOOLS)
			return { turn, catalogAvailable: false, tools: UNKNOWN };
		const names = new Set<string>();
		const gather = (condition: ProgramRule["program"]["when"]): void => {
			if ("all" in condition) for (const child of condition.all) gather(child);
			else if ("any" in condition) for (const child of condition.any) gather(child);
			else if ("not" in condition) gather(condition.not);
			else if (condition.path[0] === "context" && condition.path[1] === "tools" && condition.path[2])
				names.add(condition.path[2]);
		};
		for (const record of snapshot.records.values()) {
			if (effectiveState(record) !== "active") continue;
			const compiled = compileRule(record);
			const spec = compiled.program;
			if (compiled.applicability) gather(compiled.applicability);
			gather(spec.when);
			if (spec.state) {
				gather(spec.state.observe);
				if (spec.state.resetWhen) gather(spec.state.resetWhen);
			}
			if (names.size > MAX_CATALOG_TOOLS) return { turn, catalogAvailable: false, tools: UNKNOWN };
		}
		const configured = new Set(installed);
		const active = new Set(agent.tools.map((tool) => tool.name));
		return {
			turn,
			catalogAvailable: true,
			tools: Object.fromEntries(
				[...names].map((name) => [name, { configured: configured.has(name), active: active.has(name) }]),
			),
		};
	}

	private evaluationContext(
		tool: string,
		input: Record<string, unknown> | undefined,
		snapshot: RuleSnapshot,
		agent: Durable.Agent,
		scope: RuleMatchContext,
		state: ObservationState,
		turn: number,
		now: number,
		installed: readonly string[],
	): EvaluationContext {
		return {
			tool,
			facts: { input, context: this.publicContext(snapshot, agent, turn, installed) },
			states: this.statesOf(state, now, turn),
			schema: agent.tools.find((entry) => entry.name === tool)?.parameters,
			data: snapshotData([...snapshot.data.values()], now),
			now,
			mode: this.effectiveMode(snapshot),
			scope,
		};
	}

	private factsFor(call: ObservedCall, result?: PolicyResult, outcome?: CallOutcome): PolicyFacts {
		return {
			input: call.input,
			original: call.requested,
			context: call.context.facts?.context,
			result: result
				? {
						tool: call.tool,
						isError: result.isError === true,
						...(result.content !== undefined ? { content: result.content } : {}),
						...(result.details !== undefined ? { details: result.details } : {}),
						...(result.usage !== undefined ? { usage: result.usage } : {}),
					}
				: undefined,
			outcome: outcome
				? {
						kind: outcome,
						isError: result?.isError === true,
						outputBytes: call.outputBytes ?? UNKNOWN,
						preGuidanceBytes: call.preGuidanceBytes ?? UNKNOWN,
						executed: call.resultSeen,
						denied: outcome === "denied",
						abortRequested: call.abortRequested === true,
						complete: call.complete,
					}
				: undefined,
		};
	}

	private contextFor(
		call: ObservedCall,
		state: ObservationState,
		now: number,
		result?: PolicyResult,
		outcome?: CallOutcome,
	): EvaluationContext {
		const data = snapshotData(
			Object.values(call.context.data ?? {}).flatMap((source) => (source.data ? [source.data] : [])),
			now,
		);
		return {
			...call.context,
			data,
			facts: this.factsFor(call, result, outcome),
			states: this.statesOf(state, now, call.turn),
			matched: call.matches,
			now,
		};
	}

	private makeObservedCall(
		tool: string,
		callId: string,
		args: unknown,
		rules: ProgramRule[],
		snapshot: RuleSnapshot,
		agent: Durable.Agent,
		scope: RuleMatchContext,
		state: ObservationState,
		turn: number,
		now: number,
		conversationId: Durable.ConversationId,
		installed: readonly string[],
	): ObservedCall {
		const input = inputSnapshot(args);
		const captured = input ? captureFor(tool, input) : undefined;
		const context = this.evaluationContext(tool, input, snapshot, agent, scope, state, turn, now, installed);
		const matches = new Set(
			[...captureProgramEvidence(rules, context, input)]
				.filter(([, truth]) => truth === true)
				.map(([id]) => id),
		);
		const pins = new Map<string, StatePin>();
		for (const rule of rules) {
			const pin = state.pin(rule.id);
			if (pin) pins.set(rule.id, pin);
		}
		const model = scope.model ?? null;
		return {
			tool,
			callId,
			at: new Date(now).toISOString(),
			startedAt: now,
			pending: startCall(tool, callId, input ?? {}, new Date(now), now, captured),
			sessionFacts: {
				session: this.sessionLabel(conversationId),
				mode: "durable",
				cwd: scope.cwd,
				model,
				thinkingLevel: agent.thinkingLevel ?? null,
				projectContext: false,
				ruleStoreDegraded: snapshot.health.status === "degraded",
			},
			requested: input,
			input,
			rules,
			pins,
			matches,
			classes: [...matches],
			corrections: [],
			inputEvaluations: [],
			evaluations: [],
			effects: {},
			context,
			generation: 0,
			turn,
			complete: input !== undefined,
			resultSeen: false,
		};
	}

	private memoFor(call: ObservedCall, plan: InputPlan | undefined): PolicyCallMemo {
		const original = call.input && Buffer.byteLength(JSON.stringify(call.input), "utf8") <= MAX_MEMO_INPUT_BYTES
			? (call.input as JsonValue)
			: undefined;
		return {
			tool: call.tool,
			callId: call.callId,
			at: call.at,
			startedAt: call.startedAt,
			complete: call.complete,
			pins: [...call.pins.values()].map((pin) => ({
				id: pin.id,
				revision: pin.revision,
				generation: pin.generation,
			})),
			classes: [...call.classes],
			corrections: plan?.corrections ?? [],
			inputEvaluations: plan ? (boundedRows(metadata(plan.evaluations)).rows as JsonValue[]) : [],
			...(call.captured !== undefined ? { captured: call.captured } : {}),
			...(call.decision !== undefined ? { decision: call.decision } : {}),
			...(original !== undefined ? { original } : {}),
		};
	}

	private observedFromMemo(
		call: ToolCall,
		memo: PolicyCallMemo | undefined,
		rules: ProgramRule[],
		snapshot: RuleSnapshot,
		agent: Durable.Agent,
		scope: RuleMatchContext,
		state: ObservationState,
		turn: number,
		now: number,
		conversationId: Durable.ConversationId,
		installed: readonly string[],
	): ObservedCall {
		const observed = this.makeObservedCall(
			call.name,
			call.id,
			call.arguments,
			rules,
			snapshot,
			agent,
			scope,
			state,
			turn,
			now,
			conversationId,
			installed,
		);
		if (!memo) return observed;
		const memoOriginal = objectValue(memo.original);
		const input = inputSnapshot(call.arguments) ?? memoOriginal;
		const memoRuleIds = new Set(memo.pins.map((pin) => pin.id));
		return {
			...observed,
			at: memo.at,
			startedAt: memo.startedAt,
			pending: startCall(memo.tool, memo.callId, input ?? {}, new Date(now), now, memo.captured),
			requested: memoOriginal ?? input,
			input,
			rules: rules.filter((rule) => memoRuleIds.has(rule.id)),
			pins: new Map(
				memo.pins.map((pin) => [pin.id, { id: pin.id, revision: pin.revision, generation: pin.generation }]),
			),
			matches: new Set(memo.classes),
			classes: [...memo.classes],
			corrections: memo.corrections,
			inputEvaluations: memo.inputEvaluations,
			decision: memo.decision,
			complete: memo.complete,
		};
	}

	private currentRulesOf(call: ObservedCall, state: ObservationState): ProgramRule[] {
		return call.rules.filter((rule) => samePin(call.pins.get(rule.id), state.pin(rule.id)));
	}

	private inputPlan(call: ObservedCall, state: ObservationState, now: number, applyCorrections: boolean): InputPlan {
		const current = new Set(this.currentRulesOf(call, state).map((rule) => rule.id));
		return planInput(call.rules, call.input ?? {}, {
			...this.contextFor(call, state, now),
			applyCorrections,
			staleRules: new Set(call.rules.filter((rule) => !current.has(rule.id)).map((rule) => rule.id)),
		});
	}

	/** Guidance lines and safe command segments for the rules behind one denied input plan. */
	private refusalText(call: ObservedCall, plan: InputPlan, snapshot: RuleSnapshot): string | undefined {
		const denials = plan.evaluations.filter((evaluation) => evaluation.deny);
		const ids = new Set(denials.length ? denials.map((evaluation) => evaluation.id) : call.classes);
		return guidanceText(
			[...ids].flatMap((id) => {
				const record = snapshot.records.get(id);
				if (!record) return [];
				const segments = new Set(
					denials
						.filter((entry) => entry.id === id)
						.flatMap((entry) => {
							if (!entry.matchedSegment) return [];
							const segment =
								entry.inputView === "effective" && plan.corrections.length > 0
									? "[corrected input omitted]"
									: entry.matchedSegment;
							return [`Matched command: ${segment}`];
						}),
				);
				return [ruleGuidance(record), ...segments];
			}),
		);
	}

	/** Eligible guide text; projects every selected rule into the observation state. */
	private selectGuidance(
		state: ObservationState,
		evaluations: readonly ProgramEvaluation[],
		mode: PolicyMode,
		now: number,
		turn: number,
		onProjected?: (id: string) => void,
	): string | undefined {
		if (!PROJECTION_MODES.includes(mode)) return undefined;
		const eligible = evaluations.filter(
			(evaluation) =>
				evaluation.truth === true &&
				evaluation.action.kind === "guide" &&
				state.eligible(evaluation.id, now, turn),
		);
		const selected: ProgramEvaluation[] = [];
		const lines: string[] = [];
		for (const entry of eligible) {
			if (entry.action.kind !== "guide") continue;
			const next = guidanceText([...lines, entry.action.text]);
			if (next === guidanceText(lines)) continue;
			lines.push(entry.action.text);
			selected.push(entry);
		}
		const text = guidanceText(lines);
		if (text)
			for (const entry of selected) {
				state.project(entry.id, now, turn);
				onProjected?.(entry.id);
			}
		return text;
	}

	private trackPending(callId: string): void {
		if (this.pendingCalls.has(callId) || this.pendingCalls.size >= MAX_PENDING) {
			this.incomplete += 1;
			return;
		}
		this.pendingCalls.set(callId, true);
	}

	private endPending(callId: string): void {
		this.pendingCalls.delete(callId);
	}

	/** The result-phase decision for one call: assert-error correction and eligible guidance. */
	private resultEffects(
		call: ObservedCall,
		observation: ObservationState,
		current: readonly ProgramRule[],
		mode: PolicyMode,
		result: PolicyResult,
		now: number,
	): { correction: boolean; semantic: ProgramEvaluation[]; guides: ProgramEvaluation[]; guidance?: string } {
		const semantic = evaluatePrograms(current, "result", this.contextFor(call, observation, now, result)).filter(
			(evaluation) => evaluation.action.kind !== "guide",
		);
		const correction =
			mode === "enforce" &&
			result.isError !== true &&
			semantic.some((evaluation) => evaluation.truth === true && evaluation.action.kind === "assert-error");
		const effective = correction ? { ...result, isError: true } : result;
		const guides = evaluatePrograms(current, "result", this.contextFor(call, observation, now, effective)).filter(
			(evaluation) => evaluation.action.kind === "guide",
		);
		return { correction, semantic, guides, guidance: this.selectGuidance(observation, guides, mode, now, call.turn) };
	}

	/** Completion-phase evaluations, observation completion, and retained guidance. */
	private completionEffects(
		call: ObservedCall,
		observation: ObservationState,
		current: readonly ProgramRule[],
		context: EvaluationContext,
		mode: PolicyMode,
		now: number,
		state: PolicyStateValue,
	): { evaluations: ProgramEvaluation[]; guides: ProgramEvaluation[]; stale: number } {
		const evaluations = evaluatePrograms(current, "completion", context).filter(
			(evaluation) => evaluation.action.kind !== "guide",
		);
		let stale = 0;
		for (const rule of current) {
			const selected = observationSelected(rule, context);
			const pin = call.pins.get(rule.id);
			if (pin && selected === true && !observation.complete(pin, programFacts(rule, context), call.turn, now))
				stale += 1;
		}
		const guides = evaluatePrograms(current, "completion", context).filter(
			(evaluation) => evaluation.action.kind === "guide",
		);
		if (PROJECTION_MODES.includes(mode)) this.retainGuidance(state, observation, guides, now, call.turn);
		return { evaluations, guides, stale };
	}

	private retainGuidance(
		state: PolicyStateValue,
		observation: ObservationState,
		evaluations: readonly ProgramEvaluation[],
		now: number,
		turn: number,
	): void {
		for (const evaluation of evaluations) {
			const pin = observation.pin(evaluation.id);
			if (pin && evaluation.truth === true && observation.eligible(evaluation.id, now, turn))
				state.retainedGuidance = [
					...this.retainedGuidanceOf(state).filter((entry) => entry.id !== evaluation.id),
					{
						id: evaluation.id,
						revision: pin.revision,
						generation: pin.generation,
						evaluation: evaluation as unknown as JsonValue,
					},
				];
		}
	}

	/** Run the result and completion phases and record one decision for this call id. */
	private async completeCall(
		call: ObservedCall,
		result: PolicyResult,
		outcome: CallOutcome,
		mode: PolicyMode,
		rules: ProgramRule[],
		truncated: boolean | undefined,
		surface: PolicyTaskSurface,
		context: Context,
		now: number,
	): Promise<{ guidance?: string; correction: boolean; record?: PolicyRecord }> {
		return this.withState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			const existing = this.completedCallsOf(state).find((entry) => entry.id === call.callId);
			if (existing) return { guidance: existing.guidance, correction: existing.correction === true };
			const current = call.generation === state.generation ? this.currentRulesOf(call, observation) : [];
			this.stale += call.rules.length - current.length;
			const effects = this.resultEffects(call, observation, current, mode, result, now);
			if (effects.guidance) call.effects.annotationBytes = Buffer.byteLength(effects.guidance, "utf8");
			const completion = this.completionEffects(
				call,
				observation,
				current,
				this.contextFor(call, observation, now, result, outcome),
				mode,
				now,
				state,
			);
			this.stale += completion.stale;
			const record = this.telemetryRecord(
				call,
				result,
				outcome,
				mode,
				effects.semantic,
				effects.guides,
				completion.evaluations,
				completion.guides,
				now,
				truncated,
			);
			state.completedCalls = [
				...this.completedCallsOf(state).filter((entry) => entry.id !== call.callId),
				{
					id: call.callId,
					...(effects.guidance ? { guidance: effects.guidance } : {}),
					...(effects.correction ? { correction: true } : {}),
				},
			].slice(-COMPLETED_CALLS);
			state.observation = observation.toJSON() as unknown as JsonValue;
			this.endPending(call.callId);
			return { guidance: effects.guidance, correction: effects.correction, record };
		});
	}

	private dataSnapshotRows(call: ObservedCall): { rows: unknown[]; total: number; omitted: number } {
		const dataNames = new Set([
			...Object.keys(call.context.data ?? {}),
			...call.rules.flatMap(programSteps).flatMap((rule) => rule.program.data ?? []),
		]);
		return boundedRows(
			[...dataNames].sort().map((name) => {
				const binding = call.context.data?.[name];
				return {
					name,
					status: binding?.status ?? "missing",
					...(binding?.revision !== undefined ? { revision: binding.revision } : {}),
					...(binding?.capturedAt !== undefined ? { capturedAt: binding.capturedAt } : {}),
					...(binding?.ageMs !== undefined ? { ageMs: binding.ageMs } : {}),
					...(binding?.data?.maxAgeMs !== undefined ? { maxAgeMs: binding.data.maxAgeMs } : {}),
					...(call.context.now !== undefined ? { snapshotAt: call.context.now } : {}),
				};
			}),
		);
	}

	private telemetryRecord(
		call: ObservedCall,
		result: PolicyResult,
		outcome: CallOutcome,
		mode: PolicyMode,
		semantic: ProgramEvaluation[],
		guides: ProgramEvaluation[],
		completion: ProgramEvaluation[],
		completionGuides: ProgramEvaluation[],
		now: number,
		truncated: boolean | undefined,
	): PolicyRecord {
		const rows = {
			evaluations: boundedRows([...call.inputEvaluations, ...metadata([...semantic, ...guides, ...completion, ...completionGuides])]),
			corrections: boundedRows(call.corrections),
			generations: boundedRows([...call.pins.values()]),
			dataSnapshots: this.dataSnapshotRows(call),
			metadata: boundedRows(
				completion
					.filter((evaluation) => evaluation.truth === true && evaluation.action.kind === "observe")
					.map((evaluation) => ({
						id: evaluation.id,
						label: evaluation.action.kind === "observe" ? evaluation.action.label : "",
					})),
			),
		};
		const effects: CallEffects = {
			...call.effects,
			outcome,
			abortRequested: call.abortRequested === true,
			blocked: outcome === "denied",
			observationComplete: call.complete && outcome !== "unexecuted",
			policy: {
				...call.effects.policy,
				decision: call.decision ? "deny" : "none",
				...(call.preGuidanceBytes !== undefined ? { preGuidanceBytes: call.preGuidanceBytes } : {}),
				evaluations: rows.evaluations.rows,
				corrections: rows.corrections.rows,
				generations: rows.generations.rows,
				dataSnapshots: rows.dataSnapshots.rows,
				metadata: rows.metadata.rows,
				coverage: {
					evaluations: { total: rows.evaluations.total, omitted: rows.evaluations.omitted },
					corrections: { total: rows.corrections.total, omitted: rows.corrections.omitted },
					generations: { total: rows.generations.total, omitted: rows.generations.omitted },
					dataSnapshots: { total: rows.dataSnapshots.total, omitted: rows.dataSnapshots.omitted },
					metadata: { total: rows.metadata.total, omitted: rows.metadata.omitted },
				},
			},
		};
		const usage = objectValue(result.usage);
		return finishCall(
			call.pending,
			{
				content: result.content,
				isError: result.isError === true,
				truncated: truncated === true,
				tokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : null,
			},
			call.sessionFacts,
			mode,
			effects,
			now,
		);
	}

	private async writeTelemetry(record: PolicyRecord | undefined): Promise<void> {
		if (!record) return;
		const failure = await appendRecord(this.dir, record);
		if (failure && this.telemetryFailure === undefined) {
			this.telemetryFailure = failure;
			try {
				console.warn(`[policy] telemetry persistence stopped: ${failure}`);
			} catch {
				/* Failure reporting must not create an unhandled rejection. */
			}
		}
	}

	async beforeTool(
		call: ToolCall,
		api: Durable.HookApi,
		context: Context,
	): Promise<{ block?: string; arguments?: Durable.JsonObject } | undefined> {
		if (!this.modeValid) return undefined;
		const surface = api as unknown as PolicyTaskSurface;
		const now = surface.now();
		this.trackPending(call.id);
		const { snapshot, agent, scope, rules, installed } = await this.activeRules(surface, context);
		const turn = await this.turnOf(surface, context);
		const base = await this.readState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			return { state, observation };
		});
		const observed = this.makeObservedCall(
			call.name,
			call.id,
			call.arguments,
			rules,
			snapshot,
			agent,
			scope,
			base.observation,
			turn,
			now,
			surface.conversationId,
			installed,
		);
		observed.generation = base.state.generation;
		const mode = this.effectiveMode(snapshot);
		let reason: string | undefined;
		if (!observed.input) {
			observed.complete = false;
			const current = this.currentRulesOf(observed, base.observation);
			const evidence = captureProgramEvidence(current, this.contextFor(observed, base.observation, now), undefined, undefined);
			const unavailable = evaluatePrograms(current, "input", { ...this.contextFor(observed, base.observation, now), evidence }).map(
				markUnavailable(current),
			);
			observed.evaluations.push(...unavailable);
			observed.classes = [...new Set([...observed.classes, ...unavailable.filter((entry) => entry.truth === true).map((entry) => entry.id)])];
			if (mode === "enforce" && unavailable.some((entry) => entry.deny))
				reason = "[policy] An approved input check refused unavailable input.";
		}
		const plan = this.inputPlan(observed, base.observation, now, mode === "enforce");
		if (reason === undefined && mode === "enforce" && (plan.denied || !plan.valid)) {
			observed.decision =
				this.refusalText(observed, plan, snapshot) ?? "[policy] The approved input checks refused this call.";
			reason = observed.decision;
		}
		await surface.memo("policy.call", this.memoFor(observed, plan), context);
		if (reason !== undefined) {
			observed.resultSeen = false;
			const update = await this.completeCall(observed, { isError: true }, "denied", mode, rules, undefined, surface, context, now);
			await this.writeTelemetry(update.record);
			return { block: update.guidance ? `${reason}\n${update.guidance}` : reason };
		}
		if (mode === "enforce" && plan.valid && !plan.denied && plan.changed) {
			observed.effects.policy = { ...observed.effects.policy, inputCorrected: true };
			return { arguments: plan.candidate as unknown as Durable.JsonObject };
		}
		return undefined;
	}

	async afterTool(
		call: ToolCall,
		result: Durable.ToolExecutionResult,
		api: Durable.HookApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult | undefined> {
		if (!this.modeValid) return undefined;
		const surface = api as unknown as PolicyTaskSurface;
		const now = surface.now();
		const memo = await surface.memo<PolicyCallMemo>("policy.call", context);
		const { snapshot, agent, scope, rules, installed } = await this.activeRules(surface, context);
		const turn = await this.turnOf(surface, context);
		const reading = await this.readState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			return { state, observation };
		});
		const observed = this.observedFromMemo(
			call,
			memo,
			rules,
			snapshot,
			agent,
			scope,
			reading.observation,
			turn,
			now,
			surface.conversationId,
			installed,
		);
		observed.generation = reading.state.generation;
		observed.resultSeen = true;
		observed.abortRequested = surface.signal.aborted;
		observed.preGuidanceBytes = textContentBytes(result.content);
		observed.outputBytes = observed.preGuidanceBytes;
		const details = objectValue(result.details);
		const truncation = objectValue(details?.truncation);
		const update = await this.completeCall(
			observed,
			result,
			result.isError === true ? "execution-error" : "success",
			this.effectiveMode(snapshot),
			rules,
			truncation?.truncated === true,
			surface,
			context,
			now,
		);
		await this.writeTelemetry(update.record);
		const guidance = update.guidance;
		if (!guidance && !update.correction) return undefined;
		let content = result.content;
		if (guidance) content = [...(content ?? []), { type: "text" as const, text: guidance }];
		return {
			...result,
			...(update.correction ? { isError: true } : {}),
			...(content !== undefined ? { content } : {}),
		};
	}

	async beforeRequest(
		request: { readonly messages: readonly Message[] },
		api: Durable.HookApi,
		context: Context,
	): Promise<{ messages: readonly Message[] } | undefined> {
		if (!this.modeValid) return undefined;
		const surface = api as unknown as PolicyTaskSurface;
		const now = surface.now();
		const { snapshot, agent, scope, rules, installed } = await this.activeRules(surface, context);
		const view = await surface.context(surface.conversationId, context);
		const turn = view.messages.filter((message) => message.role === "assistant").length + 1;
		const mode = this.effectiveMode(snapshot);
		const update = await this.withState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			state.turn = Math.max(state.turn, turn);
			let text: string | undefined;
			let card: string | undefined;
			if (PROJECTION_MODES.includes(mode)) {
				const retained = this.retainedGuidanceOf(state).filter((entry) => {
					const rule = rules.find((candidate) => candidate.id === entry.id);
					return (
						rule !== undefined &&
						rule.revision === entry.revision &&
						samePin({ id: entry.id, revision: entry.revision, generation: entry.generation }, observation.pin(entry.id))
					);
				});
				state.retainedGuidance = retained;
				const contextPrograms = evaluatePrograms(rules, "context", {
					tool: "",
					facts: { context: this.publicContext(snapshot, agent, turn, installed) },
					states: this.statesOf(observation, now, turn),
					data: snapshotData([...snapshot.data.values()], now),
					now,
					mode,
					scope,
				});
				const projected = new Set<string>();
				text = this.selectGuidance(
					observation,
					[...retained.map((entry) => entry.evaluation as unknown as ProgramEvaluation), ...contextPrograms],
					mode,
					now,
					turn,
					(id) => projected.add(id),
				);
				state.retainedGuidance = this.retainedGuidanceOf(state).filter((entry) => !projected.has(entry.id));
				if (!state.shellCardDelivered && agent.tools.some((tool) => tool.name === "bash")) {
					card = shellContractCard(
						snapshot.records.values(),
						scope,
						this.publicContext(snapshot, agent, turn, installed),
					);
					if (card) state.shellCardDelivered = true;
				}
			}
			state.observation = observation.toJSON() as unknown as JsonValue;
			return { text, card };
		});
		const messages = [...request.messages];
		if (update.card) messages.push(userMessage(update.card, now));
		if (update.text) messages.push(userMessage(update.text, now));
		return messages.length === request.messages.length ? undefined : { messages };
	}

	private async turnOf(surface: PolicyTaskSurface, context: Context): Promise<number> {
		const view = await surface.context(surface.conversationId, context);
		return view.messages.filter((message) => message.role === "assistant").length;
	}

	// ─── Tool surfaces ────────────────────────────────────────────────────────

	async executeRules(
		params: Static<typeof PolicyRulesParams>,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult> {
		context.abortSignal?.throwIfAborted();
		validateInspectionParams(params);
		const surface = api as unknown as PolicySurface;
		const snapshot = await this.snapshot();
		const { agent, scope } = await this.activeRules(surface, context);
		const view = params.view ?? "rules";
		const output = await this.rulesOutput(params, view, snapshot, agent, scope, surface, context);
		return {
			content: [{ type: "text", text: output }],
			details: {
				structuredContent: {
					rules: snapshot.records.size,
					pending: snapshot.pending.length,
					ruleStoreDegraded: snapshot.health.status === "degraded",
					ruleStorePath: snapshot.health.path,
				},
			},
		};
	}

	private async rulesOutput(
		params: Static<typeof PolicyRulesParams>,
		view: string,
		snapshot: RuleSnapshot,
		agent: Durable.Agent,
		scope: RuleMatchContext,
		surface: PolicySurface,
		context: Context,
	): Promise<string> {
		if (view === "rules") {
			if (params.id) {
				const record = snapshot.records.get(params.id);
				const pending = snapshot.pending.filter((entry) => entry.ruleId === params.id || entry.id === params.id);
				if (pending.length) return pendingProposalOutput(pending[0]);
				return record
					? formatRulesTool(
							{ ...snapshot, records: new Map([[record.id, record]]), pending: [] },
							toolScope(scope, agent.model),
						)
					: `No rule or pending proposal named ${params.id}.`;
			}
			return formatRulesTool(snapshot, toolScope(scope, agent.model));
		}
		if (view === "authoring") return authoringGuide();
		if (view === "check") {
			const draftContext: DraftCheckContext = toolScope(scope, agent.model);
			const catalog = {
				getAllTools: () => agent.tools.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
				getActiveTools: () => agent.tools.map((tool) => tool.name),
			} as unknown as Parameters<typeof checkDraft>[2];
			return boundedInspection(JSON.stringify(await checkDraft(params, snapshot, catalog, draftContext, parseAuthoringDraft)));
		}
		if (view === "catalog") return formatCatalog(this.registry, params.id);
		if (view === "data") return formatDataView(snapshot, params.id);
		if (view === "capabilities" || view === "state" || view === "health" || view === "explain" || view === "preview")
			return boundedInspection(await this.inspect(view as PolicyInspectionView, params, surface, context));
		throw new Error(`policy ${view} inspection is unavailable: runtime callback absent`);
	}

	async executePropose(
		params: Static<typeof PolicyProposeParams>,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult> {
		context.abortSignal?.throwIfAborted();
		validateProposal(params);
		const surface = api as unknown as PolicySurface;
		await this.snapshot();
		const { agent } = await this.activeRules(surface, context);
		const auditValue: AgentRuleAudit = makeRuleAudit(this.auditContext(surface.conversationId, agent), "agent-tool");
		const event = await submitProposal(this.registry, params, auditValue);
		await this.snapshot();
		const revision = proposalRevision(event);
		return {
			content: [
				{
					type: "text",
					text: `Pending proposal ${event.id}: ${event.operation} ${event.ruleId}. Revision: ${revision}. It is inert until operator approval. After clear contextual approval, use policy_approve with this proposal ID, revision, and authorized effect. The operator need not type identifiers or a command.`,
				},
			],
			details: {
				structuredContent: {
					proposalId: event.id,
					proposalRevision: revision,
					state: "pending",
					operation: event.operation,
					ruleId: event.ruleId,
				},
			},
		};
	}

	async executeApprove(
		params: Static<typeof PolicyApproveParams>,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult> {
		context.abortSignal?.throwIfAborted();
		if (!params.authorization.trim())
			throw new Error(
				"policy_approve requires proposalId, proposalRevision, effect (steer, block, or exact), and a nonblank authorization explanation only",
			);
		const surface = api as unknown as PolicySurface;
		const before = await this.snapshot();
		const proposal = before.pending.find((entry) => entry.id === params.proposalId);
		if (!proposal)
			throw new Error(
				"No pending proposal with that ID. Inspect policy_rules; do not substitute another proposal for the approved one.",
			);
		context.abortSignal?.throwIfAborted();
		const { agent, scope } = await this.activeRules(surface, context);
		const auditValue: OperatorRuleAudit = {
			...makeRuleAudit(this.auditContext(surface.conversationId, agent), "agent-tool"),
			surface: "approval-tool",
			authorization: params.authorization,
		};
		await this.registry.decide(
			proposal.id,
			"approved",
			params.effect === "exact" ? undefined : params.effect,
			auditValue,
			params.proposalRevision,
		);
		const snapshot = await this.snapshot();
		const record = snapshot.records.get(proposal.ruleId);
		if (!record || snapshot.pending.some((entry) => entry.id === proposal.id))
			throw new Error(
				"Approval was written, but rule readback did not confirm application. Inspect policy_rules before retrying.",
			);
		const result = approvalReadback(
			record,
			proposal,
			toolScope(scope, agent.model),
			this.getMode(),
			snapshot.health.status,
		);
		return {
			content: [{ type: "text", text: boundedInspection(result) }],
			details: { structuredContent: result },
		};
	}

	async executeControl(
		params: Static<typeof PolicyControlParams>,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult> {
		context.abortSignal?.throwIfAborted();
		validateControl(params);
		const surface = api as unknown as PolicySurface;
		if (params.operation !== "mode" && params.operation !== "telemetry") await this.snapshot();
		const { agent, scope } = await this.activeRules(surface, context);
		const deps = this.deps(surface, context);
		const toolContext: PolicyToolContext = {
			cwd: scope.cwd,
			model: agent.model ? { provider: agent.model.provider, id: agent.model.modelId } : null,
			sessionManager: { getSessionId: () => this.sessionLabel(surface.conversationId) },
		};
		const value =
			"authorization" in params
				? await applyControl(deps, params, toolContext, context.abortSignal)
				: await previewControl(deps, params, toolContext);
		const result = controlResult(
			value,
			params.operation === "inspect" ? MAX_RULE_EVENT_BYTES * 6 + 4096 : 48 * 1024,
		);
		return { ...result, details: { structuredContent: result.details as JsonValue } };
	}

	private deps(surface: PolicySurface, context: Context): ToolDeps {
		return {
			registry: this.registry,
			loadRegistry: () => this.snapshot(),
			getMode: () => this.getMode(),
			resetRevision: (id) => this.resetRevision(id, surface, context),
			reset: (id, reason, revision) => this.resetObservation(id, reason, revision, surface, context),
			telemetry: async (from, to) => ({ report: formatTelemetry(await readTelemetry(this.dir, from, to)) }),
			inspect: (view, params) => this.inspect(view, params, surface, context),
		};
	}

	private auditContext(
		conversationId: Durable.ConversationId,
		agent: Durable.Agent,
	): { sessionManager: { getSessionId(): string }; model?: { provider: string; id: string } | null } {
		return {
			sessionManager: { getSessionId: () => this.sessionLabel(conversationId) },
			model: agent.model ? { provider: agent.model.provider, id: agent.model.modelId } : null,
		};
	}

	private async resetRevision(id: string, surface: PolicySurface, context: Context): Promise<string> {
		const now = Date.now();
		const { rules, scope } = await this.activeRules(surface, context);
		return this.readState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			void scope;
			const periods = observation
				.snapshot(now, state.turn)
				.filter((period) => id === "--all" || period.id === id)
				.map(({ id: periodId, revision, generation }) => ({ id: periodId, revision, generation }))
				.sort((left, right) => left.id.localeCompare(right.id));
			if (id !== "--all" && !periods.length) throw new Error(`No active rule named ${id}`);
			return contentRevision({
				instance: this.resetIdentity,
				selector: id,
				generation: state.generation,
				periods,
			});
		});
	}

	private async resetObservation(
		id: string,
		reason: string,
		revision: string,
		surface: PolicySurface,
		context: Context,
	): Promise<void> {
		if (!reason.trim() || reason.length > 1000) throw new Error("A bounded reset reason is required");
		const now = Date.now();
		const { rules } = await this.activeRules(surface, context);
		await this.withState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			const periods = observation
				.snapshot(now, state.turn)
				.filter((period) => id === "--all" || period.id === id)
				.map(({ id: periodId, revision: periodRevision, generation }) => ({
					id: periodId,
					revision: periodRevision,
					generation,
				}))
				.sort((left, right) => left.id.localeCompare(right.id));
			if (id !== "--all" && !periods.length) throw new Error(`No active rule named ${id}`);
			const current = contentRevision({
				instance: this.resetIdentity,
				selector: id,
				generation: state.generation,
				periods,
			});
			if (current !== revision)
				throw new Error("Observation period revision changed; inspect the current reset target");
			if (id === "--all") {
				state.generation += 1;
				state.retainedGuidance = [];
				observation.reset(reason, now);
			} else {
				observation.reset(reason, now, id);
				state.retainedGuidance = this.retainedGuidanceOf(state).filter((entry) => entry.id !== id);
			}
			state.observation = observation.toJSON() as unknown as JsonValue;
		});
	}

	// ─── Read-only inspection ─────────────────────────────────────────────────

	private async inspect(
		view: PolicyInspectionView,
		params: Record<string, unknown>,
		surface: PolicySurface,
		context: Context,
	): Promise<unknown> {
		const now = Date.now();
		const snapshot = await this.snapshot();
		const { agent, scope, rules, installed } = await this.activeRules(surface, context);
		const reading = await this.readState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			return { state, observation };
		});
		if (view === "state") {
			return {
				observationPeriods: publicState(reading.observation.snapshot(now, reading.state.turn)),
				turn: reading.state.turn,
				incomplete: this.incomplete,
				staleCompletions: this.stale,
				retainedGuidance: this.retainedGuidanceOf(reading.state).map((entry) => ({
					id: entry.id,
					revision: entry.revision,
					generation: entry.generation,
				})),
			};
		}
		if (view === "health") {
			return {
				authority: snapshot.health,
				telemetry: this.telemetryFailure ? { status: "failed", reason: this.telemetryFailure } : { status: "ready" },
				observations: {
					incomplete: this.incomplete,
					pending: this.pendingCalls.size,
					recentCompletedIds: this.completedCallsOf(reading.state).length,
				},
			};
		}
		if (view === "capabilities") {
			const active = new Set(agent.tools.map((tool) => tool.name));
			return {
				phases: ["input", "result", "completion", "context"],
				actions: ["deny", "rename-key", "substitute", "assert-error", "guide", "observe"],
				mode: this.getMode(),
				effectiveMode: this.modeValid ? this.effectiveMode(snapshot) : "unavailable",
				schemas: {
					available: installed.length <= MAX_CATALOG_TOOLS,
					tools: [...new Set(installed)].sort().map((name) => ({
						name,
						active: active.has(name),
						configured: true,
					})),
				},
				innerSchemas: "Unavailable; decoded argument corrections are unsupported",
				dataKinds: ["table"],
				observationStorage: "conversation document",
				projection: "message append, no new turn",
			};
		}
		if (view === "explain") return this.inspectExplain(params, snapshot, reading.state, reading.observation, now, surface);
		if (view === "preview")
			return this.inspectPreview(params, snapshot, agent, scope, reading.state, reading.observation, now, surface, installed);
		throw new Error(`Unknown policy view: ${view}`);
	}

	private async inspectExplain(
		params: Record<string, unknown>,
		snapshot: RuleSnapshot,
		state: PolicyStateValue,
		observation: ObservationState,
		now: number,
		surface: PolicySurface,
	): Promise<unknown> {
		if (typeof params.id === "string" && params.id.startsWith("call:")) {
			const callId = params.id.slice(5);
			if (!callId || callId.length > 256) throw new Error("A bounded call identifier is required");
			const activity = await readRecentActivity(this.dir, undefined, 1, {
				session: this.sessionLabel(surface.conversationId),
				callId,
				includeUnmatched: true,
			});
			return {
				callId,
				scope: "current-session",
				evidence: "untrusted recorded policy observations",
				...activity,
				boundary:
					"A missing record may be outside this bounded read or not yet persisted. It does not prove no decision occurred.",
			};
		}
		const record = typeof params.id === "string" ? snapshot.records.get(params.id) : undefined;
		if (!record) throw new Error("An existing rule id is required");
		const period = observation.view(record.id, now, state.turn);
		return {
			id: record.id,
			revision: record.definition.revision,
			active: effectiveState(record),
			programs: programSteps(compileRule(record)).map((rule) => rule.program),
			scope: record.definition.scope,
			observationPeriod: period ? publicState([period])[0] : undefined,
		};
	}

	private inspectPreview(
		params: Record<string, unknown>,
		snapshot: RuleSnapshot,
		agent: Durable.Agent,
		scope: RuleMatchContext,
		state: PolicyStateValue,
		observation: ObservationState,
		now: number,
		surface: PolicySurface,
		installed: readonly string[],
	): unknown {
		if (typeof params.tool !== "string" || !params.tool || params.tool.length > 200)
			throw new Error("A bounded preview tool name is required");
		const input = inputSnapshot(params.input);
		if (!input) throw new Error("Preview input must be bounded JSON");
		const rules = [...snapshot.records.values()]
			.filter(
				(record) =>
					effectiveState(record) === "active" &&
					record.matcherAvailable &&
					ruleScopeMatches(record.definition.scope, scope),
			)
			.map(compileRule);
		const call = this.makeObservedCall(
			params.tool,
			"preview",
			input,
			rules,
			snapshot,
			agent,
			scope,
			observation,
			state.turn,
			now,
			surface.conversationId,
			installed,
		);
		call.generation = state.generation;
		const mode = this.effectiveMode(snapshot);
		const plan = this.inputPlan(call, observation, now, mode === "enforce");
		for (const id of plan.matches) call.matches.add(id);
		if (mode === "enforce" && plan.valid && !plan.denied) call.input = plan.candidate;
		const result = objectValue(params.result);
		const results = result
			? this.previewResultPlan(call, observation, mode, now, {
					content: Array.isArray(result.content)
						? (result.content as ContentLike[])
						: undefined,
					details: result.details,
					isError: result.isError === true,
				})
			: undefined;
		const inputEvaluations = relevantEvaluations(plan.evaluations);
		const allResults = results ? [...results.semantic, ...results.guides] : [];
		const resultEvaluations = relevantEvaluations(allResults);
		const relevantIds = new Set([
			...plan.matches,
			...inputEvaluations.map((evaluation) => evaluation.id),
			...resultEvaluations.map((evaluation) => evaluation.id),
		]);
		const evaluatedIds = new Set([...plan.evaluations, ...allResults].map((evaluation) => evaluation.id));
		const wouldCorrectInput = mode === "enforce" && plan.valid && !plan.denied && plan.changed;
		return {
			decision: {
				denied: mode === "enforce" && (plan.denied || !plan.valid),
				correctedInput: wouldCorrectInput,
				resultCorrected: results?.correction ?? false,
			},
			preview: true,
			stateAdvanced: false,
			mode,
			nonMatchingRules: [...evaluatedIds].filter((id) => !relevantIds.has(id)).length,
			executionInput: call.input,
			wouldCorrectInput,
			input: { ...plan, evaluations: inputEvaluations },
			results: resultEvaluations,
			resultCorrected: results?.correction ?? false,
			boundary: "No simulated tool executes. The actual inspection call retains ordinary telemetry.",
		};
	}

	private previewResultPlan(
		call: ObservedCall,
		state: ObservationState,
		mode: PolicyMode,
		now: number,
		result: PolicyResult,
	): { correction: boolean; semantic: ProgramEvaluation[]; guides: ProgramEvaluation[] } {
		const current = this.currentRulesOf(call, state);
		const semantic = evaluatePrograms(current, "result", this.contextFor(call, state, now, result)).filter(
			(evaluation) => evaluation.action.kind !== "guide",
		);
		const correction =
			mode === "enforce" &&
			result.isError !== true &&
			semantic.some((evaluation) => evaluation.truth === true && evaluation.action.kind === "assert-error");
		const effective = correction ? { ...result, isError: true } : result;
		const guides = evaluatePrograms(current, "result", this.contextFor(call, state, now, effective)).filter(
			(evaluation) => evaluation.action.kind === "guide",
		);
		return { correction, semantic, guides };
	}
}

function userMessage(text: string, timestamp: number): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}
