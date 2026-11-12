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
 * - `beforeRequest` is the context phase. Context programs and retained guidance
 *   become records in `policy.guidance`; each is projected after its anchor
 *   message on every later request, the native equivalent of the ordinary
 *   `context_with_system` projection.
 * - Compaction carries no policy decision and installs no hook.
 *
 * Observation periods are conversation-scoped because Durable turns and
 * replay identity are conversation-scoped; the ordinary runtime keeps one
 * session-wide state. `policy.state` holds the serialized `ObservationState`,
 * retained guidance, the initial shell card, the counted turn, a bounded
 * ring of completed calls with the result effect each decided, the revision
 * identity, and observation counters. `policy.guidance` holds the frozen
 * guidance records and their health status; record identity makes a repeated
 * request attempt idempotent. Every update recomputes inside one in-process tail and commits the
 * state and its task or call key together, so a replay after process loss
 * returns the recorded decision instead of deciding again. Hooks use only the
 * public `HookApi`: durable writes go through `host.harness.commit()` keyed by
 * the task or call identity, and the resolved agent comes from
 * `host.harness.conversation(id).agent()`. A hook decision that survives
 * process loss by itself uses `api.memo()` on the tool task. The rule store
 * stays external and revision-checked; only decisions and evidence live in
 * the document.
 *
 * `notice` mode has no terminal surface in a Durable agent. It records the
 * same metadata as the other modes and adds no notice; guidance and
 * corrections remain annotate/enforce only. Telemetry writes are
 * at-most-once: a newly applied completion writes one record after its state
 * commit.
 */
import { bool, lit, num, obj, str, type Schema, type Static } from "@earendil-works/pi-schema";
import { randomUUID } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { ActionApprovals, actionAuthority, type ActionBinding, type ActionControl, sameActionInput } from "./action-approval.ts";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { Message, ToolCall } from "@earendil-works/pi-ai";

import { authoringGuide, checkDraft, type DraftCheckContext } from "./authoring.ts";
import { captureFor, ruleScopeMatches } from "./classify.ts";
import {
	applyControl,
	controlResult,
	POLICY_CONTROL_DESCRIPTION,
	PolicyControlParams,
	previewControl,
	validateControl,
} from "./control.ts";
import { isOwnedInput, ownInput, prepareSchema, snapshotData, UNKNOWN } from "./data.ts";
import {
	makeRuleAudit,
	PolicyMutationCancelledError,
	MAX_RULE_EVENT_BYTES,
	proposalRevision,
	RuleRegistry,
	ruleAbsenceMessage,
	type RuleSnapshot,
} from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import { type PreparedPolicy, preparedPolicyFor } from "./prepared.ts";
import { readSettings } from "./settings.ts";
import { readFireSummary, readRecentActivity, terminalSafe } from "./panel.ts";
import { readPanelRequest, serializeFireSummary, serializeSnapshot, type PolicyPanelAnswer, type PolicyPanelRequest } from "./panel-protocol.ts";
import {
	type EvaluationContext,
	createEvaluationFrame,
	evaluatePrograms,
	type InputPlan,
	observationSelected,
	planInput,
	type ProgramEvaluation,
	type ProgramRule,
	programSteps,
	captureProgramEvidence,
} from "./program.ts";
import {
	boundedRows,
	markUnavailable,
	metadata,
	publicState,
	relevantEvaluations,
	refusalText,
	samePin,
	telemetryDecisionRows,
} from "./runtime.ts";
import {
	GUIDANCE_HISTORY_LIMITS,
	type GuidanceRecord,
	type GuidanceSource,
	type GuidanceStatus,
	guidanceHistory,
	guidanceText,
	parseGuidanceRecord,
	planGuidance,
	type PreparedGuidanceSelection,
	prepareGuidanceSelection,
} from "./guidance-history.ts";
import {
	type CallEffects,
	type CallOutcome,
	type ContentLike,
	finishCall,
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
	type RuleMatchContext,
} from "./rule.ts";
import { SHELL_CARD_BYTES, shellContractCard } from "./shell-card.ts";
import { ObservationState, type StatePin, type StateView } from "./state.ts";
import { createObservationClock } from "./observation-clock.ts";
import { PolicyWriter } from "./store.ts";
import type { AppendTelemetry, TelemetryHealth, TelemetryRetention } from "./telemetry-files.ts";
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
	prepareDataCommand,
	submitProposal,
	type ToolDeps,
	validateInspectionParams,
	validateProposal,
} from "./tools.ts";

const MAX_CATALOG_TOOLS = 1024;
const MAX_MEMO_INPUT_BYTES = 16 * 1024;
const COMPLETED_CALLS = 512;
const PROJECTION_MODES: readonly PolicyMode[] = ["annotate", "enforce"];

/** Host diagnostics establish rejection or uncertain execution, not a completed tool attempt. */
export function durableResultDisposition(result: Durable.ToolExecutionResult): {
	outcome: CallOutcome;
	executed: boolean | "unknown";
	diagnostic?: string;
} {
	for (const { code } of result.diagnostics ?? []) {
		switch (code) {
			case "tool_unavailable":
			case "abandoned":
				return { outcome: "unexecuted", executed: false, diagnostic: code };
			case "invalid_arguments":
				return { outcome: "invalid", executed: false, diagnostic: code };
			case "blocked":
				return { outcome: "denied", executed: false, diagnostic: code };
			case "aborted":
				return { outcome: "aborted", executed: "unknown", diagnostic: code };
			case "interrupted":
			case "restart_limit":
				return { outcome: "incomplete", executed: "unknown", diagnostic: code };
		}
	}
	return { outcome: result.isError === true ? "execution-error" : "success", executed: true };
}

/** One Durable contribution emitted by the ordinary factory. */
export interface PolicyDurableContribution {
	readonly name: string;
	readonly source: string;
	/** Pure presentation module a client can load without starting this contribution. */
	readonly display?: { readonly version: 1; readonly entry: string; readonly export: string };
	/** The panel module for the attached terminal and the command that serves it; see docs/conventions/operator-panels.md. */
	readonly panel?: { readonly version: 1; readonly entry: string; readonly export: "operatorPanel"; readonly command: string };
	readonly commands?: readonly PolicyDurableCommand[];
	readonly create: (host: PolicyDurableHost) => Durable.Extension | Promise<Durable.Extension>;
}

export interface PolicyDurableCommand {
	readonly name: string;
	readonly description: string;
	run(call: PolicyDurableCommandCall): Promise<string | { text: string; data?: JsonValue }>;
}

/** One command invocation as the agent host dispatches it; this slice reads these members. */
export interface PolicyDurableCommandCall {
	readonly args: string;
	readonly data?: JsonValue;
	readonly origin?: "operator" | "model";
	readonly conversation: Durable.Conversation;
	readonly context: Context;
	readonly host: PolicyDurableHost;
	readonly invocationId: string;
}

/** Runtimes created by `createPolicyDurableExtension`, keyed by host, for the panel command. */
const runtimes = new WeakMap<PolicyDurableHost, DurablePolicyRuntime>();

export const POLICY_COMMAND_DESCRIPTION = "Policy registry summary as text; the attached panel sends structured reads, approvals, and controls";

/** The panel command: text callers get a bounded summary, the attached panel its structured route. */
export const policyPanelCommand: PolicyDurableCommand = {
	name: "policy",
	description: POLICY_COMMAND_DESCRIPTION,
	async run(call) {
		const runtime = runtimes.get(call.host);
		if (!runtime) throw new Error("The policy Durable extension is not installed for this host.");
		if (call.data === undefined) return runtime.summaryText();
		const request = readPanelRequest(call.data);
		const answer = await runtime.panelRequest(request, call.conversation, call.context);
		return { text: panelAnswerText(request, answer), data: JSON.parse(JSON.stringify(answer)) as JsonValue };
	},
};

/** The bounded text a panel answer gives a caller that reads only text. */
function panelAnswerText(request: PolicyPanelRequest, answer: PolicyPanelAnswer): string {
	if ("outcome" in answer) return answer.outcome;
	if ("review" in answer) return `${answer.review.title}: review the complete artifact; nothing changed`;
	if (answer.op === "inspect") return `inspected ${"view" in request ? request.view : ""}`;
	if (answer.op === "reset-revision") return `reset revision ${answer.revision}`;
	return `${answer.snapshot.records.length} rules, ${answer.snapshot.pending.length} pending proposals`;
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

/** The agent session host supplies these values; this slice reads only `durable`, `harness`, and `agentDir`. */
export interface PolicyDurableHost {
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	/** The host's open Harness. Hook state writes go through it, keyed by task or call identity. */
	readonly harness: Durable.Harness;
	readonly signal: AbortSignal;
	/** Register final work; the host runs registered functions in reverse order at shutdown. */
	readonly onClose: (dispose: () => void | Promise<void>) => void;
	readonly inventory: PolicyDurableInventory;
}

/**
 * Result effect of one completed tool task, recorded so a rerun of that task replays it unchanged. `task` is the
 * Durable tool task; `callId` is the provider's label for the call and only describes it, since providers reuse it.
 */
type StoredCompletedCall = { task: number; callId?: string; guidance?: string; correction?: boolean };
type StoredRetainedGuidance = {
	id: string;
	revision: string;
	generation: number;
	evaluation: JsonValue;
};
type PolicyStateValue = Durable.JsonObject & {
	identity: string;
	generation: number;
	turn: number;
	observation: JsonValue;
	retainedGuidance: JsonValue[];
	completedCalls: JsonValue[];
	incomplete: number;
	stale: number;
	shellCard: string | null;
};

/** Conversation-scoped guidance ledger. Latest history, current fork, no automatic checkpoints. */
type GuidanceDocValue = Durable.JsonObject & {
	epoch: string;
	status: GuidanceStatus;
	noticeEpoch: string | null;
	records: JsonValue[];
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
	resultSeen: boolean | typeof UNKNOWN;
	abortRequested?: boolean;
	preGuidanceBytes?: number;
	outputBytes?: number;
	decision?: string;
}

/** The read, agent, and commit surface shared by tool executions and task hooks. */
interface PolicySurface {
	readonly conversationId: Durable.ConversationId;
	agent(context: Context): Promise<Durable.Agent>;
	snapshot<T extends Durable.JsonObject>(
		token: Durable.ConversationDocToken<T>,
		conversationId: Durable.ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	commit<T>(change: (tx: Durable.Tx) => T | Promise<T>, context: Context): Promise<T>;
}

const toolScope = (scope: RuleMatchContext, model: Durable.Agent["model"]): PolicyToolScope => ({
	cwd: scope.cwd,
	model: model ? { provider: model.provider, id: model.modelId } : null,
});

function gatherConditionNames(condition: ProgramRule["program"]["when"], names: Set<string>): void {
	if ("all" in condition) for (const child of condition.all) gatherConditionNames(child, names);
	else if ("any" in condition) for (const child of condition.any) gatherConditionNames(child, names);
	else if ("not" in condition) gatherConditionNames(condition.not, names);
	else if (condition.path[0] === "context" && condition.path[1] === "tools" && condition.path[2])
		names.add(condition.path[2]);
}

function collectProgramNames(policy: PreparedPolicy, names: Set<string>): boolean {
	for (const record of policy.records.values()) {
		if (effectiveState(record) !== "active") continue;
		const compiled = policy.compiled.get(record.id);
		if (!compiled) continue;
		const spec = compiled.program;
		if (compiled.applicability) gatherConditionNames(compiled.applicability, names);
		gatherConditionNames(spec.when, names);
		if (spec.state) {
			gatherConditionNames(spec.state.observe, names);
			if (spec.state.resetWhen) gatherConditionNames(spec.state.resetWhen, names);
		}
		if (names.size > MAX_CATALOG_TOOLS) return false;
	}
	return true;
}

/**
 * Build the native extension for one host. Runtime values come from
 * `host.durable`; the package is imported for types only. The policy store
 * directory and mode use the local settings reader with the host's agent
 * directory. Ordinary session flags do not apply.
 */
export interface PolicyDurableOptions {
	/** Replace the telemetry persistence boundary that receives queued records. */
	readonly append?: AppendTelemetry;
}

export async function createPolicyDurableExtension(
	host: PolicyDurableHost,
	options: PolicyDurableOptions = {},
): Promise<Durable.Extension> {
	const { defineDoc, defineExtension, defineTool, hook, section, GenerationTask, ToolTask } = host.durable;
	const configured = readSettings({ agentDir: host.agentDir });
	const dir = configured.values.dir;
	const retention: TelemetryRetention = {
		maxBytes: configured.values.telemetryMaxBytes,
		maxAgeDays: configured.values.telemetryMaxAgeDays,
	};
	for (const diagnostic of configured.diagnostics) {
		console.warn(`[policy] ${diagnostic.field} (${diagnostic.source}): ${diagnostic.message}`);
	}
	const registry = new RuleRegistry(dir, {
		onNotice(message) {
			try {
				console.warn(terminalSafe(`[policy] ${message}`));
			} catch {
				/* Reporting has no policy authority. */
			}
		},
	});
	const StateDoc = defineDoc<PolicyStateValue>({
		kind: "policy.state",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		checkpointWhen: () => false,
		initial: initialPolicyStateValue,
	});
	const GuidanceDoc = defineDoc<GuidanceDocValue>({
		kind: "policy.guidance",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		checkpointWhen: () => false,
		initial: initialGuidanceDocValue,
	});
	const loaded = await registry.snapshot();
	const loadedPolicy = preparedPolicyFor(loaded);
	const wrappedTools = new Set([...loadedPolicy.compiled.values()].flatMap((program) => {
		return program.program.action.kind === "require-approval" ? program.program.selector?.tools ?? [] : [];
	}));
	const runtime = new DurablePolicyRuntime({
		wrappedTools,
		dir,
		registry,
		harness: host.harness,
		storageId: host.storageId,
		cwd: host.cwd,
		mode: configured.values.mode,
		stateDoc: StateDoc,
		guidanceDoc: GuidanceDoc,
		retention,
		append: options.append,
	});
	host.onClose(() => runtime.closeTelemetry());
	runtimes.set(host, runtime);

	const rulesTool = defineTool({
		name: "policy_rules",
		description: POLICY_RULES_DESCRIPTION,
		parameters: PolicyRulesParams,
		deferred: true,
		replay: "safe",
		execute: (args, api, context) => runtime.executeRules(args, api, context),
		structuredOutputSchema: obj({
			rules: num(),
			pending: num(),
			ruleStoreDegraded: bool(),
			ruleStorePath: str(),
		}, { open: true }),
	});
	const proposeTool = defineTool({
		name: "policy_propose",
		description: POLICY_PROPOSE_DESCRIPTION,
		parameters: PolicyProposeParams,
		deferred: true,
		replay: "unsafe",
		execute: (args, api, context) => runtime.executePropose(args, api, context),
		structuredOutputSchema: obj({
			proposalId: str(),
			proposalRevision: str(),
			state: lit("pending"),
			operation: str(),
			ruleId: str(),
		}, { open: true }),
	});
	const approveTool = defineTool({
		name: "policy_approve",
		description: POLICY_APPROVE_DESCRIPTION,
		parameters: PolicyApproveParams,
		deferred: true,
		replay: "unsafe",
		execute: (args, api, context) => runtime.executeApprove(args, api, context),
		structuredOutputSchema: obj({
			proposalId: str(),
			proposalRevision: str(),
			decision: lit("approved"),
			operation: str(),
			ruleId: str(),
			ruleRevision: str(),
			state: str(),
			effect: str(),
			matcherAvailable: bool(),
			staleOverride: bool(),
			scope: str(),
			mode: str(),
			registryHealth: str(),
			boundary: str(),
		}, { open: true }),
	});
	const controlTool = defineTool({
		name: "policy_control",
		description: POLICY_CONTROL_DESCRIPTION,
		parameters: PolicyControlParams,
		deferred: true,
		replay: "unsafe",
		execute: (args, api, context) => runtime.executeControl(args, api, context),
		structuredOutputSchema: ({ type: "object", patternProperties: { "^.*$": {} } } as Schema<Record<string, unknown>>),
	});

	return defineExtension({
		name: "policy",
		tools: [rulesTool, proposeTool, approveTool, controlTool],
		wraps: [...wrappedTools].map((tool) => ({ tool, wrap: (registration: Durable.ToolRegistration) => runtime.wrapActionTool(registration) })),
		sections: [
			section(
				"policy",
				() =>
					"Policy tools govern operator-approved rules for this conversation. Inspect with policy_rules before authoring, and use view=authoring then view=check before proposing. policy_propose records an inert proposal; it is never approval. policy_approve activates one proposal only under a clear operator decision carried in the conversation, and your own inference, a recommendation, or a quoted third party is not approval. policy_control carries contextual operator decisions to revision-checked controls; resolve the exact target and revision from inspection first, and report the returned state and mode instead of presumed enforcement. Approved input rules can deny or correct tool calls, result rules can mark or annotate results, and context rules can add guidance to a request.",
			),
			section("policy_shell", (input, context) => runtime.shellCard(input, context)),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: runtime.beforeToolHook,
				afterTool: (call, result, api, context) => runtime.afterTool(call, result, api, context),
			}),
			hook(GenerationTask, {
				beforeRequest: (request, api, context) => runtime.beforeRequest(request, api, context),
			}),
		],
	});
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
		return ownInput(source);
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
		identity: randomUUID(),
		generation: 0,
		turn: 0,
		observation: initialObservationValue(),
		retainedGuidance: [],
		completedCalls: [],
		incomplete: 0,
		stale: 0,
		shellCard: null,
	};
}

function initialGuidanceDocValue(): GuidanceDocValue {
	return { epoch: "", status: "ok", noticeEpoch: null, records: [] };
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
	return entry !== undefined && typeof entry.task === "number" && Number.isSafeInteger(entry.task);
}

function normalizePolicyState(raw: Readonly<PolicyStateValue> | undefined): PolicyStateValue {
	if (!raw) return initialPolicyStateValue();
	const value = raw as Partial<PolicyStateValue>;
	return {
		identity: typeof value.identity === "string" && value.identity.length > 0 ? value.identity : randomUUID(),
		generation: safeInteger(value.generation) ?? 0,
		turn: safeInteger(value.turn) ?? 0,
		observation: value.observation ?? initialObservationValue(),
		retainedGuidance: Array.isArray(value.retainedGuidance) ? value.retainedGuidance.filter(isStoredGuidance) : [],
		completedCalls: Array.isArray(value.completedCalls)
			? value.completedCalls.filter(isStoredCompleted).slice(-COMPLETED_CALLS)
			: [],
		incomplete: safeInteger(value.incomplete) ?? 0,
		stale: safeInteger(value.stale) ?? 0,
		shellCard: typeof value.shellCard === "string" && Buffer.byteLength(value.shellCard, "utf8") <= SHELL_CARD_BYTES ? value.shellCard : null,
	};
}

/** Repair one state draft in place so one corrupt field cannot poison an update. */
function repairState(state: PolicyStateValue): PolicyStateValue {
	const normalized = normalizePolicyState(state);
	state.identity = normalized.identity;
	state.generation = normalized.generation;
	state.turn = normalized.turn;
	state.observation = normalized.observation;
	state.retainedGuidance = normalized.retainedGuidance;
	state.completedCalls = normalized.completedCalls;
	state.incomplete = normalized.incomplete;
	state.stale = normalized.stale;
	state.shellCard = normalized.shellCard;
	return state;
}

const GUIDANCE_STATUSES: readonly GuidanceStatus[] = ["capacity", "anchor-mismatch", "persistence-failed"];

function boundedString(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function normalizeGuidanceDoc(raw: Readonly<GuidanceDocValue> | undefined): GuidanceDocValue {
	if (!raw) return initialGuidanceDocValue();
	const value = raw as Partial<GuidanceDocValue>;
	const parsed = Array.isArray(value.records) ? value.records.map(parseGuidanceRecord) : [];
	const records = parsed.filter((record): record is GuidanceRecord => record !== undefined);
	return {
		epoch: boundedString(value.epoch) ?? "",
		status: GUIDANCE_STATUSES.find((status) => status === value.status) ?? "ok",
		noticeEpoch: boundedString(value.noticeEpoch) ?? null,
		records: records.slice(0, GUIDANCE_HISTORY_LIMITS.records) as unknown as JsonValue[],
	};
}

/** Repair one guidance draft in place so one corrupt record cannot hide the rest. */
function repairGuidance(doc: GuidanceDocValue): GuidanceDocValue {
	const normalized = normalizeGuidanceDoc(doc);
	doc.epoch = normalized.epoch;
	doc.status = normalized.status;
	doc.noticeEpoch = normalized.noticeEpoch;
	doc.records = normalized.records;
	return doc;
}

interface RequestInput {
	epoch: string;
	sources: readonly GuidanceSource[];
	messages: readonly Message[];
	snapshot: RuleSnapshot;
	agent: Durable.Agent;
	scope: RuleMatchContext;
	rules: ProgramRule[];
	installed: readonly string[];
	mode: PolicyMode;
	turn: number;
	now: number;
}

/**
 * The context boundary of a conversation: its head marker plus the newest entry
 * whose edits reach an active entry. Appending messages changes neither.
 */
function guidanceEpochOf(conversationId: Durable.ConversationId, view: Durable.ContextView): string {
	let edited: Durable.EntryId | undefined;
	let active: Set<Durable.EntryId> | undefined;
	for (let index = view.entries.length - 1; index >= 0 && edited === undefined; index--) {
		const entry = view.entries[index];
		if (!entry?.edits?.length) continue;
		active ??= new Set<Durable.EntryId>(view.entries.map((candidate) => candidate.id));
		if (entry.edits.some((edit) => active?.has(edit.target))) edited = entry.id;
	}
	return `${conversationId}:${view.head?.id ?? "root"}:${edited ?? "none"}`;
}

/** Model-visible contributions of the active context, by entry and contribution index. */
function guidanceSourcesOf(view: Durable.ContextView): GuidanceSource[] {
	const sources: GuidanceSource[] = [];
	view.entries.forEach((entry, index) => {
		const contributions = view.contributions[index] ?? [];
		for (let contribution = 0; contribution < contributions.length; contribution++)
			sources.push({ entryId: String(entry.id), contribution, message: contributions[contribution] });
	});
	return sources;
}

interface DurablePolicyRuntimeOptions {
	wrappedTools: ReadonlySet<string>;
	dir: string;
	registry: RuleRegistry;
	harness: Durable.Harness;
	storageId: string;
	cwd: string;
	mode: PolicyMode;
	stateDoc: Durable.ConversationDocToken<PolicyStateValue>;
	guidanceDoc: Durable.ConversationDocToken<GuidanceDocValue>;
	retention: TelemetryRetention;
	append?: AppendTelemetry;
}

class DurablePolicyRuntime {
	private readonly actions = new ActionApprovals();
	private readonly wrappedTools: ReadonlySet<string>;
	readonly beforeToolHook: Durable.ToolHooks["beforeTool"] = (call, api, context) => this.beforeTool(call, api, context);
	private readonly dir: string;
	private readonly registry: RuleRegistry;
	private readonly harness: Durable.Harness;
	private readonly storageId: string;
	private readonly cwd: string;
	private readonly mode: PolicyMode;
	private readonly stateDoc: Durable.ConversationDocToken<PolicyStateValue>;
	private readonly guidanceDoc: Durable.ConversationDocToken<GuidanceDocValue>;
	private readonly writer: PolicyWriter;
	private readonly observationClock = createObservationClock();
	private stateTail: Promise<unknown> = Promise.resolve();

	constructor(options: DurablePolicyRuntimeOptions) {
		this.wrappedTools = options.wrappedTools;
		this.dir = options.dir;
		this.registry = options.registry;
		this.harness = options.harness;
		this.storageId = options.storageId;
		this.cwd = options.cwd;
		this.mode = options.mode;
		this.stateDoc = options.stateDoc;
		this.guidanceDoc = options.guidanceDoc;
		this.writer = new PolicyWriter(
			options.dir,
			(health) => this.recordingChanged(health),
			options.append,
			options.retention,
		);
	}

	private recordingChanged(health: TelemetryHealth): void {
		try {
			console.warn(health.state === "failed"
				? `[policy] telemetry persistence stopped: ${health.reason}`
				: `[policy] telemetry ${health.state}; lost ${health.lostRecords} records, ${health.lostBytes} bytes`);
		} catch {
			/* Failure reporting must not create an unhandled rejection. */
		}
	}

	/** Stop telemetry admission and wait for the last accepted batch. */
	async closeTelemetry(): Promise<void> {
		await this.writer.close();
	}

	private actionBinding(conversationId: Durable.ConversationId, snapshot: RuleSnapshot, agent: Durable.Agent, scope: RuleMatchContext): ActionBinding {
		return { session: this.sessionLabel(conversationId), scope: { cwd: scope.cwd, provider: scope.provider ?? null, model: scope.model ?? null },
			authority: actionAuthority(snapshot, [...agent.tools, ...agent.callable]), mode: this.effectiveMode(snapshot) };
	}
	private actionSafety(agent: Durable.Agent, name: string, args: Record<string, unknown>): string | undefined {
		const tool = [...agent.tools, ...agent.callable].find((entry) => entry.name === name);
		if (!tool) return "[policy] Exact-action tool registration is unavailable.";
		if (tool.replay === "safe") return "[policy] Exact-action approval refuses replay:safe tools; external writes require unsafe replay.";
		try {
			// The caller's sameActionInput check already established complete strict JSON.
			const final = validateToolArguments(tool, { type: "toolCall", id: "policy-normalization", name, arguments: args as ToolCall["arguments"] });
			if (!sameActionInput(args, final)) return "[policy] Host validation changes the final candidate; retry with exact normalized arguments.";
		} catch { return "[policy] Final host validation is unavailable or rejects the exact candidate."; }
		return undefined;
	}
	private async actionControl(params: ActionControl, surface: PolicySurface, context: Context): Promise<unknown> {
		const { snapshot, agent, scope } = await this.activeRules(surface, context);
		const binding = this.actionBinding(surface.conversationId, snapshot, agent, scope);
		return this.actions.control(params, binding);
	}
	private uncoveredApproval(plan: InputPlan, name: string, rules: readonly ProgramRule[]): boolean {
		if (!this.wrappedTools.has(name)) return true;
		return plan.evaluations.filter((entry) => entry.action.kind === "require-approval" && entry.deny)
			.some((entry) => !rules.find((rule) => rule.id === entry.id)?.program.selector?.tools?.includes(name));
	}
	private finalActionReason(plan: InputPlan, observed: ObservedCall, memo: PolicyCallMemo | undefined, agent: Durable.Agent, binding: ActionBinding): string | undefined {
		if (!observed.input || !sameActionInput(observed.input, plan.candidate))
			return "[policy] Final execution input is unavailable or needs a correction; retry the exact final payload.";
		const gatedBefore = memo?.inputEvaluations.some((entry) => objectValue(entry)?.action === "require-approval" && objectValue(entry)?.truth === true);
		const gatedNow = plan.evaluations.some((entry) => entry.action.kind === "require-approval" && entry.deny);
		if (gatedBefore && !gatedNow) return "[policy] The approval gate changed after preflight; retry and inspect the current action.";
		if (gatedNow) {
			if (this.uncoveredApproval(plan, observed.tool, observed.rules)) return "[policy] Native approval requires loaded wrappers and explicit selector.tools for every gate; reload policy after a new exact-tool rule.";
			const reason = this.actionSafety(agent, observed.tool, plan.candidate) ?? this.actions.gate(plan, observed.tool, binding);
			if (reason) return reason;
		}
		return plan.denied || !plan.valid ? "[policy] Final approved input checks refused this action." : undefined;
	}
	wrapActionTool(tool: Durable.ToolRegistration): Durable.ToolRegistration {
		return { ...tool, execute: async (args, api, context) => {
			const surface = this.toolSurface(api);
			const agent = await api.agent(context);
			const turn = await this.turnOf(api.conversationId, context);
			const base = await this.readState(surface, context, (state) => ({ state, observation: this.observationOf(state) }));
			const memo = await api.memo<PolicyCallMemo>("policy.call", context);
			// The final rule read is the admission boundary; no await separates it from consumption.
			const snapshot = await this.snapshot();
			const { scope, rules, installed } = this.selectedRules(snapshot, agent);
			if (this.effectiveMode(snapshot) !== "enforce") return tool.execute(args, api, context);
			const now = Date.now();
			base.observation.sync(rules, now);
			const observed = this.makeObservedCall(tool.name, api.callId, args, rules, snapshot, agent, scope, base.observation, turn, now, api.conversationId, installed);
			observed.generation = base.state.generation;
			const plan = this.inputPlan(observed, base.observation, now, true);
			const reason = this.finalActionReason(plan, observed, memo, agent, this.actionBinding(api.conversationId, snapshot, agent, scope));
			if (reason) return { isError: true, output: [{ type: "text", text: reason }] };
			return tool.execute(plan.candidate as Durable.JsonObject, api, context);
		} };
	}
	getMode(): PolicyMode {
		return this.mode;
	}

	private async snapshot(): Promise<RuleSnapshot> {
		try {
			const snapshot = await this.registry.snapshot();
			if (this.effectiveMode(snapshot) !== "enforce") this.actions.clear();
			return snapshot;
		} catch (error) { this.actions.clear(); throw error; }
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
		work: (state: PolicyStateValue, guidance: GuidanceDocValue) => T | Promise<T>,
	): Promise<T> {
		const run = this.stateTail.then(async () => {
			let result!: T;
			await surface.commit(async (tx) => {
				const draft = await tx.doc(this.stateDoc, surface.conversationId);
				const guidanceDraft = await tx.doc(this.guidanceDoc, surface.conversationId);
				result = await work(repairState(draft), repairGuidance(guidanceDraft));
			}, context);
			return result;
		});
		this.stateTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Run one read of both conversation documents on the serialized state tail. */
	private readStateAndGuidance<T>(
		surface: PolicySurface,
		context: Context,
		work: (state: PolicyStateValue, guidance: GuidanceDocValue) => T | Promise<T>,
	): Promise<T> {
		const run = this.stateTail.then(async () => {
			const raw = await surface.snapshot(this.stateDoc, surface.conversationId, context);
			const guidance = await surface.snapshot(this.guidanceDoc, surface.conversationId, context);
			return work(normalizePolicyState(raw), normalizeGuidanceDoc(guidance));
		});
		this.stateTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private observationOf(state: PolicyStateValue): ObservationState {
		return ObservationState.fromJSON(state.observation, this.observationClock) ?? new ObservationState(this.observationClock);
	}

	private retainedGuidanceOf(state: PolicyStateValue): StoredRetainedGuidance[] {
		return Array.isArray(state.retainedGuidance) ? state.retainedGuidance.filter(isStoredGuidance) : [];
	}

	private completedCallsOf(state: PolicyStateValue): StoredCompletedCall[] {
		return Array.isArray(state.completedCalls) ? state.completedCalls.filter(isStoredCompleted) : [];
	}

	private guidanceRecordsOf(doc: GuidanceDocValue): GuidanceRecord[] {
		const records: GuidanceRecord[] = [];
		if (Array.isArray(doc.records))
			for (const entry of doc.records) {
				const record = parseGuidanceRecord(entry);
				if (record) records.push(record);
				if (records.length >= GUIDANCE_HISTORY_LIMITS.records) break;
			}
		return records;
	}

	/** Public-surface adapter for hooks: reads and memos from HookApi, writes and agent from the host Harness. */
	private hookSurface(api: Durable.HookApi): PolicySurface {
		return {
			conversationId: api.conversationId,
			agent: (context) => this.resolvedAgent(api.conversationId, context),
			snapshot: (token, conversationId, context) => api.snapshot(token, conversationId, context),
			commit: (change, context) => this.harness.commit(change, context),
		};
	}

	/** Public-surface adapter for tool executions: every member is declared on ToolExecutionApi. */
	private toolSurface(api: Durable.ToolExecutionApi): PolicySurface {
		return {
			conversationId: api.conversationId,
			agent: (context) => api.agent(context),
			snapshot: (token, conversationId, context) => api.snapshot(token, conversationId, context),
			commit: (change, context) => api.commit(change, context),
		};
	}

	private async resolvedAgent(conversationId: Durable.ConversationId, context: Context): Promise<Durable.Agent> {
		const conversation = await this.harness.conversation(conversationId, context);
		if (!conversation) throw new Error(`Policy cannot resolve conversation ${conversationId}`);
		return conversation.agent(context);
	}

	private async conversationView(
		conversationId: Durable.ConversationId,
		context: Context,
	): Promise<Durable.ContextView> {
		const conversation = await this.harness.conversation(conversationId, context);
		if (!conversation) throw new Error(`Policy cannot resolve conversation ${conversationId}`);
		return conversation.context(context);
	}

	private async pendingCount(conversationId: Durable.ConversationId, context: Context): Promise<number> {
		const inspection = await this.harness.inspect(context);
		return inspection.tasks.filter(
			(task) => task.record.kind === "pi.tool" && task.record.conversationId === conversationId,
		).length;
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
		return { snapshot, agent, ...this.selectedRules(snapshot, agent) };
	}
	private selectedRules(snapshot: RuleSnapshot, agent: Durable.Agent): { scope: RuleMatchContext; rules: ProgramRule[]; installed: string[] } {
		const installed = [
			...new Set(agent.extensions.flatMap((extension) => extension.tools?.map((tool) => tool.name) ?? [])),
		];
		const model = agent.model;
		const scope: RuleMatchContext = {
			provider: model?.provider,
			model: model ? `${model.provider}/${model.modelId}` : undefined,
			cwd: agent.cwd ?? this.cwd,
		};
		const policy = preparedPolicyFor(snapshot);
		const rules = [...policy.records.values()]
			.filter(
				(record) =>
					effectiveState(record) === "active" &&
					record.matcherAvailable &&
					ruleScopeMatches(record.definition.scope, scope),
			)
			.flatMap((record) => {
				const compiled = policy.compiled.get(record.id);
				return compiled ? [compiled] : [];
			});
		return { scope, rules, installed };
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
		const policy = preparedPolicyFor(snapshot);
		if (!collectProgramNames(policy, names)) return { turn, catalogAvailable: false, tools: UNKNOWN };
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
		const policy = preparedPolicyFor(snapshot);
		const schema = [...agent.tools, ...agent.callable].find((entry) => entry.name === tool)?.parameters;
		return {
			tool,
			facts: { input, context: this.publicContext(snapshot, agent, turn, installed) },
			states: this.statesOf(state, now, turn),
			schema,
			preparedSchema: prepareSchema(schema),
			schemaTruth: new Map(),
			namedData: policy.data,
			data: policy.data.snapshot(now),
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
		const data = call.context.namedData
			? call.context.namedData.snapshot(now)
			: snapshotData(Object.values(call.context.data ?? {}).flatMap((source) => (source.data ? [source.data] : [])), now);
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
		const input = isOwnedInput(args) ? args : inputSnapshot(args);
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

	private memoFor(call: ObservedCall): PolicyCallMemo {
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
			corrections: call.corrections,
			inputEvaluations: call.inputEvaluations,
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
			pending: startCall(memo.tool, memo.callId, input ?? {}, new Date(memo.at), memo.startedAt, memo.captured),
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
		return refusalText(plan, preparedPolicyFor(snapshot).records, call.classes);
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

	/** The result-phase decision for one call: assert-error correction and eligible guidance. */
	private resultEffects(
		call: ObservedCall,
		observation: ObservationState,
		current: readonly ProgramRule[],
		mode: PolicyMode,
		result: PolicyResult,
		now: number,
	): { correction: boolean; effective: PolicyResult; semantic: ProgramEvaluation[]; guides: ProgramEvaluation[]; guidance?: string } {
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
		return { correction, effective, semantic, guides, guidance: this.selectGuidance(observation, guides, mode, now, call.turn) };
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
		const frame = createEvaluationFrame(context);
		const evaluations = evaluatePrograms(current, "completion", context, frame).filter(
			(evaluation) => evaluation.action.kind !== "guide",
		);
		let stale = 0;
		for (const rule of current) {
			const selected = observationSelected(rule, context, frame);
			const pin = call.pins.get(rule.id);
			if (pin && selected === true && !observation.complete(pin, frame.factsFor(rule), call.turn, now))
				stale += 1;
		}
		const guides = evaluatePrograms(current, "completion", context, frame).filter(
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

	/** Run the result and completion phases and record one decision for this tool task. */
	private async completeCall(
		task: Durable.TaskId,
		call: ObservedCall,
		result: PolicyResult,
		outcome: CallOutcome,
		mode: PolicyMode,
		rules: ProgramRule[],
		truncated: boolean | undefined,
		incompleteObservation: boolean,
		surface: PolicySurface,
		context: Context,
		now: number,
	): Promise<{ guidance?: string; correction: boolean; record?: PolicyRecord }> {
		return this.withState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			const existing = this.completedCallsOf(state).find((entry) => entry.task === task);
			if (existing) return { guidance: existing.guidance, correction: existing.correction === true };
			const current = call.generation === state.generation ? this.currentRulesOf(call, observation) : [];
			state.stale += call.rules.length - current.length;
			if (incompleteObservation) state.incomplete += 1;
			const effects = this.resultEffects(call, observation, current, mode, result, now);
			if (effects.guidance) call.effects.annotationBytes = Buffer.byteLength(effects.guidance, "utf8");
			// The model receives the corrected result, so completion and telemetry observe it too. A host outcome
			// (aborted, interrupted, unexecuted) keeps its execution uncertainty; only an executed success becomes an error.
			const effectiveOutcome: CallOutcome = effects.correction && outcome === "success" ? "execution-error" : outcome;
			if (effects.correction) call.effects.policy = { ...call.effects.policy, resultCorrected: true };
			const completion = this.completionEffects(
				call,
				observation,
				current,
				this.contextFor(call, observation, now, effects.effective, effectiveOutcome),
				mode,
				now,
				state,
			);
			state.stale += completion.stale;
			const record = this.telemetryRecord(
				call,
				effects.effective,
				effectiveOutcome,
				mode,
				effects.semantic,
				effects.guides,
				completion.evaluations,
				completion.guides,
				now,
				truncated,
			);
			state.completedCalls = [
				...this.completedCallsOf(state).filter((entry) => entry.task !== task),
				{
					task,
					callId: call.callId,
					...(effects.guidance ? { guidance: effects.guidance } : {}),
					...(effects.correction ? { correction: true } : {}),
				},
			].slice(-COMPLETED_CALLS);
			state.observation = observation.toJSON() as unknown as JsonValue;
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
		const evaluations = [...call.inputEvaluations, ...metadata([...semantic, ...guides, ...completion, ...completionGuides])];
		const classes = [...new Set([...call.classes, ...evaluations.flatMap((value) => {
			const entry = value as { id: string; truth: unknown };
			return entry.truth === true ? [entry.id] : [];
		})])];
		const rows = {
			...telemetryDecisionRows(evaluations, [...call.pins.values()], classes, call.corrections),
			corrections: boundedRows(call.corrections),
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
					evaluations: { total: rows.evaluations.total, omitted: rows.evaluations.omitted, irrelevant: rows.evaluations.irrelevant },
					corrections: { total: rows.corrections.total, omitted: rows.corrections.omitted },
					generations: { total: rows.generations.total, omitted: rows.generations.omitted, irrelevant: rows.generations.irrelevant },
					dataSnapshots: { total: rows.dataSnapshots.total, omitted: rows.dataSnapshots.omitted },
					metadata: { total: rows.metadata.total, omitted: rows.metadata.omitted },
				},
			},
		};
		call.pending.classes = classes;
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

	/** Queue one record; persistence runs on the writer and never delays the tool call. */
	private writeTelemetry(record: PolicyRecord | undefined): void {
		if (record) this.writer.enqueue(record);
	}

	private preflightActionReason(plan: InputPlan, name: string, snapshot: RuleSnapshot, agent: Durable.Agent, scope: RuleMatchContext, conversationId: Durable.ConversationId): string | undefined {
		if (this.effectiveMode(snapshot) !== "enforce" || !plan.evaluations.some((entry) => entry.action.kind === "require-approval" && entry.deny)) return undefined;
		if (this.uncoveredApproval(plan, name, this.selectedRules(snapshot, agent).rules)) return "[policy] This native approval gate needs explicit selector.tools and a loaded exact-tool wrapper; reload policy before approval.";
		return this.actions.gate(plan, name, this.actionBinding(conversationId, snapshot, agent, scope), undefined, false);
	}
	async beforeTool(
		call: ToolCall,
		api: Durable.HookApi,
		context: Context,
	): Promise<{ block?: string; arguments?: Durable.JsonObject } | undefined> {
		const now = Date.now();
		const surface = this.hookSurface(api);
		const { snapshot, agent, scope, rules, installed } = await this.activeRules(surface, context);
		const turn = await this.turnOf(api.conversationId, context);
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
			api.conversationId,
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
			observed.classes = [
				...new Set([...observed.classes, ...unavailable.filter((entry) => entry.truth === true).map((entry) => entry.id)]),
			];
			if (mode === "enforce" && unavailable.some((entry) => entry.deny))
				reason = "[policy] An approved input check refused unavailable input.";
		}
		const plan = this.inputPlan(observed, base.observation, now, mode === "enforce");
		if (reason === undefined) reason = this.preflightActionReason(plan, call.name, snapshot, agent, scope, api.conversationId);
		if (reason === undefined && mode === "enforce" && (plan.denied || !plan.valid)) {
			observed.decision =
				this.refusalText(observed, plan, snapshot) ?? "[policy] The approved input checks refused this call.";
			reason = observed.decision;
		}
		if (reason !== undefined) observed.decision = reason;
		observed.inputEvaluations = metadata([...observed.evaluations, ...plan.evaluations]) as JsonValue[];
		observed.corrections = plan.corrections;
		await api.memo("policy.call", this.memoFor(observed), context);
		if (reason !== undefined) {
			observed.resultSeen = false;
			const update = await this.completeCall(
				api.taskId,
				observed,
				{ isError: true },
				"denied",
				mode,
				rules,
				undefined,
				false,
				surface,
				context,
				now,
			);
			this.writeTelemetry(update.record);
			return { block: update.guidance ? `${reason}\n${update.guidance}` : reason };
		}
		return this.checkedArguments(plan, mode, observed);
	}
	private checkedArguments(plan: InputPlan, mode: PolicyMode, observed: ObservedCall): { arguments: Durable.JsonObject } | undefined {
		if (mode !== "enforce" || !plan.valid || plan.denied) return undefined;
		if (!plan.changed && !plan.evaluations.some((entry) => entry.action.kind === "require-approval" && entry.truth === true)) return undefined;
		if (plan.changed) observed.effects.policy = { ...observed.effects.policy, inputCorrected: true };
		return { arguments: plan.candidate as Durable.JsonObject };
	}

	async afterTool(
		call: ToolCall,
		result: Durable.ToolExecutionResult,
		api: Durable.HookApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult | undefined> {
		const now = Date.now();
		const surface = this.hookSurface(api);
		const disposition = durableResultDisposition(result);
		const memo = await api.memo<PolicyCallMemo>("policy.call", context);
		const { snapshot, agent, scope, rules, installed } = await this.activeRules(surface, context);
		const turn = await this.turnOf(api.conversationId, context);
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
			api.conversationId,
			installed,
		);
		observed.generation = reading.state.generation;
		observed.resultSeen = disposition.executed === "unknown" ? UNKNOWN : disposition.executed;
		if (disposition.diagnostic) {
			observed.effects.policy = { ...observed.effects.policy, hostDiagnostic: disposition.diagnostic };
			if (disposition.executed === "unknown" || memo === undefined) observed.complete = false;
		}
		observed.abortRequested = disposition.outcome === "aborted" || context.abortSignal?.aborted === true;
		observed.preGuidanceBytes = textContentBytes(result.output);
		observed.outputBytes = observed.preGuidanceBytes;
		const details = objectValue(result.details);
		const truncation = objectValue(details?.truncation);
		const update = await this.completeCall(
			api.taskId,
			observed,
			{ ...result, content: result.output },
			disposition.outcome,
			this.effectiveMode(snapshot),
			rules,
			truncation?.truncated === true,
			memo === undefined,
			surface,
			context,
			now,
		);
		this.writeTelemetry(update.record);
		// A completed input refusal already included its recorded guidance in the block.
		if (disposition.diagnostic === "blocked" && memo?.decision !== undefined && update.record === undefined)
			return undefined;
		const guidance = update.guidance;
		if (!guidance && !update.correction) return undefined;
		const output = guidance
			? [...(result.output ?? []), { type: "text" as const, text: guidance }]
			: result.output;
		return {
			...result,
			...(update.correction ? { isError: true } : {}),
			...(output !== undefined ? { output } : {}),
		};
	}

	/** Freeze the initial shell snapshot so every request retains the same system section. */
	async shellCard(input: Durable.PromptInput, context: Context): Promise<string | undefined> {
		const surface: PolicySurface = {
			conversationId: input.conversationId,
			agent: async () => input.agent,
			snapshot: (token, conversationId, ctx) => input.read.snapshot(token, conversationId, ctx),
			commit: (change, ctx) => this.harness.commit(change, ctx),
		};
		return this.withState(surface, context, async (state) => {
			if (state.shellCard !== null) return state.shellCard || undefined;
			const { snapshot, agent, scope, installed } = await this.activeRules(surface, context);
			state.shellCard = PROJECTION_MODES.includes(this.effectiveMode(snapshot)) &&
				[...agent.tools, ...agent.callable].some((tool) => tool.name === "bash")
				? shellContractCard(snapshot.records.values(), scope, this.publicContext(snapshot, agent, 1, installed)) ?? ""
				: "";
			return state.shellCard || undefined;
		});
	}

	async beforeRequest(
		request: { readonly messages: readonly Message[] },
		api: Durable.HookApi,
		context: Context,
	): Promise<{ messages: readonly Message[] } | undefined> {
		const now = Date.now();
		const surface = this.hookSurface(api);
		const { snapshot, agent, scope, rules, installed } = await this.activeRules(surface, context);
		const view = await this.conversationView(api.conversationId, context);
		const turn = view.messages.filter((message) => message.role === "assistant").length + 1;
		const mode = this.effectiveMode(snapshot);
		const epoch = guidanceEpochOf(api.conversationId, view);
		const effect = await this.withState(surface, context, (state, guidance) =>
			this.requestEffect(state, guidance, {
				epoch,
				sources: guidanceSourcesOf(view),
				messages: request.messages,
				snapshot,
				agent,
				scope,
				rules,
				installed,
				mode,
				turn,
				now,
			}),
		);
		if (effect.notice)
			try {
				console.warn(terminalSafe(`[policy] ${effect.notice}`));
			} catch {
				/* Guidance health reporting does not change the request. */
			}
		return effect.messages ? { messages: effect.messages } : undefined;
	}

	/**
	 * One request's guidance projection. Record identity makes a repeated
	 * attempt at the same anchor idempotent; a new record is committed before
	 * its observation allowance is consumed.
	 */
	private requestEffect(
		state: PolicyStateValue,
		guidance: GuidanceDocValue,
		input: RequestInput,
	): { messages?: readonly Message[]; notice?: string } {
		const observation = this.observationOf(state);
		observation.sync(input.rules, input.now);
		state.turn = Math.max(state.turn, input.turn);
		const projected = this.projectRequest(state, guidance, observation, input);
		state.observation = observation.toJSON() as unknown as JsonValue;
		return projected;
	}

	/** Selected guidance text for context programs and retained notices, without consuming allowance. */
	private selectRequestGuidance(
		state: PolicyStateValue,
		observation: ObservationState,
		input: RequestInput,
	): PreparedGuidanceSelection | undefined {
		const { snapshot, agent, scope, rules, installed, mode, turn, now } = input;
		const retained = this.validRetained(state, observation, rules);
		state.retainedGuidance = retained;
		const policy = preparedPolicyFor(snapshot);
		const contextPrograms = evaluatePrograms(rules, "context", {
			tool: "",
			facts: { context: this.publicContext(snapshot, agent, turn, installed) },
			states: this.statesOf(observation, now, turn),
			namedData: policy.data,
			data: policy.data.snapshot(now),
			now,
			mode,
			scope,
		});
		return prepareGuidanceSelection(
			[...retained.map((entry) => entry.evaluation as unknown as ProgramEvaluation), ...contextPrograms],
			observation,
			now,
			turn,
		);
	}

	/** Context rules and retained guidance for one request. */
	private projectRequest(
		state: PolicyStateValue,
		guidance: GuidanceDocValue,
		observation: ObservationState,
		input: RequestInput,
	): { messages?: readonly Message[]; notice?: string } {
		const { epoch, sources, messages, mode, turn, now } = input;
		const plan = planGuidance<Message>(
			messages,
			sources,
			guidanceHistory(this.guidanceRecordsOf(guidance)),
			{ epoch, validatedEpoch: guidance.epoch || undefined },
			PROJECTION_MODES.includes(mode) ? () => this.selectRequestGuidance(state, observation, input) : undefined,
			now,
		);
		let { history, messages: projected } = plan;
		if (plan.addition) {
			for (const id of plan.addition.prepared.ids)
				if (observation.project(id, now, turn))
					state.retainedGuidance = this.retainedGuidanceOf(state).filter((entry) => entry.id !== id);
			({ history, messages: projected } = plan.addition);
		}
		guidance.epoch = epoch;
		guidance.status = plan.status;
		guidance.records = history.records as unknown as JsonValue[];
		const notice = plan.status !== "ok" && guidance.noticeEpoch !== epoch ? this.guidanceNotice(plan.status) : undefined;
		if (notice !== undefined) guidance.noticeEpoch = epoch;
		return {
			...(projected.length !== messages.length ? { messages: projected as readonly Message[] } : {}),
			...(notice !== undefined ? { notice } : {}),
		};
	}

	private guidanceNotice(status: GuidanceStatus): string {
		return status === "capacity"
			? "Guidance history is full; earlier guidance keeps its place and new context guidance is refused."
			: "Guidance history cannot place an earlier notice; new context guidance is paused.";
	}

	private validRetained(
		state: PolicyStateValue,
		observation: ObservationState,
		rules: readonly ProgramRule[],
	): StoredRetainedGuidance[] {
		return this.retainedGuidanceOf(state).filter((entry) => {
			const rule = rules.find((candidate) => candidate.id === entry.id);
			if (rule === undefined || rule.revision !== entry.revision) return false;
			return samePin(
				{ id: entry.id, revision: entry.revision, generation: entry.generation },
				observation.pin(entry.id),
			);
		});
	}

	private async turnOf(conversationId: Durable.ConversationId, context: Context): Promise<number> {
		const view = await this.conversationView(conversationId, context);
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
		const surface = this.toolSurface(api);
		const snapshot = await this.snapshot();
		const { agent, scope } = await this.activeRules(surface, context);
		const view = params.view ?? "rules";
		const output = await this.rulesOutput(params, view, snapshot, agent, scope, surface, context);
		const detail = {
			rules: snapshot.records.size,
			pending: snapshot.pending.length,
			ruleStoreDegraded: snapshot.health.status === "degraded",
			ruleStorePath: snapshot.health.path,
		};
		return {
			output: [{ type: "text", text: output }],
			structuredOutput: detail,
			details: detail,
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
					: ruleAbsenceMessage(snapshot.health, `No rule or pending proposal named ${params.id}.`);
			}
			return formatRulesTool(snapshot, toolScope(scope, agent.model));
		}
		if (view === "authoring") return authoringGuide();
		if (view === "check") {
			const draftContext: DraftCheckContext = toolScope(scope, agent.model);
			const catalog = {
				getAllTools: () => [...agent.tools, ...agent.callable].map((tool) => ({ name: tool.name, parameters: tool.parameters })),
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
		if (context.abortSignal?.aborted) throw new PolicyMutationCancelledError();
		validateProposal(params);
		const surface = this.toolSurface(api);
		await this.snapshot();
		const { agent } = await this.activeRules(surface, context);
		const auditValue: AgentRuleAudit = makeRuleAudit(this.auditContext(surface.conversationId, agent), "agent-tool");
		const event = await submitProposal(this.registry, params, auditValue, context.abortSignal);
		await this.snapshot();
		const revision = proposalRevision(event);
		const detail = {
			proposalId: event.id,
			proposalRevision: revision,
			state: "pending" as const,
			operation: event.operation,
			ruleId: event.ruleId,
		};
		return {
			output: [
				{
					type: "text",
					text: `Pending proposal ${event.id}: ${event.operation} ${event.ruleId}. Revision: ${revision}. It is inert until operator approval. After clear contextual approval, use policy_approve with this proposal ID, revision, and authorized effect. The operator need not type identifiers or a command.`,
				},
			],
			structuredOutput: detail,
			details: detail,
		};
	}

	async executeApprove(
		params: Static<typeof PolicyApproveParams>,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult> {
		if (context.abortSignal?.aborted) throw new PolicyMutationCancelledError();
		if (!params.authorization.trim())
			throw new Error(
				"policy_approve requires proposalId, proposalRevision, effect (steer, block, or exact), and a nonblank authorization explanation only",
			);
		const surface = this.toolSurface(api);
		const before = await this.snapshot();
		const proposal = before.pending.find((entry) => entry.id === params.proposalId);
		if (!proposal)
			throw new Error(
				"No pending proposal with that ID. Inspect policy_rules; do not substitute another proposal for the approved one.",
			);
		if (context.abortSignal?.aborted) throw new PolicyMutationCancelledError();
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
			context.abortSignal,
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
			output: [{ type: "text", text: boundedInspection(result) }],
			structuredOutput: result,
			details: result,
		};
	}

	async executeControl(
		params: Static<typeof PolicyControlParams>,
		api: Durable.ToolExecutionApi,
		context: Context,
	): Promise<Durable.ToolExecutionResult> {
		if (context.abortSignal?.aborted) throw new PolicyMutationCancelledError();
		validateControl(params);
		const surface = this.toolSurface(api);
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
		return {
			output: result.content,
			structuredOutput: result.details as JsonValue,
			details: result.details as Durable.JsonObject,
		};
	}

	/** The conversation an attached panel is bound to stands in for a tool execution surface. */
	private conversationSurface(conversation: Durable.Conversation): PolicySurface {
		return {
			conversationId: conversation.id,
			agent: (context) => conversation.agent(context),
			snapshot: (token, conversationId, context) => this.harness.snapshot(token, conversationId, context),
			commit: (change, context) => this.harness.commit(change, context),
		};
	}

	/** Bounded text for callers of the panel command that send no structured request. */
	async summaryText(): Promise<string> {
		const snapshot = await this.snapshot();
		return `Policy mode ${this.getMode()} \u00b7 ${snapshot.records.size} rules \u00b7 ${snapshot.pending.length} pending proposals \u00b7 store ${snapshot.health.status}. Use policy_rules for exact records.`;
	}

	/**
	 * The attached panel's reads, approvals, and controls against this host's registry and the bound
	 * conversation's scope. Every mutation carries a panel audit; the registry enforces the revisions and
	 * target identities the operator saw exactly as on the ordinary route.
	 */
	async panelRequest(request: PolicyPanelRequest, conversation: Durable.Conversation, context: Context): Promise<PolicyPanelAnswer> {
		const surface = this.conversationSurface(conversation);
		const agent = await surface.agent(context);
		const audit = makeRuleAudit(this.auditContext(conversation.id, agent), "panel");
		const signal = context.abortSignal;
		const settled = async (outcome: string, op: "approve" | "reject" | "lifecycle" | "effect" | "reset"): Promise<PolicyPanelAnswer> => ({ op, outcome, snapshot: serializeSnapshot(await this.snapshot()) });
		switch (request.op) {
			case "load": {
				const snapshot = await this.snapshot();
				const [fireSummary, activity] = await Promise.all([readFireSummary(this.dir), readRecentActivity(this.dir)]);
				return { op: "load", snapshot: serializeSnapshot(snapshot), fireSummary: serializeFireSummary(fireSummary), activity, scope: this.selectedRules(snapshot, agent).scope };
			}
			case "refresh": return { op: "refresh", snapshot: serializeSnapshot(await this.snapshot()) };
			case "inspect": {
				const text = boundedInspection(await this.inspect(request.view, request.id === undefined ? {} : { id: request.id }, surface, context));
				return { op: "inspect", text, snapshot: serializeSnapshot(await this.snapshot()) };
			}
			case "approve":
				await this.registry.decide(request.proposalId, "approved", request.effect, audit, request.revision, signal);
				return settled(`Approved proposal ${request.proposalId}.`, "approve");
			case "reject":
				await this.registry.decide(request.proposalId, "rejected", undefined, audit, request.revision, signal);
				return settled(`Rejected proposal ${request.proposalId}.`, "reject");
			case "lifecycle": {
				if (request.verb === "disable") await this.registry.disable(request.id, request.reason, audit, request.expectedIdentity, signal);
				else if (request.verb === "enable") await this.registry.enable(request.id, request.reason, audit, request.expectedIdentity, signal);
				else await this.registry.retire(request.id, request.reason, audit, request.expectedIdentity, signal);
				return settled(`${request.verb === "retire" ? "Retired" : request.verb === "disable" ? "Disabled" : "Enabled"} ${request.id}.`, "lifecycle");
			}
			case "effect":
				await this.registry.setEffect(request.id, request.effect, request.reason, audit, request.expectedIdentity, signal);
				return settled(`Set ${request.id} effect to ${request.effect}.`, "effect");
			case "reset-revision": {
				// Persist the synced periods first, so the revision shown binds the reset that follows it.
				const now = Date.now();
				const { rules } = await this.activeRules(surface, context);
				await this.withState(surface, context, (state) => { const observation = this.observationOf(state); observation.sync(rules, now); state.observation = observation.toJSON() as unknown as JsonValue; });
				return { op: "reset-revision", revision: await this.resetRevision(request.id, surface, context) };
			}
			case "reset":
				await this.resetObservation(request.id, request.reason, request.revision, surface, context);
				return settled("Started a new policy observation period.", "reset");
			case "data":
				return this.panelData(request.args, audit, agent.cwd ?? this.cwd);
		}
	}

	/**
	 * One owner data command for the attached panel, resolved against the bound conversation's cwd.
	 * A change answers with its complete review unless the arguments already carry its exact approval;
	 * applying then rechecks the binding revision, the reread file, and the artifact revision.
	 */
	private async panelData(args: string, audit: ReturnType<typeof makeRuleAudit<"panel">>, cwd: string): Promise<PolicyPanelAnswer> {
		const prepared = await prepareDataCommand(this.registry, args, audit, cwd);
		if ("text" in prepared) return { op: "data", outcome: prepared.text, snapshot: serializeSnapshot(await this.snapshot()) };
		if (prepared.approved) {
			const outcome = await prepared.apply();
			return { op: "data", outcome, snapshot: serializeSnapshot(await this.snapshot()) };
		}
		const action = prepared.title === "Remove policy data" ? "Remove policy data" : "Set policy data";
		return { op: "data", review: { title: prepared.title, text: prepared.review, approval: prepared.approval, action }, snapshot: serializeSnapshot(await this.snapshot()) };
	}

	private deps(surface: PolicySurface, context: Context): ToolDeps {
		return {
			registry: this.registry,
			loadRegistry: () => this.snapshot(),
			getMode: () => this.getMode(),
			actionControl: (params) => this.actionControl(params, surface, context),
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
		const { rules } = await this.activeRules(surface, context);
		return this.readState(surface, context, (state) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			const periods = observation
				.snapshot(now, state.turn)
				.filter((period) => id === "--all" || period.id === id)
				.map(({ id: periodId, revision, generation }) => ({ id: periodId, revision, generation }))
				.sort((left, right) => left.id.localeCompare(right.id));
			if (id !== "--all" && !periods.length) throw new Error(`No active rule named ${id}`);
			return contentRevision({
				instance: state.identity,
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
				instance: state.identity,
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
		const reading = await this.readStateAndGuidance(surface, context, (state, guidance) => {
			const observation = this.observationOf(state);
			observation.sync(rules, now);
			return { state, guidance, observation };
		});
		if (view === "state") {
			return {
				observationPeriods: publicState(reading.observation.snapshot(now, reading.state.turn)),
				turn: reading.state.turn,
				incomplete: reading.state.incomplete,
				staleCompletions: reading.state.stale,
				retainedGuidance: this.retainedGuidanceOf(reading.state).map((entry) => ({
					id: entry.id,
					revision: entry.revision,
					generation: entry.generation,
				})),
				guidanceRecords: this.guidanceRecordsOf(reading.guidance).map((record) => ({
					id: record.id,
					epoch: record.anchor.epoch,
					entryId: record.anchor.entryId,
					contribution: record.anchor.contribution,
					timestamp: record.timestamp,
				})),
			};
		}
		if (view === "health") {
			const guidanceRecords = this.guidanceRecordsOf(reading.guidance);
			return {
				authority: snapshot.health,
				telemetry: this.writer.health(),
				observations: {
					incomplete: reading.state.incomplete,
					pending: await this.pendingCount(surface.conversationId, context),
					recentCompletedIds: this.completedCallsOf(reading.state).length,
				},
				guidance: {
					status: reading.guidance.status,
					epoch: reading.guidance.epoch || null,
					records: guidanceRecords.length,
					retainedBytes: guidanceHistory(guidanceRecords).retainedBytes,
					limits: GUIDANCE_HISTORY_LIMITS,
				},
			};
		}
		if (view === "capabilities") {
			const active = new Set(agent.tools.map((tool) => tool.name));
			return {
				phases: ["input", "result", "completion", "context"],
				actions: ["deny", "require-approval", "rename-key", "substitute", "assert-error", "guide", "observe"],
				mode: this.getMode(),
				effectiveMode: this.effectiveMode(snapshot),
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
				observationStorage: "conversation documents",
				projection: "full transcript with retained guidance, no new turn",
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
		const compiled = preparedPolicyFor(snapshot).compiled.get(record.id);
		if (!compiled) throw new Error("The selected rule has no compiled program");
		const period = observation.view(record.id, now, state.turn);
		return {
			id: record.id,
			revision: record.definition.revision,
			active: effectiveState(record),
			programs: programSteps(compiled).map((rule) => rule.program),
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
		const policy = preparedPolicyFor(snapshot);
		const rules = [...policy.records.values()]
			.filter(
				(record) =>
					effectiveState(record) === "active" &&
					record.matcherAvailable &&
					ruleScopeMatches(record.definition.scope, scope),
			)
			.flatMap((record) => {
				const compiled = policy.compiled.get(record.id);
				return compiled ? [compiled] : [];
			});
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

