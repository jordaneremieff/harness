/**
 * agent/durable-agents: the native Pi Durable form of the agent controls.
 *
 * A Durable conversation receives its tools, tasks, and documents only from a
 * native extension. This module declares that contribution structurally. The
 * host installs the returned extension and passes its own pi-durable module, so
 * the slice takes every runtime value from `host.durable` and imports the
 * package for types only.
 *
 * Children are conversations in the same storage, owned by a background anchor
 * task of the owner conversation. Reporter tasks admit inputs and wait for
 * settlement. Retained delivery intents and common receipt delivery route each
 * answer to its intended recipient.
 *
 * Controls the host owns (common observation, compaction, commands, foreign
 * storages) run through the injected dispatch callback. Spawning never uses
 * that callback: a child is an owned conversation in the calling storage.
 */

import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { IntentParams, validateIntentInput } from "./effort-schema.ts";
import { agentRunControlDoc } from "./run-control-state.ts";
import { storageStatusPageInput, validateStatusSelectors } from "./storage-status.ts";
import { agentChildrenDoc, type AgentChild } from "./children.ts";
import { captureProviderRecovery, linkProviderRecovery } from "./provider-block.ts";
import { PresetParameter, presetParameter, readAgentPreferences, resolveExecutionPreset, effectiveExecutionSelection, renderAgentPreferences, type PreferenceSnapshot, type ExecutionSelection } from "./agent-preferences.ts";
import { forgetFailedAdmission, recordInputProvenance } from "./awaited-results.ts";
import { readCreatedAgents, type CreatedAgents } from "./agent-lineage.ts";
import { initializeProfile, reconcileProfile, ProfileDoc, refreshManagedInstructions } from "./profile.ts";
import { recordUnplacedInput, type Placement } from "./unplaced-inputs.ts";
import { AGENT_WORK_DESCRIPTION, AgentWorkOutputSchema, AgentWorkParams, closeOpenWork, executeAgentWork } from "./open-work.ts";
import { AgentMetaDoc, placementMode, publishConversationIntent, recordAdmissionMeta, recordDeliveryIntent, linkDeliveryIntent, seededCompactionInstructions } from "./durable-controls.ts";
import { recordAdmitted, recordRefused, recordRequested, recordScheduled, recordTimerCancelled, type OutgoingRequest } from "./continuity-admission.ts";
import { ProfileParams, ProfileOutputSchema, HandleSchema, profileText } from "./profile-schema.ts";
import { cleanupRequestContexts } from "./request-context.ts";
import { prepareAdmittedCapture } from "./communication-retention.ts";
import { taskInputSender, type TaskInputSender } from "./task-senders.ts";
import { targetIdentity } from "./identity.ts";
import { admittedResult, dispatchFacts } from "./result-reference.ts";
import { DispatchOutputSchema, type ResultReference } from "./result-schema.ts";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import { CollaborationParams } from "./collaboration-contract.ts";
import { controlText, readableControlText, projectReportReceipt } from "./control-result.ts";
import { projectSelectedStatus, projectStorageStatus, validateStatusDetail } from "./status-overview.ts";
import { dirname, isAbsolute, resolve } from "node:path";
import { AgentCatalog } from "./catalog.ts";
import { createPrimaryLocationResolver } from "./effort-location.ts";
import type { EffortReadResources } from "./effort-presence.ts";
import { readFleetStatus, validateFleetSelection, type FleetSelection } from "./fleet-status.ts";
import { readEffortAwareness, formatEffortAwareness, nativeIntentSelf } from "./effort-awareness.ts";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import { inputEntry, sentInputClass } from "./input-entry.ts";
import { str, num, int, bool, unknown, opt, obj, map, type Static, type Schema } from "@earendil-works/pi-schema";
import { CONTROL_BINDING_CONTRACT } from "./version-contract.ts";
import { THINKING_LEVELS } from "./configuration.ts";
import { AGENT_CONTROL_EXPOSURE, AGENT_CONTROL_TOOL_NAMES, FOLLOW_UP_DELIVERY_BOUNDARY, NATIVE_COMPACTION_SEED, MODEL_SELECTION_GUIDANCE, REPORT_DELIVERY_BOUNDARY, agentControlGuidanceLines, type AgentControlToolName } from "./control-guidance.ts";
import { abortScopeContains } from "./abort-scope.ts";
import { TimerTask, type TimerMode } from "./durable-timers.ts";
import { parseDeliverAt } from "./timer-input.ts";
import { CheckInTask, createCheckIn } from "./durable-checkins.ts";
import { checkInMinutes } from "./check-in-options.ts";
import type { DurableCommand, DurableCommandCall } from "./durable-services.ts";
import {
	InspectToolOutputSchema,
	StatusToolOutputSchema,
	StatusToolInputSchema,
	structuredObservation,
	nativeStructuredObservation,
} from "./observation-schema.ts";

// ─── Contribution contract ──────────────────────────────────────────────────

/** Runtime request methods the agent-session host serves for this contribution. */
export type AgentControlMethod =
	| "profile-read" | "profile-update" | "profile-list" | "resolve-agent" | "task-submit" | "report"
	| "submit"
	| "spawn"
	| "place"
	| "inspect"
	| "status"
	| "list"
	| "fork"
	| "rewind"
	| "abort"
	| "release"
	| "resolve-target"
	| "compact"
	| "configure"
	| "attach"
	| "command"
	| "receipts"
	| "acknowledge"
	| "reset"
	| "timer-schedule"
	| "timer-list"
	| "timer-cancel"
	| "collaboration-list"
	| "collaboration-read"
	| "collaboration-mutate";

/** One host control call. The host returns a structured result the tool formats for the model. */
export type AgentControlDispatch = (
	method: AgentControlMethod,
	params: Readonly<Record<string, unknown>>,
	context?: Context,
) => Promise<unknown>;

/** Version of the in-process control binding between one host runtime and the contributions it installs. */
export const AGENT_CONTROL_BINDING_VERSION = CONTROL_BINDING_CONTRACT;

/** Process-global key shared by a host runtime and every contribution it installs. */
export const AGENT_CONTROL_BINDING_KEY = Symbol.for("pi.agent.durable.controls");

/** One versioned runtime dispatch bound for the lifetime of an installed contribution. */
export interface AgentControlBinding {
	readonly version: string;
	readonly dispatch: AgentControlDispatch;
}

function controlGlobals(): Record<PropertyKey, unknown> {
	return globalThis as unknown as Record<PropertyKey, unknown>;
}

/**
 * Publish one runtime dispatch under a versioned envelope. The returned restore
 * function clears the publication only while it is still current, so a later
 * runtime in the same process keeps its own binding.
 */
export function publishAgentControlDispatch(dispatch: AgentControlDispatch): () => void {
	const globals = controlGlobals();
	const previous = globals[AGENT_CONTROL_BINDING_KEY];
	globals[AGENT_CONTROL_BINDING_KEY] = { version: AGENT_CONTROL_BINDING_VERSION, dispatch } satisfies AgentControlBinding;
	return () => {
		const current = globals[AGENT_CONTROL_BINDING_KEY] as Partial<AgentControlBinding> | undefined;
		if (current?.dispatch === dispatch) globals[AGENT_CONTROL_BINDING_KEY] = previous;
	};
}

/**
 * Resolve the binding for one loaded contribution. Only the versioned
 * envelope resolves; a bare function, a foreign value, and another version
 * refuse with a clear message, because the retained dispatch and this
 * contribution code do not describe one contract and a host restart loads the
 * matching runtime.
 */
export function resolveAgentControlDispatch(): AgentControlDispatch {
	const raw = controlGlobals()[AGENT_CONTROL_BINDING_KEY];
	if (raw === undefined) throw new Error("Native Durable host controls are unavailable in this process");
	if (typeof raw !== "object" || raw === null) throw new Error("The native Durable host control binding is malformed. Restart the agent host.");
	const version = (raw as { readonly version?: unknown }).version;
	if (typeof version !== "string" || version.length === 0 || version.length > 256)
		throw new Error("The native Durable host control binding is malformed. Restart the agent host.");
	if (version !== AGENT_CONTROL_BINDING_VERSION)
		throw new Error(
			`The native Durable host control binding uses version ${version}; this contribution requires version ${AGENT_CONTROL_BINDING_VERSION}. Restart the agent host to load the matching runtime.`,
		);
	const dispatch = (raw as { readonly dispatch?: unknown }).dispatch;
	if (typeof dispatch !== "function") throw new Error("The native Durable host control binding is malformed. Restart the agent host.");
	return dispatch as AgentControlDispatch;
}

/** One command invocation, as the host control passes it to a registered command. */
export type AgentCommandCall = DurableCommandCall;

/** Command the host invokes by name through its command control. */
export type AgentCommand = DurableCommand;

/** What the host supplies to build the native extension for one session host. */
export interface AgentContributionHost {
	/** The host's pi-durable module. Take every runtime value from it. */
	readonly durable: typeof Durable;
	/** Durable storage identity used in `sessionId` values. */
	readonly storageId: string;
	/** Catalog directory for store-local handle resolution. */
	readonly catalogRoot?: string;
	/** Working directory this storage serves. One storage serves one cwd. */
	readonly cwd: string;
	readonly agentDir: string;
	readonly onClose: (dispose: () => void) => void;
	/** Pi's model runtime, read-only; used to clamp a requested thinking level. */
	readonly services: {
		readonly modelRuntime: {
			getModel(provider: string, modelId: string): Model<Api> | undefined;
			getModels?(): readonly Model<Api>[];
		};
	};
}

/** Native Durable form of this extension, installed by the agent-session host. */
export interface AgentContribution {
	readonly name: string;
	/** Absolute path of the emitting extension entrypoint, from `index.ts`. */
	readonly source: string;
	create(host: AgentContributionHost): Durable.Extension;
	readonly commands?: readonly AgentCommand[];
}

export interface AgentContributionOptions {
	/** Rebind the factory publisher to the native host directory. */
	readonly configureSettings: (host: AgentContributionHost) => void;
	/** Absolute path of the emitting extension entrypoint, for example `fileURLToPath(import.meta.url)`. */
	readonly source: string;
	/** Host control dispatch; absent features report an explicit error result. */
	readonly dispatch?: AgentControlDispatch;
	/** Commands the host registry exposes to `agent_command` and other controls. */
	readonly commands?: readonly AgentCommand[];
}

/** Effective model and thinking level a new child conversation must store explicitly. */
type ChildAgentValues = {
	readonly selection?: ExecutionSelection;
	readonly model: Durable.ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly thinking?: { requested: string; effective: string };
};

// ─── Durable documents ──────────────────────────────────────────────────────

/** Child record with its local conversation and anchor present. */
type LocalChild = AgentChild & {
	readonly conversationId: Durable.ConversationId;
	readonly anchorTaskId: Durable.TaskId;
};

function sessionIdOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return undefined;
	const candidate = (value as { readonly sessionId?: unknown }).sessionId;
	return typeof candidate === "string" ? candidate : undefined;
}

/** Resolve a place area with symlinks applied. */
function resolvePlaceArea(requested: string): { kind: "ok"; area: string } | { kind: "error"; message: string } {
	try {
		return { kind: "ok", area: realpathSync(requested) };
	} catch (error) {
		return {
			kind: "error",
			message: `Place area is not available: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function thinkingFacts(child: Pick<AgentChild, "thinking">): Record<string, JsonValue> {
	return child.thinking === undefined ? {} : { thinking: child.thinking };
}

function selectionSnapshot(child: Pick<AgentChild, "selection">): { selection?: ExecutionSelection } {
	return child.selection === undefined ? {} : { selection: JSON.parse(JSON.stringify(child.selection)) as ExecutionSelection };
}

function thinkingNotice(child: Pick<AgentChild, "thinking" | "selection">): string {
	return (child.thinking === undefined ? "" : `\nThinking level: requested ${child.thinking.requested}; effective ${child.thinking.effective}.`) + (child.selection === undefined ? "" : `\nExecution selection: ${JSON.stringify(child.selection)}`);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

type ControlDetails = Record<string, JsonValue>;

function textResult(
	text: string,
	details: ControlDetails = {},
): Durable.ToolExecutionResult<ControlDetails> {
	return { output: [{ type: "text", text }], details };
}

function errorResult(text: string): Durable.ToolExecutionResult<ControlDetails> {
	return { output: [{ type: "text", text }], isError: true };
}

function placeResult(sessionId: string, result: ControlDetails, area?: string): Durable.ToolExecutionResult<ControlDetails> {
	const owner = area === undefined ? `The place owner is ${sessionId}.` : `The owner of ${area} is ${sessionId}.`;
	return textResult(`${owner}\n${JSON.stringify(result)}`, { ...result, sessionId, ...(area === undefined ? {} : { area }) });
}

/** Control facts remain UI details and also become validated values for nested callers. */
function structuredControl<P extends Schema, D extends JsonValue>(
	tool: Durable.ToolRegistration<P, D>,
	schema: Schema,
): Durable.ToolRegistration<P, D> {
	return {
		...tool,
		structuredOutputSchema: schema,
		execute: async (args, api, context) => {
			const result = await tool.execute(args, api, context);
			if (result.isError) return result;
			const text = result.output?.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
			const native = nativeStructuredObservation(schema, result.details, text);
			return { ...result, output: native.output, structuredOutput: native.structuredOutput };
		},
	};
}

function conversationIdOf(value: unknown): Durable.ConversationId {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`invalid conversation id: ${String(value)}`);
	return numeric as Durable.ConversationId;
}

function entryIdOf(value: string): Durable.EntryId {
	const numeric = Number(value);
	if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`invalid entry id: ${value}`);
	return numeric as Durable.EntryId;
}

function modelOf(value: string): Durable.ModelRef {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1)
		throw new Error(`model must be "provider/model", received ${value}`);
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

// ─── Parameter schemas ──────────────────────────────────────────────────────

const StringEnum = <const T extends readonly string[]>(values: T, options: { readonly description?: string } = {}): Schema<T[number]> => ({ type: "string", enum: [...values], ...options });

const CheckInParams = opt(num({ minimum: 0, maximum: 35791, description: "Owner check-in interval while unanswered, in minutes. Default configured agent.checkInMinutes, which is 0 (no check-ins) unless set; results arrive without them." }));

const SpawnParams = obj(
	{
		handle: opt(HandleSchema),
		preset: PresetParameter,
		role: opt(str({
			maxLength: 2000,
			description: "Durable role text saved on the new agent's profile, with or without a handle. Reuse does not change the role.",
		})),
		prompt: opt(
			str({ description: "Initial assignment for the agent. Without one the agent stays idle." }),
		),
		name: opt(str({ description: "Display name for the agent. Names may repeat." })),
		cwd: opt(
			str({ description: "Working directory for the agent. Default: inherited from the creating conversation." }),
		),
		model: opt(
			str({ minLength: 3, description: MODEL_SELECTION_GUIDANCE }),
		),
		thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
		checkInMinutes: CheckInParams,
	},
	{},
);

const SendParams = obj(
	{
		sessionId: str({
			minLength: 1,
			description: "External identity: storage id for the root, storageId:conversationId otherwise.",
		}),
		message: str({ minLength: 1 }),
		replyTo: opt(
			str({
				minLength: 1,
				description: "Conversation that receives the answer; default: the calling conversation.",
			}),
		),
		deliverAt: opt(
			str({
				minLength: 1,
				description: "Absolute ISO 8601 date-time; schedule the input instead of admitting it now.",
			}),
		),
		mode: opt(
			StringEnum(["followUp", "steer", "report"], { description: "Class of the message, not a placement time. Default followUp: new work. steer corrects the recipient's current work. report is an event for the recipient." }),
		),
		passive: opt(bool({ description: "Report mode only. Enter context at the next normal boundary without attention." })),
		checkInMinutes: CheckInParams,
	},
	{},
);

const SteerParams = obj(
	{
		sessionId: str({
			minLength: 1,
			description: "External identity: storage id for the root, storageId:conversationId otherwise.",
		}),
		message: str({ minLength: 1 }),
		replyTo: opt(
			str({
				minLength: 1,
				description: "Conversation that receives the answer; default: the calling conversation.",
			}),
		),
	},
	{},
);

const AbortParams = obj(
	{
		sessionId: str({ minLength: 1 }),
		background: opt(
			bool({ description: "Also stop background work such as anchors and reporters." }),
		),
		timerId: opt(
			int({ minimum: 1, description: "Timer ID from agent_status; cancels only that scheduled input." }),
		),
		release: opt(bool({ description: "Request host retirement after abort." })),
	},
	{},
);

const ForkParams = obj(
	{
		sessionId: str({ minLength: 1 }),
		entryId: opt(str({ description: "Fork point; default: the newest visible entry." })),
		name: opt(str()),
		prompt: opt(str()),
	},
	{},
);

const RewindParams = obj(
	{
		sessionId: str({ minLength: 1, description: "Conversation that took the wrong turn." }),
		entryId: str({
			minLength: 1,
			description: "Entry that carries the wrong decision. It and everything after it are dropped.",
		}),
		correction: str({ minLength: 1 }),
		name: opt(str()),
	},
	{},
);

const ConfigureParams = obj(
	{
		preset: PresetParameter,
		sessionId: str({ minLength: 1 }),
		name: opt(str({ description: "Owner-visible name; stored by the session host." })),
		model: opt(
			str({ minLength: 3, description: MODEL_SELECTION_GUIDANCE }),
		),
		thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
	},
	{},
);

const CompactParams = obj(
	{
		sessionId: opt(str({ minLength: 1, description: "Default: the calling conversation." })),
		instructions: opt(str()),
	},
	{},
);

const CommandParams = obj(
	{
		sessionId: str({ minLength: 1 }),
		name: str({ minLength: 1 }),
		args: opt(str()),
	},
	{},
);

const StatusParams = StatusToolInputSchema;

const ListParams = obj(
	{
		query: opt(
			str({
				minLength: 1,
				maxLength: 256,
				description: "Case-insensitive literal in stored ID, cwd, name, or first user text.",
			}),
		),
		cwd: opt(
			str({ minLength: 1, maxLength: 4096, description: "Exact absolute working directory filter." }),
		),
		limit: opt(int({ minimum: 1, maximum: 20 })),
		cursor: opt(str({ minLength: 1, maxLength: 1024 })),
	},
	{},
);

/** A positive native record ID in the number or numeric-string form the host accepts. */
const PositiveId = int({ minimum: 1 });

const InspectParams = obj(
	{
		sessionId: opt(str({ minLength: 1, description: "Default: the calling conversation." })),
		view: opt(StringEnum(["activity", "history", "branch", "search", "exact", "result"])),
		limit: opt(int({ minimum: 1 })),
		cursor: opt(
			map(unknown(), {
				description: "Opaque cursor object returned as next by a previous inspect page.",
			}),
		),
		entryId: opt(PositiveId),
		fromId: opt(PositiveId),
		offset: opt(int({ minimum: 0 })),
		query: opt(str({ minLength: 1 })),
		source: opt(StringEnum(["user", "assistant", "toolResult", "summary", "custom"])),
		submissionId: opt(PositiveId),
		requestId: opt(str({ minLength: 1, description: "Native request ID within the selected conversation; result view only." })),
		operationId: opt(str({ minLength: 1 })),
		receiptCursor: opt(str({ minLength: 1, maxLength: 2048, description: "Recipient-reference continuation from result receiptGroup.next; separate from answer offset." })),
	},
	{},
);

const AttachParams = obj(
	{
		sessionId: str({ minLength: 1 }),
		model: opt(str({ minLength: 3 })),
		thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
	},
	{},
);

const PlaceParams = obj(
	{
		preset: PresetParameter,
		model: opt(str({ minLength: 3, description: MODEL_SELECTION_GUIDANCE })),
		thinkingLevel: opt(StringEnum(THINKING_LEVELS)),
		area: opt(
			str({ description: "Directory the owner covers. Default: the calling conversation's cwd." }),
		),
		topic: opt(str({ description: "What the owner is for; stored as its name." })),
		prompt: opt(str({ description: "Work to deliver to the owner." })),
		checkInMinutes: CheckInParams,
	},
	{},
);

const ResetParams = obj(
	{
		sessionId: str({
			minLength: 1,
			description: "Conversation to reset: storage id for the root, storageId:conversationId otherwise.",
		}),
		handoff: opt(
			str({ description: "Operator-authored text for the new context; absent starts it without a message." }),
		),
	},
	{},
);

type SpawnInput = Static<typeof SpawnParams>;
type SendInput = Static<typeof SendParams>;
type SteerInput = Static<typeof SteerParams>;
type AbortInput = Static<typeof AbortParams>;
type ForkInput = Static<typeof ForkParams>;
type RewindInput = Static<typeof RewindParams>;
type ConfigureInput = Static<typeof ConfigureParams>;
type CompactInput = Static<typeof CompactParams>;
type CommandInput = Static<typeof CommandParams>;
type StatusInput = Static<typeof StatusParams>;
type ListInput = Static<typeof ListParams>;
type InspectInput = Static<typeof InspectParams>;
type AttachInput = Static<typeof AttachParams>;
type PlaceInput = Static<typeof PlaceParams>;
type ResetInput = Static<typeof ResetParams>;

// ─── Extension ──────────────────────────────────────────────────────────────

const SECTION_PREAMBLE = [
	"Every conversation has an external identity: the bare storage id for the root, storageId:conversationId otherwise. Use the identity from agent_status or agent_list as sessionId for agent_send, agent_steer, agent_abort, agent_configure, agent_compact, agent_rewind, and agent_command.",
	"Final answers route to each request's reply recipient. Use agent_send mode: report for interim notices; the creating owner is provenance, not every request's recipient.",
];

/** Apply this slice's exposure table to one native registration. */
function exposedControl<T extends Durable.ToolRegistration>(tool: T): T {
	const exposure = AGENT_CONTROL_EXPOSURE[tool.name as AgentControlToolName];
	if (exposure === "deferred") return { ...tool, deferred: true };
	if (exposure === "model-only") return { ...tool, callers: ["model"] };
	return tool;
}

/**
 * Build the structural contribution. `index.ts` emits the result on the
 * `durable:contribution` channel with its own absolute entrypoint as `source`.
 */
export function createAgentContribution(options: AgentContributionOptions): AgentContribution {
	return {
		name: "agent",
		source: options.source,
		...(options.commands === undefined ? {} : { commands: options.commands }),
		create(host) {
			options.configureSettings(host);
			return buildExtension(host, options);
		},
	};
}

/** Fleet observation stays local; no host operation or remote forwarding participates. */
async function fleetObservation(catalogRoot: string | undefined, sessionId: string | undefined, callerId: string, created?: CreatedAgents, selection: FleetSelection = {}) {
	const effort = { callerId, created: created?.agents.map((agent) => agent.identity) ?? [], omitted: created?.omitted ?? 0 };
	try {
		if (sessionId !== undefined) throw new Error("Fleet status describes the local catalog; omit sessionId");
		if (!catalogRoot) throw new Error("Fleet discovery requires a configured local catalog root");
		const value = structuredObservation(StatusToolOutputSchema, await readFleetStatus(new AgentCatalog(dirname(catalogRoot)), { ...selection, effort })) as Record<string, JsonValue>;
		return { ...nativeStructuredObservation(StatusToolOutputSchema, value, JSON.stringify(value)), details: value };
	} catch (error) {
		return errorResult(`Fleet status failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function buildExtension(host: AgentContributionHost, options: AgentContributionOptions): Durable.Extension {
	const durable = host.durable;
	const dispatch = options.dispatch;
	const locations = createPrimaryLocationResolver();
	const effortCatalog = host.catalogRoot === undefined ? undefined : new AgentCatalog(dirname(host.catalogRoot));
	const effortResources: EffortReadResources | undefined = effortCatalog === undefined ? undefined : { catalog: effortCatalog, locations };
	const registrationPreferences = readAgentPreferences(host.agentDir, host.services.modelRuntime);
	const presetParams = <T extends typeof SpawnParams | typeof ConfigureParams | typeof PlaceParams>(params: T): T => ({ ...params, properties: { ...(params.properties as Record<string, Schema>), preset: presetParameter(registrationPreferences).schema } });
	const preferenceSnapshot = async (api: Durable.ToolExecutionApi<ControlDetails>, context: Context): Promise<PreferenceSnapshot> => {
		const retained = await api.memo("agent-preferences", context);
		if (retained !== undefined) return retained as unknown as PreferenceSnapshot;
		return await api.memo("agent-preferences", JSON.parse(JSON.stringify(readAgentPreferences(host.agentDir, host.services.modelRuntime))), context) as unknown as PreferenceSnapshot;
	};

	/** Resolve an external identity against this storage. */
	const target = (
		sessionId: string | undefined,
	):
		| { kind: "self" }
		| { kind: "root" }
		| { kind: "local"; conversationId: Durable.ConversationId }
		| { kind: "foreign" } => {
		if (sessionId === undefined) return { kind: "self" };
		sessionId = targetIdentity(sessionId, host.catalogRoot);
		if (sessionId === host.storageId) return { kind: "root" };
		if (sessionId.startsWith(`${host.storageId}:`)) {
			return { kind: "local", conversationId: conversationIdOf(sessionId.slice(host.storageId.length + 1)) };
		}
		return { kind: "foreign" };
	};

	const localConversation = (
		sessionId: string | undefined,
		self: Durable.ConversationId,
	): Durable.ConversationId | undefined => {
		const resolved = target(sessionId);
		if (resolved.kind === "self") return self;
		if (resolved.kind === "root") return durable.ROOT_CONVERSATION_ID;
		if (resolved.kind === "local") return resolved.conversationId;
		return undefined;
	};

	/** External identity used in `sessionId` values; the root uses the bare storage id. */
	const identity = (conversationId: Durable.ConversationId): string =>
		conversationId === durable.ROOT_CONVERSATION_ID ? host.storageId : `${host.storageId}:${conversationId}`;

	const resolvesToSelf = (sessionId: string, conversationId: Durable.ConversationId): boolean => {
		const resolved = target(sessionId);
		if (resolved.kind === "root") return conversationId === durable.ROOT_CONVERSATION_ID;
		if (resolved.kind === "local") return resolved.conversationId === conversationId;
		return false;
	};

	const isSelfCompact = (sessionId: string | undefined, conversationId: Durable.ConversationId): boolean =>
		sessionId === undefined || resolvesToSelf(sessionId, conversationId);

	const hostControl = async (
		method: AgentControlMethod,
		params: Readonly<Record<string, unknown>>,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		if (dispatch === undefined)
			return errorResult(`Host control ${method} is unavailable: this contribution has no dispatch callback.`);
		try {
			return textResult(controlText(await dispatch(method, params)));
		} catch (error) {
			return errorResult(`Host control ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** Forward one observation to the host dispatch and prove its output schema. */
	const hostObservation = async (
		method: AgentControlMethod,
		params: Readonly<Record<string, unknown>>,
		failure: string,
		schema: Parameters<typeof structuredObservation>[0],
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		if (dispatch === undefined)
			return errorResult(`${failure}: the host control is unavailable; this contribution has no dispatch callback.`);
		try {
			const value = await dispatch(method, params);
			const structured = structuredObservation(schema, value) as Record<string, JsonValue>;
			return { ...nativeStructuredObservation(schema, structured, method === "inspect" ? readableControlText(structured) : controlText(structured)), details: structured };
		} catch (error) {
			return errorResult(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const RunControl = agentRunControlDoc(durable);
	const rememberRunInputs = (api: Durable.ToolExecutionApi<ControlDetails>, context: Context) => api.commit(async tx => {
		const live = await tx.doc(durable.LiveDoc, api.conversationId);
		const state = await tx.doc(RunControl, api.conversationId, String(api.taskId), null);
		if (!state.recorded && live.run) { state.recorded = true; state.inputs = live.run.inputs.slice(0, 200); state.complete = live.run.inputs.length <= 200; }
		return undefined;
	}, context);
	const retainDispatch = (api: Durable.ToolExecutionApi<ControlDetails>, context: Context, result?: ResultReference | null, response?: Record<string, JsonValue>, placeArea?: string) => api.commit(async tx => {
		const state = await tx.doc(RunControl, api.conversationId, String(api.taskId), null);
		state.dispatch = result === undefined ? "pending" : "confirmed";
		if (result !== undefined) state.result = result;
		if (response !== undefined) state.response = response;
		if (placeArea !== undefined) state.placeArea = placeArea;
		return undefined;
	}, context);

	type DispatchCapture = { api: Durable.ToolExecutionApi<ControlDetails>; context: Context };
	const isInputDispatch = (method: AgentControlMethod, params: Readonly<Record<string, unknown>>) => method === "submit" || method === "task-submit" || (method === "resolve-agent" || method === "place") && params.prompt !== undefined;
	const retainedPlace = async (capture: DispatchCapture, params: Readonly<Record<string, unknown>>) => {
		const state = await capture.api.snapshot(RunControl, capture.api.conversationId, String(capture.api.taskId), capture.context);
		if (state?.dispatch !== "confirmed") return undefined;
		if (!state.response || !state.result) throw new Error("Confirmed place dispatch has no retained admission");
		const area = state.placeArea;
		if (area !== undefined && (typeof area !== "string" || !isAbsolute(area))) throw new Error("Confirmed place dispatch has an invalid retained canonical area");
		dispatchFacts("place", params, state.response);
		const reference = state.response.result as ResultReference;
		if (reference.sessionId !== state.result.sessionId || reference.submissionId !== state.result.submissionId || reference.requestId !== state.result.requestId)
			throw new Error("Retained place references disagree");
		return { area, sessionId: reference.sessionId, result: JSON.parse(JSON.stringify(state.response)) as Record<string, JsonValue> };
	};
	/**
	 * Continuity facts of the calling conversation's outgoing requests. A fact that cannot be
	 * written becomes a diagnostic; it never fails the admission it describes.
	 */
	const continuityFact = async (api: Pick<Durable.ToolExecutionApi<ControlDetails>, "commit" | "diagnostic">, context: Context, write: (tx: Durable.Tx) => Promise<unknown>): Promise<void> => {
		try { await api.commit(async (tx) => { await write(tx); return undefined; }, context); }
		catch (error) {
			if (context.abortSignal?.aborted) throw error;
			api.diagnostic({ severity: "error", message: `Continuity fact not recorded: ${error instanceof Error ? error.message : String(error)}` });
		}
	};
	/** The request key known before a dispatch to a named target; a handle or a new agent has none. */
	const outgoingRequest = (api: Durable.ToolExecutionApi<ControlDetails>, method: AgentControlMethod, params: Readonly<Record<string, unknown>>): OutgoingRequest | undefined => {
		if ((method !== "submit" && method !== "task-submit") || typeof params.sessionId !== "string" || typeof params.requestId !== "string") return undefined;
		return { sessionId: params.sessionId, requestId: params.requestId, replyTo: typeof params.replyTo === "string" ? params.replyTo : identity(api.conversationId) };
	};
	/** Retain the pending dispatch and the request key before the target can admit anything. */
	const beginInputDispatch = async (capture: DispatchCapture, method: AgentControlMethod, params: Readonly<Record<string, unknown>>): Promise<OutgoingRequest | undefined> => {
		const outgoing = outgoingRequest(capture.api, method, params);
		await rememberRunInputs(capture.api, capture.context);
		await retainDispatch(capture.api, capture.context);
		if (outgoing !== undefined) await continuityFact(capture.api, capture.context, (tx) => recordRequested(tx, capture.api.conversationId, outgoing));
		return outgoing;
	};
	/** The receipt names the admitted identity; a request without a prior key is recorded under it. */
	const admittedFact = async (capture: DispatchCapture, outgoing: OutgoingRequest | undefined, admitted: ResultReference | undefined): Promise<void> => {
		const request = outgoing ?? (admitted?.requestId === undefined ? undefined : { sessionId: admitted.sessionId, requestId: admitted.requestId, replyTo: identity(capture.api.conversationId) });
		if (request !== undefined) await continuityFact(capture.api, capture.context, (tx) => recordAdmitted(tx, capture.api.conversationId, request, admitted));
	};
	const dispatchValue = async (perform: AgentControlDispatch, method: AgentControlMethod, params: Readonly<Record<string, unknown>>, capture?: DispatchCapture): Promise<unknown> => {
		const input = capture && isInputDispatch(method, params);
		const outgoing = input ? await beginInputDispatch(capture, method, params) : undefined;
		// A dispatch error does not prove that the target admitted nothing, so the request then stays listed as unconfirmed.
		const value = await perform(method, params);
		const placeArea = method === "place" ? params.area as string : undefined;
		if (method === "submit" || method === "task-submit" || input && method === "place") dispatchFacts(method, params, value);
		if (input) {
			const facts = structuredObservation(DispatchOutputSchema, value) as { result?: ResultReference };
			await retainDispatch(capture.api, capture.context, facts.result ?? null,
				method === "place" ? JSON.parse(JSON.stringify(value)) as Record<string, JsonValue> : undefined,
				placeArea);
			await admittedFact(capture, outgoing, facts.result);
		}
		return value;
	};

	/** Forward one control to the host dispatch and format its structured result. */
	const dispatchControl = async (
		method: AgentControlMethod,
		params: Readonly<Record<string, unknown>>,
		failure: string,
		capture?: DispatchCapture,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		if (dispatch === undefined) return errorResult(`${failure}: no dispatch callback.`);
		try {
			const raw = await dispatchValue(dispatch, method, params, capture);
			const value = method === "report" ? projectReportReceipt(raw) : raw;
			const shown = controlText(value);
			return textResult(method === "report" ? `${shown}\n${REPORT_DELIVERY_BOUNDARY}` : shown, value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {});
		} catch (error) {
			return errorResult(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** Copy every defined field of a validated tool input into host control params. */
	const defined = <T extends object>(source: T, keys: readonly (keyof T)[]): Record<string, unknown> => {
		const params: Record<string, unknown> = {};
		for (const key of keys) {
			const value = source[key];
			if (value !== undefined) params[String(key)] = value;
		}
		return params;
	};

	const Children = agentChildrenDoc(durable);

	const Anchor = durable.defineTask<null, { phase: "done" }, null>({
		name: "agent.anchor",
		version: 1,
		initial: () => ({ phase: "done" }),
		phases: {
			done: (_anchor, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
		},
		abort: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	type ReporterInput = {
		name: string;
		conversationId: Durable.ConversationId;
		message: string;
		whenBusy: "steer" | "followUp";
		checkInMinutes?: number;
		/** Conversation that receives the answer; absent: the reporter's conversation. */
		reportTo?: Durable.ConversationId;
	};
	type ReporterState = { phase: "deliver" };

	const reporterInput = (
		name: string,
		conversationId: Durable.ConversationId,
		message: string,
		whenBusy: "steer" | "followUp",
		reportTo?: Durable.ConversationId,
		minutes = 0,
	): ReporterInput => ({
		name,
		conversationId,
		message,
		whenBusy,
		checkInMinutes: minutes,
		...(reportTo === undefined ? {} : { reportTo }),
	});

	/** An unplaced input waits in the recipient's inbox until its current tool round ends. */
	const placementText = (placement: Placement): string => placement === "unplaced"
		? "\nPlacement: unplaced. The recipient is busy; the input is placed when its current tool round ends."
		: placement === "withdrawn"
			? "\nPlacement: withdrawn. The input is not in the recipient's inbox and not in its transcript: it left the inbox before placement. Send it again if it is still needed."
			: "\nPlacement: placed.";

	const LocalAdmission = durable.defineDoc<{ armed: boolean }>({ kind: "agent.local-admission", version: 1, scope: "task", checkpointWhen: () => false, initial: () => ({ armed: false }) });

	type LocalAdmissionApi = {
		readonly conversationId: Durable.ConversationId;
		readonly registry: Durable.RegistrySnapshot;
		conversation(id: Durable.ConversationId, context: Context): Promise<Durable.ConversationHandle | undefined>;
		commit(change: (tx: Durable.Tx) => Promise<undefined>, context: Context): Promise<unknown>;
	};
	const admitLocal = async (api: LocalAdmissionApi, context: Context, reporterTaskId: Durable.TaskId, input: ReporterInput, report: (error: unknown) => void, now: number): Promise<{ submission: Durable.Submission; result: ResultReference; placement: Placement }> => {
		const conversation = await api.conversation(input.conversationId, context);
		if (conversation === undefined) throw new Error("The result producer conversation is missing");
		const request = { requestId: `agent-deliver:${reporterTaskId}`, requester: identity(api.conversationId), replyTo: identity(input.reportTo ?? api.conversationId), origin: "model" as const };
		const outgoing: OutgoingRequest = { sessionId: identity(input.conversationId), requestId: request.requestId, replyTo: request.replyTo };
		// A continuity fact shares the admission's transaction; one that cannot be written is reported and never fails the admission.
		const fact = async (write: () => Promise<unknown>): Promise<void> => { try { await write(); } catch (error) { report(error); } };
		await reconcileProfile(api, input.conversationId, context, report, host.storageId);
		let recoveryOf: string | undefined;
		let taskSender: TaskInputSender | undefined;
		let deduped = false;
		await api.commit(async (tx) => {
			deduped = await tx.submissionByRequest(input.conversationId, request.requestId) !== undefined;
			taskSender = taskInputSender(request.requester, (await tx.doc(AgentMetaDoc, api.conversationId)).name);
			recoveryOf = await captureProviderRecovery(tx, input.conversationId, request.requestId);
			const admission = await tx.doc(LocalAdmission, reporterTaskId);
			await fact(() => recordRequested(tx, api.conversationId, outgoing));
			await recordDeliveryIntent(tx, input.conversationId, { requestId: request.requestId, ownerId: request.replyTo, message: input.message, whenBusy: input.whenBusy, origin: request.origin, senderIdentity: request.requester, requestContext: request, checkInMinutes: 0 }, now, "retained");
			await recordInputProvenance(tx, { conversationId: input.conversationId, requestId: request.requestId, classification: "explicit", sender: request.requester });
			if (admission.armed) return undefined;
			await recordAdmissionMeta(tx, input.conversationId, input.message);
			await createCheckIn(tx, { conversationId: input.conversationId, requestId: request.requestId, ownerId: request.replyTo, senderIdentity: identity(input.conversationId), message: input.message, whenBusy: input.whenBusy, origin: "model", admittedAt: now, requester: request.requester }, api.registry.task(CheckInTask.definition.name) === undefined ? 0 : input.checkInMinutes ?? 0);
			admission.armed = true;
			return undefined;
		}, context);
		const submission = await conversation.submit({ type: "input", content: input.message, whenBusy: placementMode(input.whenBusy), requestId: request.requestId, entry: inputEntry("model", request.requester, { class: sentInputClass("model", input.whenBusy), sender: request.requester, requestId: request.requestId }) }, context).catch(async (error) => {
			await api.commit(async (tx) => {
				await forgetFailedAdmission(tx, input.conversationId, request.requestId);
				// No submission under the request ID proves that nothing was admitted.
				if (await tx.submissionByRequest(input.conversationId, request.requestId) === undefined) await fact(() => recordRefused(tx, api.conversationId, outgoing));
				return undefined;
			}, BACKGROUND_CONTEXT);
			throw error;
		});
		await api.commit(async (tx) => {
			if (await linkDeliveryIntent(tx, input.conversationId, request.requestId, submission.id)) throw new Error("The retained delivery intent identifies another native submission");
			const capture = await prepareAdmittedCapture(tx, host.storageId, input.conversationId, request.requestId, submission.id, undefined, () => now, deduped, taskSender);
			await recordInputProvenance(tx, { conversationId: input.conversationId, requestId: request.requestId, classification: "explicit", sender: request.requester });
			await capture();
			await fact(() => recordAdmitted(tx, api.conversationId, outgoing, { sessionId: outgoing.sessionId, requestId: outgoing.requestId, submissionId: submission.id }));
			return undefined;
		}, context);
		await api.commit(async (tx) => { await linkProviderRecovery(tx, submission.id, recoveryOf); return undefined; }, context);
		const status = await submission.status(context);
		if (status.id !== submission.id || status.requestId !== request.requestId || status.conversationId !== input.conversationId) throw new Error("Native admission identifiers disagree");
		let placement: Placement = status.status === "queued" ? "unplaced" : "placed";
		await api.commit(async (tx) => {
			placement = await recordUnplacedInput(tx, input.conversationId, { submissionId: submission.id, class: sentInputClass("model", input.whenBusy), sender: request.requester, admittedAt: now, recipient: identity(input.conversationId) });
			return undefined;
		}, context);
		return { submission, result: admittedResult(identity(input.conversationId), { submissionId: submission.id, conversationId: status.conversationId, requestId: status.requestId }, request.requestId), placement };
	};

	const Reporter = durable.defineTask<ReporterInput, ReporterState, null>({
		name: "agent.reporter",
		version: 2,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (reporter, runtime, context) => {
				const { submission } = await admitLocal(runtime, context, reporter.id, reporter.input, (error) => runtime.report(error), runtime.now());
				await submission.wait(context);
				await runtime.commit(async (tx) => {
					await cleanupRequestContexts(tx, reporter.input.conversationId);
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
			},
		},
		abort: (_reporter, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	/** Create an anchor-owned child conversation and record it in the owner registry. */
	const createChild = async (
		tx: Durable.Tx,
		ownerId: Durable.ConversationId,
		name: string,
		createdBy: Durable.TaskId,
		change: Durable.AgentChange,
	): Promise<LocalChild> => {
		const anchor = await tx.createTask(Anchor, null, {
			ownership: { kind: "conversation" },
			conversationId: ownerId,
			background: true,
		});
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		if (Object.keys(change).length > 0) await durable.configure(tx, child.id, change);
		const record: LocalChild = {
			name,
			conversationId: child.id,
			anchorTaskId: anchor,
			createdBy,
		};
		return record;
	};

	/** Resolve the effective agent values a new child must store explicitly. */
	const resolveChildAgent = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		modelOverride?: string,
		thinkingLevelOverride?: ModelThinkingLevel,
		selection?: ExecutionSelection,
	): Promise<{ kind: "ok"; values: ChildAgentValues } | { kind: "error"; message: string }> => {
		const parent = await api.agent(context);
		const model = modelOverride === undefined ? parent.model : modelOf(modelOverride);
		if (model === undefined) return { kind: "error", message: "The owner conversation has no model configured." };
		const requested = thinkingLevelOverride ?? parent.thinkingLevel;
		const catalog = host.services.modelRuntime.getModel(model.provider, model.modelId);
		if (catalog === undefined) return { kind: "error", message: `Model is not in the configured catalog: ${model.provider}/${model.modelId}` };
		const effective = clampThinkingLevel(catalog, requested);
		return {
			kind: "ok",
			values: { model, thinkingLevel: effective, ...(selection === undefined ? {} : { selection: effectiveExecutionSelection(selection, effective) }), ...(effective === requested ? {} : { thinking: { requested, effective } }) },
		};
	};

	const initializeChildProfile = async (tx: Durable.Tx, conversationId: Durable.ConversationId, role: string | undefined): Promise<void> => {
		await initializeProfile(tx, conversationId, host.storageId);
		if (role === undefined) return;
		const profile = await tx.doc(ProfileDoc, conversationId);
		profile.role = profileText(role, "role");
		await refreshManagedInstructions(tx, conversationId);
	};

	const spawnLocalInCommit = async (
		tx: Durable.Tx,
		api: Durable.ToolExecutionApi<ControlDetails>,
		args: SpawnInput,
		cwd: string | undefined,
		parent: ChildAgentValues,
	): Promise<{ kind: "local"; child: LocalChild; deduped: boolean } | { kind: "error"; message: string }> => {
		const registry = await tx.doc(Children, api.conversationId);
		const existing = registry.children.find((child) => child.createdBy === api.taskId);
		if (existing !== undefined) {
			if (existing.conversationId === undefined || existing.anchorTaskId === undefined)
				return { kind: "error", message: "This call already created an agent in another storage." };
			return {
				kind: "local",
				child: { ...existing, conversationId: existing.conversationId, anchorTaskId: existing.anchorTaskId },
				deduped: true,
			};
		}
		const change: Durable.AgentChange = {
			model: parent.model,
			thinkingLevel: parent.thinkingLevel,
			...(cwd === undefined ? {} : { cwd }),
		};
		const child = { ...await createChild(tx, api.conversationId, args.name ?? "agent", api.taskId, change), ...selectionSnapshot(parent), ...(parent.thinking === undefined ? {} : { thinking: parent.thinking }) };
		const meta = await tx.doc(AgentMetaDoc, child.conversationId);
		meta.name = args.name ?? "agent";
		meta.owner = identity(api.conversationId);
		await initializeChildProfile(tx, child.conversationId, args.role);
		registry.children.push(child);
		if (args.prompt !== undefined) {
			const reporter = await tx.createTask(
				Reporter,
				reporterInput(child.name, child.conversationId, args.prompt, "followUp", undefined, checkInMinutes(child.selection?.values.checkInMinutes ?? args.checkInMinutes, "model", host.agentDir)),
				{ ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true },
			);
			registry.reporters[String(api.taskId)] = reporter;
		}
		return { kind: "local", child, deduped: false };
	};

	const retainedForeignSpawn = (child: AgentChild, sessionId: string, prompt: string | undefined): { kind: "foreign"; child: AgentChild; sessionId: string; deduped: boolean } | { kind: "error"; message: string } => {
		if (prompt !== undefined && child.result === undefined) return { kind: "error", message: "The retained prompted dispatch has no result reference" };
		return { kind: "foreign", child, sessionId, deduped: true };
	};

	type ForeignCreationOutcome = { kind: "foreign"; child: AgentChild; sessionId: string; deduped: boolean } | { kind: "error"; message: string };
	const retainForeignCreation = async (api: Durable.ToolExecutionApi<ControlDetails>, context: Context, args: SpawnInput, result: unknown): Promise<ForeignCreationOutcome> => {
		const sessionId = sessionIdOf(result);
		if (sessionId === undefined) return { kind: "error", message: "Host spawn returned no sessionId." };
		const thinking = (result as { thinking?: { requested: string; effective: string } }).thinking;
		let reference: ResultReference | undefined;
		try { reference = args.prompt === undefined ? undefined : admittedResult(sessionId, (result as Record<string, unknown>).result, `spawn:${host.storageId}:${api.taskId}`); }
		catch (error) { return { kind: "error", message: String(error) }; }
		if (args.prompt !== undefined) await retainDispatch(api, context, reference ?? null);
		const child = await api.commit(async (tx) => {
			const registry = await tx.doc(Children, api.conversationId);
			const added: AgentChild = {
				name: args.name ?? "agent",
				foreignSessionId: sessionId,
				...((result as { selection?: ExecutionSelection }).selection === undefined ? {} : { selection: (result as { selection: ExecutionSelection }).selection }),
				...(thinking === undefined ? {} : { thinking }),
				...(reference === undefined ? {} : { result: reference }),
				createdBy: api.taskId,
			};
			registry.children.push(added);
			return added;
		}, context);
		// The new agent has no identity before its creation, so its prompt has no record before the dispatch.
		if (reference?.requestId !== undefined) {
			const request = { sessionId: reference.sessionId, requestId: reference.requestId, replyTo: identity(api.conversationId) };
			await continuityFact(api, context, (tx) => recordAdmitted(tx, api.conversationId, request, reference));
		}
		return { kind: "foreign", child, sessionId, deduped: false };
	};

	/** Spawn in another storage through the host dispatch; the host owns the new storage process. */
	const spawnForeign = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		args: SpawnInput,
		cwd: string,
	): Promise<
		{ kind: "foreign"; child: AgentChild; sessionId: string; deduped: boolean } | { kind: "error"; message: string }
	> => {
		const known = (await api.snapshot(Children, api.conversationId, context))?.children.find(
			(child) => child.createdBy === api.taskId,
		);
		if (known?.foreignSessionId !== undefined) return retainedForeignSpawn(known, known.foreignSessionId, args.prompt);
		if (dispatch === undefined)
			return { kind: "error", message: "An agent with a different cwd needs the host dispatch callback." };
		let result: unknown;
		try {
			if (args.prompt !== undefined) await retainDispatch(api, context);
			result = await dispatch("spawn", {
				...args,
				preferenceSnapshot: await preferenceSnapshot(api, context),
				cwd,
				origin: "model",
				senderIdentity: identity(api.conversationId),
				requestId: `spawn:${host.storageId}:${api.taskId}`,
			});
		} catch (error) {
			return {
				kind: "error",
				message: `Spawn in ${cwd} failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		return retainForeignCreation(api, context, args, result);
	};

	const foreignSpawnResult = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		args: SpawnInput,
		cwd: string,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const outcome = await spawnForeign(api, context, args, cwd);
		if (outcome.kind === "error") return errorResult(outcome.message);
		return textResult(
			(outcome.deduped
				? `Reused the agent created by this call: ${outcome.child.name} (${outcome.sessionId}).`
				: `Spawned ${outcome.child.name} in ${cwd} as ${outcome.sessionId} with its own storage and host.${args.prompt === undefined ? "" : " The prompt was admitted and the answer will report back."}`) + (outcome.child.result === undefined ? "" : `\nResult: ${JSON.stringify(outcome.child.result)}`) + thinkingNotice(outcome.child),
			{ sessionId: outcome.sessionId, name: outcome.child.name, ...(outcome.child.selection === undefined ? {} : { selection: JSON.parse(JSON.stringify(outcome.child.selection)) }), ...thinkingFacts(outcome.child), ...(outcome.child.result === undefined ? {} : { result: outcome.child.result }) },
		);
	};

	const admissionOwner = async (api: Durable.ToolExecutionApi<ControlDetails>, context: Context): Promise<Durable.TaskId> => {
		const reporter = (await api.snapshot(Children, api.conversationId, context))?.reporters[String(api.taskId)];
		if (reporter === undefined) throw new Error("The prompted dispatch has no native admission owner");
		return reporter as Durable.TaskId;
	};

	const localSpawn = async (api: Durable.ToolExecutionApi<ControlDetails>, context: Context, args: SpawnInput, cwd: string | undefined): Promise<Awaited<ReturnType<typeof spawnLocalInCommit>>> => {
		const retained = (await api.snapshot(Children, api.conversationId, context))?.children.find((child) => child.createdBy === api.taskId);
		if (retained !== undefined) {
			if (retained.conversationId === undefined || retained.anchorTaskId === undefined) return { kind: "error", message: "This call already created an agent in another storage." };
			return { kind: "local", child: { ...retained, conversationId: retained.conversationId, anchorTaskId: retained.anchorTaskId }, deduped: true };
		}
		const selection = resolveExecutionPreset(await preferenceSnapshot(api, context), args, {}, { creation: true, role: args.role !== undefined, checkIn: args.prompt !== undefined });
		if (args.prompt !== undefined && selection.values.checkInMinutes === undefined) { selection.values.checkInMinutes = checkInMinutes(undefined, "model", host.agentDir); selection.origins.checkInMinutes = "default"; }
		if (selection.values.model === undefined || selection.values.thinkingLevel === undefined) throw new Error("Creation has no resolved model or thinking level");
		const parent = await resolveChildAgent(api, context, selection.values.model, selection.values.thinkingLevel as ModelThinkingLevel, selection);
		if (parent.kind === "error") return parent;
		return api.commit((tx) => spawnLocalInCommit(tx, api, args, cwd, parent.values), context);
	};

	const localSpawnResult = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		args: SpawnInput,
		cwd: string | undefined,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const outcome = await localSpawn(api, context, args, cwd);
		if (outcome.kind === "error") return errorResult(outcome.message);
		const child = outcome.child;
		const admission = args.prompt === undefined ? undefined : await admitLocal(api, context, await admissionOwner(api, context), reporterInput(child.name, child.conversationId, args.prompt, "followUp", undefined, checkInMinutes(child.selection?.values.checkInMinutes ?? args.checkInMinutes, "model", host.agentDir)), (error) => api.diagnostic({ severity: "error", message: String(error) }), Date.now());
		return textResult(
			(outcome.deduped
				? `Reused the agent created by this call: ${child.name} (${identity(child.conversationId)}).`
				: `Spawned ${child.name} as conversation ${identity(child.conversationId)} in your storage.${args.prompt === undefined ? "" : " The prompt was admitted and the answer will report back."}`) + (admission === undefined ? "" : `\nResult: ${JSON.stringify(admission.result)}${placementText(admission.placement)}`) + thinkingNotice(child),
			{ sessionId: identity(child.conversationId), conversationId: child.conversationId, name: child.name, anchorTaskId: child.anchorTaskId, ...selectionSnapshot(child), ...thinkingFacts(child), ...(admission === undefined ? {} : { result: admission.result, placement: admission.placement }) },
		);
	};

	const spawnTool = { ...durable.defineTool({
		name: "agent_spawn",
		description:
			"Create an agent conversation. The same cwd uses an owned conversation in this storage; a different cwd starts an agent in a new storage. Answers report back to you. Owner check-ins for an unanswered task run only when checkInMinutes, or the configured agent.checkInMinutes setting, names an interval; the default is 0. At a check-in, assess progress, let work continue, steer a wrap-up, or abort a hung tool; steering does not interrupt a running tool. Names may repeat.",
		parameters: presetParams(SpawnParams),
		replay: "safe",
		execute: async (args: SpawnInput, api, context) => {
			await rememberRunInputs(api, context);
			if (args.handle !== undefined) return dispatchControl("resolve-agent", { ...args, preferenceSnapshot: await preferenceSnapshot(api, context), origin: "model", senderIdentity: identity(api.conversationId), requestId: `resolve:${host.storageId}:${api.taskId}` }, "Handle resolution failed", { api, context });
			const hostCwd = resolve(host.cwd);
			const requestedCwd = args.cwd === undefined ? undefined : resolve(host.cwd, args.cwd);
			let sameCwd = requestedCwd === undefined || requestedCwd === hostCwd;
			if (requestedCwd !== undefined) {
				try {
					sameCwd = realpathSync(requestedCwd) === realpathSync(hostCwd);
				} catch {
					// Nonexistent paths retain the lexical placement decision.
				}
			}
			return !sameCwd && requestedCwd !== undefined
				? foreignSpawnResult(api, context, args, requestedCwd)
				: localSpawnResult(api, context, args, requestedCwd);
		},
	}) };

	const sendReporter = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		conversationId: Durable.ConversationId,
		name: string,
		message: string,
		whenBusy: "steer" | "followUp",
		reportTo?: Durable.ConversationId,
		minutes = 0,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const result = await api.commit(async (tx) => {
			const registry = await tx.doc(Children, api.conversationId);
			const key = String(api.taskId);
			const existing = registry.reporters[key];
			if (existing !== undefined) return { reporterTaskId: existing };
			const reporter = await tx.createTask(Reporter, reporterInput(name, conversationId, message, whenBusy, reportTo, minutes), {
				ownership: { kind: "conversation" },
				conversationId: api.conversationId,
				background: true,
			});
			registry.reporters[key] = reporter;
			return { reporterTaskId: reporter };
		}, context);
		const admission = await admitLocal(api, context, result.reporterTaskId as Durable.TaskId, reporterInput(name, conversationId, message, whenBusy, reportTo, minutes), (error) => api.diagnostic({ severity: "error", message: String(error) }), Date.now());
		return textResult(`Admitted to ${name}; the answer will report back. Result: ${JSON.stringify(admission.result)}${placementText(admission.placement)}`, {
			conversationId, submissionId: admission.result.submissionId, result: admission.result, placement: admission.placement,
		});
	};

	const sendForeign = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		sessionId: string,
		message: string,
		whenBusy: "steer" | "followUp",
		replyTo?: string,
		minutes = 0,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const senderIdentity = identity(api.conversationId);
		return dispatchControl(
			"submit",
			{
				sessionId,
				message,
				requestId: `agent-deliver:${host.storageId}:${api.taskId}`,
				ownerId: senderIdentity,
				senderIdentity,
				origin: "model",
				checkInMinutes: minutes,
				...(replyTo === undefined ? {} : { replyTo }),
				whenBusy,
			},
			`Delivery to ${sessionId} failed`,
			{ api, context },
		);
	};

	const sendLocal = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		sessionId: string,
		message: string,
		whenBusy: "steer" | "followUp",
		replyTo?: string,
		minutes = 0,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const conversationId = localConversation(sessionId, api.conversationId);
		if (conversationId === undefined) return errorResult(`Cannot resolve session ${sessionId}.`);
		let reportTo: Durable.ConversationId | undefined;
		if (replyTo !== undefined) {
			if (target(replyTo).kind === "foreign") return dispatchControl("task-submit", { sessionId, message, requester: identity(api.conversationId), replyTo, whenBusy, origin: "model", checkInMinutes: minutes, requestId: `agent-deliver:${host.storageId}:${api.taskId}` }, "Task delivery failed", { api, context });
			reportTo = localConversation(replyTo, api.conversationId);
			if (reportTo === undefined) return errorResult(`Cannot resolve reply target ${replyTo}.`);
		}
		const name = sessionId === host.storageId ? "root" : `conversation ${conversationId}`;
		return sendReporter(api, context, conversationId, name, message, whenBusy, reportTo, minutes);
	};

	const sendTarget = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		sessionId: string,
		message: string,
		whenBusy: "steer" | "followUp",
		replyTo?: string,
		minutes = 0,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		await rememberRunInputs(api, context);
		return target(sessionId).kind === "foreign"
			? sendForeign(api, context, sessionId, message, whenBusy, replyTo, minutes)
			: sendLocal(api, context, sessionId, message, whenBusy, replyTo, minutes);
	};

	/**
	 * Schedule one delivery through the host control. The host creates a timer
	 * task whose input fixes the deadline, message, mode, origin, and request
	 * ID, so a replayed call reuses the retained timer and a crash after the
	 * deadline admits the input at most once.
	 */
	/** A retained timer lists its input for the caller under the target's canonical identity. */
	const scheduledFact = async (api: Durable.ToolExecutionApi<ControlDetails>, context: Context, scheduled: Durable.ToolExecutionResult<ControlDetails>, requestId: string): Promise<void> => {
		const { identity: targetIdentity, timerId } = scheduled.details ?? {};
		if (scheduled.isError === true || typeof targetIdentity !== "string" || typeof timerId !== "number") return;
		await continuityFact(api, context, (tx) => recordScheduled(tx, api.conversationId, { sessionId: targetIdentity, requestId, replyTo: identity(api.conversationId) }, timerId));
	};
	const scheduleSend = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		args: SendInput,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		if (args.deliverAt === undefined) return errorResult("deliverAt is required for a scheduled input.");
		if (args.replyTo !== undefined) return errorResult("replyTo cannot be combined with deliverAt; the answer reports to this conversation.");
		let deadline: number;
		try {
			deadline = parseDeliverAt(args.deliverAt);
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
		if (args.mode === "report") return errorResult("Reports cannot be scheduled");
		const mode: TimerMode = args.mode ?? "followUp";
		const scheduleId = `timer:${host.storageId}:${api.taskId}`;
		const scheduled = await dispatchControl(
			"timer-schedule",
			{
				sessionId: args.sessionId,
				message: args.message,
				deliverAt: deadline,
				mode,
				checkInMinutes: checkInMinutes(args.checkInMinutes, "model", host.agentDir),
				origin: "model",
				ownerId: identity(api.conversationId),
				scheduleId,
				requestId: `${scheduleId}:delivery`,
			},
			`Scheduling an input for ${args.sessionId} failed`,
		);
		await scheduledFact(api, context, scheduled, `${scheduleId}:delivery`);
		return scheduled;
	};

	const sendTool = durable.defineTool({
		name: "agent_send",
		description:
			`Send a message to an agent conversation. A busy conversation receives it at its next tool boundary, the end of its current tool round; mode is the class of the message, not a placement time. ${FOLLOW_UP_DELIVERY_BOUNDARY} ${REPORT_DELIVERY_BOUNDARY} Reports request attention by default. For progress that asks for no action, set mode:'report',passive:true. Passive reports enter context at the next result or normal boundary. They do not wake the recipient. Keep questions, blockers, corrections and capacity interventions active. Send explicit instructions as followUp or steer, not passive reports. Task answers report back to you. With deliverAt, schedule the input instead of admitting it now. Owner check-ins for an unanswered task run only when checkInMinutes, or the configured agent.checkInMinutes setting, names an interval; the default is 0. At a check-in, assess progress, let work continue, steer a wrap-up, or abort a hung tool.`,
		parameters: SendParams,
		replay: "safe",
		execute: async (args: SendInput, api, context) => {
			if (args.passive !== undefined && args.mode !== "report") return errorResult("passive is valid only for report mode");
			if (args.mode === "report") {
				if (args.deliverAt !== undefined || args.replyTo !== undefined || args.checkInMinutes !== undefined) return errorResult("Report mode takes a recipient and message, not scheduling, replyTo, or check-ins");
				return dispatchControl("report", { sessionId: args.sessionId, senderIdentity: identity(api.conversationId), message: args.message, requestId: `report:${host.storageId}:${api.taskId}`, ...(args.passive === undefined ? {} : { passive: args.passive }) }, "Report delivery failed");
			}
			return args.deliverAt === undefined ? sendTarget(api, context, args.sessionId, args.message, args.mode ?? "followUp", args.replyTo, checkInMinutes(args.checkInMinutes, "model", host.agentDir)) : scheduleSend(api, context, args);
		},
	});

	const steerTool = durable.defineTool({
		name: "agent_steer",
		description:
			"Redirect a live agent conversation. The message is placed at its next tool boundary, the end of its current tool round, and corrects its current work; the answer reports back to you.",
		parameters: SteerParams,
		replay: "safe",
		execute: async (args: SteerInput, api, context) =>
			sendTarget(api, context, args.sessionId, args.message, "steer", args.replyTo),
	});

	const abortLocal = async (args: AbortInput, api: Durable.ToolExecutionApi<ControlDetails>, context: Context) => {
		const conversationId = localConversation(args.sessionId, api.conversationId);
		if (conversationId === undefined) return errorResult(`Cannot resolve session ${args.sessionId}.`);
		const includesCaller = await api.commit((tx) => abortScopeContains(tx, api.conversationId, conversationId, args.background === true), context);
		if (includesCaller) return errorResult("The target's abort scope includes the calling conversation.");
		if (args.release === true) return dispatchControl("release", { sessionId: identity(conversationId), ...(args.background === true ? { background: true } : {}) }, `Release of ${args.sessionId} failed`);
		const conversation = await api.conversation(conversationId, context);
		if (conversation === undefined) return errorResult(`Conversation ${conversationId} is not retained.`);
		await conversation.abort(context, args.background === true ? { background: true } : undefined);
		await api.commit((tx) => closeOpenWork(tx, host.storageId, conversationId, "stopped", api.now()), context);
		return textResult(`Aborted ${args.sessionId}.`, { conversationId });
	};

	const resolveAbortTarget = async (sessionId: string, context: Context): Promise<string> => {
		if (!dispatch) throw new Error("Target resolution is unavailable.");
		const resolved = await dispatch("resolve-target", { sessionId }, context);
		if (typeof resolved !== "string") throw new Error("Target resolution returned an invalid identity.");
		return resolved;
	};

	const abortResolved = async (args: AbortInput, api: Durable.ToolExecutionApi<ControlDetails>, context: Context) => {
		if (args.sessionId === identity(api.conversationId)) return errorResult("The target's abort scope includes the calling conversation.");
		let resolved: string;
		try { resolved = await resolveAbortTarget(args.sessionId, context); }
		catch (error) { return errorResult(`Target resolution failed: ${error instanceof Error ? error.message : String(error)}`); }
		if (target(resolved).kind !== "foreign") return abortLocal({ ...args, sessionId: resolved }, api, context);
		return dispatchControl(args.release === true ? "release" : "abort", { sessionId: resolved, ...(args.background === true ? { background: true } : {}) }, `Abort of ${resolved} failed`);
	};

	const abortTool = durable.defineTool({
		name: "agent_abort",
		description:
			"Stop a conversation's current work without deleting its transcript. With timerId, cancel only that scheduled input. With release, request host retirement after stopping; other work and timers remain. Background work survives unless background is true.",
		parameters: AbortParams,
		replay: "unsafe",
		execute: async (args: AbortInput, api, context) => {
			if (args.release === true && args.background === true) return errorResult("release cannot be combined with background; abort with background first, then release");
			if (args.timerId !== undefined && args.release === true) return errorResult("release cannot be combined with timerId");
			if (args.timerId !== undefined) {
				const timerId = args.timerId;
				const cancelled = await dispatchControl(
					"timer-cancel",
					{ sessionId: args.sessionId, timerId },
					`Cancellation of timer ${timerId} failed`,
				);
				// Only a cancellation before firing closes the scheduled request; a fired timer keeps its admitted input.
				// The receipt's identity selects the request: a receipt without one closes nothing.
				const resolved = cancelled.details?.identity;
				if (cancelled.isError !== true && cancelled.details?.status === "cancelled" && typeof resolved === "string")
					await continuityFact(api, context, (tx) => recordTimerCancelled(tx, api.conversationId, resolved, timerId));
				return cancelled;
			}
			return abortResolved(args, api, context);
		},
	});

	const forkInCommit = async (
		tx: Durable.Tx,
		api: Durable.ToolExecutionApi<ControlDetails>,
		source: Durable.ConversationId,
		at: Durable.EntryId,
		name: string,
		prompt: string | undefined,
		parent: ChildAgentValues,
	): Promise<{ kind: "child"; child: LocalChild; deduped: boolean } | { kind: "error"; message: string }> => {
		const registry = await tx.doc(Children, api.conversationId);
		const existing = registry.children.find((child) => child.createdBy === api.taskId);
		if (existing !== undefined) {
			if (existing.conversationId === undefined || existing.anchorTaskId === undefined)
				return { kind: "error", message: "This call already created an agent in another storage." };
			return {
				kind: "child",
				child: { ...existing, conversationId: existing.conversationId, anchorTaskId: existing.anchorTaskId },
				deduped: true,
			};
		}
		const anchor = await tx.createTask(Anchor, null, {
			ownership: { kind: "conversation" },
			conversationId: api.conversationId,
			background: true,
		});
		const forked = await tx.forkConversation(source, at, { ownership: { kind: "task", taskId: anchor } });
		await durable.configure(tx, forked.id, {
			model: parent.model,
			thinkingLevel: parent.thinkingLevel,
		});
		const meta = await tx.doc(AgentMetaDoc, forked.id);
		meta.name = name;
		meta.owner = identity(api.conversationId);
		await initializeProfile(tx, forked.id, host.storageId);
		const child: LocalChild = {
			name,
			conversationId: forked.id,
			anchorTaskId: anchor,
			createdBy: api.taskId,
		};
		registry.children.push(child);
		if (prompt !== undefined) {
			const reporter = await tx.createTask(Reporter, reporterInput(child.name, forked.id, prompt, "followUp"), {
				ownership: { kind: "conversation" },
				conversationId: api.conversationId,
				background: true,
			});
			registry.reporters[String(api.taskId)] = reporter;
		}
		return { kind: "child", child, deduped: false };
	};

	const forkTool = durable.defineTool({
		name: "agent_fork",
		description:
			"Create a conversation branch from one point of another conversation's history. The source is unchanged; the fork starts idle unless a prompt is given.",
		parameters: ForkParams,
		replay: "safe",
		execute: async (args: ForkInput, api, context) => {
			if (target(args.sessionId).kind === "foreign") {
				return dispatchControl(
					"fork",
					{
						sessionId: args.sessionId,
						...(args.entryId === undefined ? {} : { entryId: args.entryId }),
						requestId: `fork:${host.storageId}:${api.taskId}`,
					},
					`Fork of ${args.sessionId} failed`,
				);
			}
			const source = localConversation(args.sessionId, api.conversationId);
			if (source === undefined) return errorResult(`Cannot resolve session ${args.sessionId}.`);
			const parent = await resolveChildAgent(api, context);
			if (parent.kind === "error") return errorResult(parent.message);
			const result = await api.commit(async (tx) => {
				const at =
					args.entryId === undefined
						? (await tx.scanEntries({ conversationId: source }, 1)).items[0]?.id
						: entryIdOf(args.entryId);
				if (at === undefined)
					return { kind: "error", message: `Conversation ${source} has no visible entry to fork.` } as const;
				return forkInCommit(tx, api, source, at, args.name ?? "fork", args.prompt, parent.values);
			}, context);
			if (result.kind === "error") return errorResult(result.message);
			return textResult(`Forked ${args.sessionId} into ${result.child.name} (${result.child.conversationId}).`, {
				conversationId: result.child.conversationId,
				name: result.child.name,
			});
		},
	});

	const rewindTool = durable.defineTool({
		name: "agent_rewind",
		description:
			"Repair a wrong decision in a new conversation branch. It drops the named entry and its descendants and redoes the work under the correction. The source stays unchanged.",
		parameters: RewindParams,
		replay: "safe",
		execute: async (args: RewindInput, api, context) => {
			if (target(args.sessionId).kind === "foreign") {
				return dispatchControl(
					"rewind",
					{
						sessionId: args.sessionId,
						entryId: args.entryId,
						correction: args.correction,
						origin: "model",
						requestId: `rewind:${host.storageId}:${api.taskId}`,
					},
					`Rewind of ${args.sessionId} failed`,
				);
			}
			const source = localConversation(args.sessionId, api.conversationId);
			if (source === undefined) return errorResult(`Cannot resolve session ${args.sessionId}.`);
			const entry = entryIdOf(args.entryId);
			const parent = await resolveChildAgent(api, context);
			if (parent.kind === "error") return errorResult(parent.message);
			const result = await api.commit(async (tx) => {
				const page = await tx.scanEntries({ conversationId: source, maxEntryId: entry }, 2);
				if (page.items[0]?.id !== entry)
					return { kind: "error", message: `Entry ${entry} is not visible in conversation ${source}.` } as const;
				const predecessor = page.items[1];
				if (predecessor === undefined)
					return {
						kind: "error",
						message: `Entry ${entry} has no visible predecessor in conversation ${source}.`,
					} as const;
				return forkInCommit(
					tx,
					api,
					source,
					predecessor.id,
					args.name ?? "rewind",
					args.correction,
					parent.values,
				);
			}, context);
			if (result.kind === "error") return errorResult(result.message);
			return textResult(
				`Rewound ${args.sessionId} into ${result.child.name} (${result.child.conversationId}) under the correction.`,
				{
					conversationId: result.child.conversationId,
					name: result.child.name,
				},
			);
		},
	});

	/** Configure one conversation through the host outcome contract. */
	const dispatchConfigure = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		args: ConfigureInput,
		context: Context,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		if (resolvesToSelf(args.sessionId, api.conversationId))
			return errorResult("Cannot configure the calling conversation.");
		if (dispatch === undefined)
			return errorResult(
				`Configure of ${args.sessionId} failed: the host control is unavailable; this contribution has no dispatch callback.`,
			);
		try {
			const result = await dispatch("configure", {
				sessionId: args.sessionId,
				...defined(args, ["name", "model", "thinkingLevel", "preset"]),
				preferenceSnapshot: await preferenceSnapshot(api, context),
				senderIdentity: identity(api.conversationId),
				requestId: `configure:${host.storageId}:${api.taskId}`,
			});
			const parsed: unknown = JSON.parse(JSON.stringify(result ?? null));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
				return errorResult(`Configure of ${args.sessionId} failed: the host returned no configuration outcome.`);
			const structured = parsed as Record<string, JsonValue>;
			const failed = (structured as { outcome?: unknown }).outcome === "failed";
			return {
				output: [{ type: "text", text: controlText(structured) }],
				details: structured,
				...(failed ? { isError: true } : {}),
			};
		} catch (error) {
			return errorResult(
				`Configure of ${args.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const configureTool = durable.defineTool({
		name: "agent_configure",
		description:
			"Change a conversation's model, thinking level, or owner-visible name through the session host's outcome contract.",
		parameters: presetParams(ConfigureParams),
		replay: "unsafe",
		execute: async (args: ConfigureInput, api, context) => dispatchConfigure(api, args, context),
	});

	const compactTool = {
		...durable.defineTool({
			name: "agent_compact",
			description:
				`Compact a conversation. For the calling conversation the summary applies after the whole tool batch and the run continues; another conversation goes through the session host. The summarizer first receives this fixed text, then your instructions: ${NATIVE_COMPACTION_SEED}`,
			parameters: CompactParams,
			replay: "unsafe",
			execute: async (args: CompactInput, api, context) => {
				if (isSelfCompact(args.sessionId, api.conversationId)) {
					const input: Durable.CompactionInput = {
						reason: "manual",
						instructions: seededCompactionInstructions(args.instructions),
					};
					// The compaction is a child of this tool task. The tool task stays
					// `completing` until the summary entry is appended, so the generation
					// round finishes only after the whole batch and before the next request.
					const taskId = await api.commit(
						(tx) =>
							tx.createTask(durable.CompactionTask, input, {
								ownership: { kind: "task", taskId: api.taskId },
								conversationId: api.conversationId,
							}),
						context,
					);
					return textResult(
						"Self-compaction requested for the end of this tool batch. The summary applies after the whole batch, and this run continues. This receipt does not establish that compaction occurred.",
						{ taskId },
					);
				}
				const params: Record<string, unknown> = { sessionId: args.sessionId };
				if (args.instructions !== undefined) params.instructions = args.instructions;
				return hostControl("compact", params);
			},
		}),
		callers: ["model"] as const,
	};

	const commandTool = durable.defineTool({
		name: "agent_command",
		description: "Invoke a command registered with the session host by name against one conversation.",
		parameters: CommandParams,
		replay: "unsafe",
		execute: async (args: CommandInput, api) =>
			hostControl("command", {
				sessionId: args.sessionId,
				name: args.name,
				invocationId: `task:${api.taskId}`,
				origin: "model",
				...defined(args, ["args"]),
			}),
	});

	const publicStatus = (value: unknown): Durable.ToolExecutionResult<ControlDetails> => {
		const structured = structuredObservation(StatusToolOutputSchema, value) as Record<string, JsonValue>;
		return { ...nativeStructuredObservation(StatusToolOutputSchema, structured, controlText(structured)), details: structured };
	};

	const readStoragePage = async (args: StatusInput): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		let input = storageStatusPageInput(args);
		let result = await hostObservation("status", { ...input }, "Storage status failed", StatusToolOutputSchema);
		if (result.isError) return result;
		let projected = projectStorageStatus(result.details);
		while (projected.format === "refused" && projected.cause === "byte-limit" && input.limit > 1) {
			input = { ...input, limit: Math.ceil(input.limit / 2) };
			result = await hostObservation("status", { ...input }, "Storage status failed", StatusToolOutputSchema);
			if (result.isError) return result;
			projected = projectStorageStatus(result.details);
		}
		return publicStatus(projected);
	};

	const readStatus = async (args: StatusInput, api: Durable.ToolExecutionApi<ControlDetails>, context: Context, selection: FleetSelection) => {
		if (args.view === "fleet") {
			const created = await readCreatedAgents(api, Children, { storageId: host.storageId, conversationId: api.conversationId }, context);
			return fleetObservation(host.catalogRoot, args.sessionId, identity(api.conversationId), created, selection);
		}
		return hostObservation("status", defined(args, ["sessionId"]), `Status of ${args.sessionId ?? "the storage"} failed`, StatusToolOutputSchema);
	};

	const statusTool = {
		...durable.defineTool({
			name: "agent_status",
			description:
				"Read conversation state and tools through the host observation. Full selected Durable status lists bounded pending timers with IDs and deadlines. Full status for an ordinary primary returns presence and bounded latest-retained ancestry, not live idle or selected-branch state. Without a target, read compact state for this storage's conversations with explicit coverage. Fleet overviews use compact excerpts and summary coverage. For one storage, use view: storage-page with its exact storageId and call the tool named by coverage.next.tool with its remaining fields unchanged; this backend JSON cursor is separate from agent_list discovery. Default selected status is compact; use detail:true for full selected status.",
			parameters: StatusParams,
			replay: "safe",
			execute: async (args: StatusInput, api, context) => {
				let selection: FleetSelection;
				try {
					validateStatusSelectors(args);
					validateStatusDetail(args);
					if (args.view === "storage-page") { storageStatusPageInput(args); selection = {}; }
					else selection = validateFleetSelection(args);
				}
				catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
				if (args.view === "storage-page") return readStoragePage(args);
				const result = await readStatus(args, api, context, selection);
				if (result.isError || args.detail === true || args.view === "fleet") return result;
				const projected = args.sessionId === undefined ? projectStorageStatus(result.details) : projectSelectedStatus(result.details);
				return publicStatus(projected);
			},
		}),
		structuredOutputSchema: StatusToolOutputSchema,
	};

	const listTool = {
		...durable.defineTool({
			name: "agent_list",
			description: "Discover retained conversations through the session host's common observation.",
			parameters: ListParams,
			replay: "safe",
			execute: async (args: ListInput) =>
				hostObservation(
					"profile-list",
					{ global: true, ...defined(args, ["query", "cwd", "limit", "cursor"]) },
					"List of retained conversations failed",
					ProfiledListOutputSchema,
				),
		}),
		structuredOutputSchema: ProfiledListOutputSchema,
	};

	const inspectTool = {
		...durable.defineTool({
			name: "agent_inspect",
			description:
				"Read compact history or activity. Ordinary primary targets support activity/history over bounded latest-retained ancestry only, not the live selected branch. Durable targets include role/kind, readable text, named tool calls with argument summaries, and tool result excerpts. Truncation is marked. Use exact with entryId and offset 0 for retained redacted JSON; nextOffset continues it. Pass nextCursor as cursor. Branch remains raw. Result uses submissionId, a conversation-qualified native requestId, or the separate retained operationId. Missing results return unavailable; supplied selectors must agree. Result answerContinuation pages readable answer text; receiptGroup.next pages recipient references with receiptCursor. Follow each returned call unchanged. Images, signatures, and redacted thinking stay omitted.",
			parameters: InspectParams,
			replay: "safe",
			execute: async (args: InspectInput) => {
				if (args.receiptCursor !== undefined && args.view !== "result") return errorResult("receiptCursor selects only the result view");
				return hostObservation(
					"inspect",
					{
						view: args.view ?? "history",
						...defined(args, [
							"sessionId",
							"limit",
							"cursor",
							"entryId",
							"fromId",
							"offset",
							"query",
							"source",
							"submissionId",
							"requestId",
							"operationId",
							"receiptCursor",
						]),
					},
					`Inspect of ${args.sessionId ?? "the calling conversation"} failed`,
					InspectToolOutputSchema,
				);
			},
		}),
		structuredOutputSchema: InspectToolOutputSchema,
	};

	const attachTool = durable.defineTool({
		name: "agent_attach",
		description: "Reopen a stored conversation without starting work. An explicit model repairs its idle selection.",
		parameters: AttachParams,
		replay: "unsafe",
		execute: async (args: AttachInput) =>
			dispatchControl(
				"attach",
				{ sessionId: args.sessionId, ...defined(args, ["model", "thinkingLevel"]) },
				`Attach to ${args.sessionId} failed`,
			),
	});

	/** Resolve the shared area owner and retain exact prompted admission before returning. */
	const dispatchPlace = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		area: string,
		args: PlaceInput,
		context: Context,
	): Promise<{ kind: "ok"; sessionId: string; result: Record<string, JsonValue> } | { kind: "error"; message: string }> => {
		if (dispatch === undefined) return { kind: "error", message: "agent_place needs the host dispatch callback." };
		let result: unknown;
		try {
			result = await dispatchValue(dispatch, "place", {
				area,
				...defined(args, ["model", "thinkingLevel", "preset"]),
				preferenceSnapshot: await preferenceSnapshot(api, context),
				...(args.topic === undefined ? {} : { topic: args.topic }),
				...(args.prompt === undefined || args.prompt === "" ? {} : defined(args, ["prompt", "checkInMinutes"])),
				origin: "model",
				senderIdentity: identity(api.conversationId),
				requestId: `place:${host.storageId}:${api.taskId}`,
			}, { api, context });
		} catch (error) {
			return {
				kind: "error",
				message: `Place in ${area} failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const sessionId = sessionIdOf(result);
		return sessionId === undefined
			? { kind: "error", message: "Host place returned no sessionId." }
			: { kind: "ok", sessionId, result: JSON.parse(JSON.stringify(result)) as Record<string, JsonValue> };
	};

	const placeTool = durable.defineTool({
		name: "agent_place",
		description:
			"Resolve the durable owner of a directory through the session host's shared place registry. Create it on first use; reuse it when its retained context and ownership serve the task. A prompt starts work with automatic owner check-ins. checkInMinutes sets the interval; 0 disables.",
		parameters: presetParams(PlaceParams),
		replay: "safe",
		execute: async (args: PlaceInput, api, context) => {
			try {
				const retained = await retainedPlace({ api, context }, { requestId: `place:${host.storageId}:${api.taskId}` });
				if (retained !== undefined) return placeResult(retained.sessionId, retained.result, retained.area);
			} catch (error) {
				return errorResult(`Place replay failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const agent = await api.agent(context);
			const resolved = resolvePlaceArea(args.area ?? agent.cwd ?? host.cwd);
			if (resolved.kind === "error") return errorResult(resolved.message);
			const outcome = await dispatchPlace(api, resolved.area, args, context);
			if (outcome.kind === "error") return errorResult(outcome.message);
			return placeResult(outcome.sessionId, outcome.result, resolved.area);
		},
	});

	const resetTool = durable.defineTool({
		name: "agent_reset",
		description:
			"Reset one conversation's active context with an optional handoff. History, identity, files, settings, and timers stay. The write places at the next native boundary while the conversation is busy and starts no model turn.",
		parameters: ResetParams,
		replay: "safe",
		execute: async (args: ResetInput, api) =>
			dispatchControl(
				"reset",
				{
					sessionId: args.sessionId,
					...(args.handoff === undefined ? {} : { handoff: args.handoff }),
					requestId: `reset:${host.storageId}:${api.taskId}`,
				},
				`Reset of ${args.sessionId} failed`,
			),
	});

	const intentTool = durable.defineTool({
		name: "agent_intent",
		description: "Publish or clear this native conversation's purpose, integration intent, scope, carried operator direction and contact thread. Intent is a session claim, not verified authority or a lock. Returns the current published claim and bounded related efforts. No model wake.",
		parameters: IntentParams,
		replay: "safe",
		execute: async (args, api, context) => {
			validateIntentInput(args);
			if (host.catalogRoot === undefined || effortResources === undefined) return errorResult("Native intent requires the host's selected catalogue root");
			const agent = await api.agent(context);
			const location = await locations.resolve(agent.cwd ?? host.cwd);
			const stamp = await api.memo("agent-intent-time", new Date(api.now()).toISOString(), context);
			const { action, ...fields } = args;
			const claim = action === "clear" ? null : { ...fields, updatedAt: stamp } as import("./effort-presence.ts").PrimaryIntentClaim;
			const cwd = agent.cwd ?? host.cwd;
			const metadata = await api.commit(tx => publishConversationIntent(tx, api.conversationId, { claim, ...location, cwd, repository: location.repository ?? null, hostname: hostname(), startedAt: stamp, taskId: api.taskId }), context);
			const published = nativeIntentSelf(identity(api.conversationId), cwd, metadata);
			const value = { published, awareness: await readEffortAwareness(effortResources, published, "reported") };
			return textResult(JSON.stringify(value), JSON.parse(JSON.stringify(value)));
		},
	});

	const profileTool = { ...durable.defineTool({
		name: "agent_profile",
		description: "Read or revision-check an agent's durable role and sourced expertise. Default target: yourself. Profile edits work at a busy tool boundary and start no model turn. Saved expertise is evidence, not fresh authority.",
		parameters: ProfileParams,
		replay: "safe",
		execute: async (args, api) => hostObservation(args.action === "read" ? "profile-read" : "profile-update", { ...args, sessionId: args.sessionId ?? identity(api.conversationId), senderIdentity: identity(api.conversationId), requestId: `profile:${host.storageId}:${api.taskId}` }, "Profile operation failed", ProfileOutputSchema),
	}), structuredOutputSchema: ProfileOutputSchema };

	const collaborateTool = durable.defineTool({
		name: "agent_collaborate",
		description: "Discover, form and use shared purpose threads with full agent peers. Create preserves purpose, authority/source, restrictions, acceptance and integrator. Join or leave freely; post contribution or sourced carried-authority. Joining opts into passive notices at existing boundaries. Posts wake only explicit notify recipients. Read returns the frame, members and paged exchange. No automatic replies or check-ins.",
		parameters: CollaborationParams,
		replay: "safe",
		execute: async (args, api) => dispatchControl(
			args.action === "list" ? "collaboration-list" : args.action === "read" ? "collaboration-read" : "collaboration-mutate",
			{ ...args, senderIdentity: identity(api.conversationId), origin: "model", requestId: `collaboration:${host.storageId}:${api.taskId}` },
			"Collaboration request failed",
		),
	});

	const workTool = durable.defineTool({
		name: "agent_work",
		description: AGENT_WORK_DESCRIPTION,
		parameters: AgentWorkParams,
		replay: "safe",
		execute: async (args, api, context) => executeAgentWork(args, { harness: api, storageId: host.storageId, conversationId: api.conversationId, now: await api.memo("agent-work-time", api.now(), context) }, context),
	});

	const guidance = durable.section("agent-controls", (input) => {
		const selected = input.agent.tools.map((tool) => tool.name);
		const anyControl = selected.some((name) => (AGENT_CONTROL_TOOL_NAMES as readonly string[]).includes(name));
		if (!anyControl) return undefined;
		return [...SECTION_PREAMBLE, ...agentControlGuidanceLines(selected)].join("\n");
	});

	const preferences = durable.section("agent-preferences", () => renderAgentPreferences(readAgentPreferences(host.agentDir, host.services.modelRuntime)));

	const efforts = durable.section("agent-efforts", async (input, context) => {
		if (effortResources === undefined) return undefined;
		try {
			const meta = await input.read.snapshot(AgentMetaDoc, input.conversationId, context);
			const self = nativeIntentSelf(identity(input.conversationId), input.agent.cwd ?? host.cwd, meta === undefined ? null : meta.intent);
			return formatEffortAwareness(await readEffortAwareness(effortResources, self, "reported"), "prompt");
		} catch {
			return "Current effort and active thread awareness is unavailable. Read agent_status for a new bounded observation. Earlier notices describe changes, not current state.";
		}
	});

	return durable.defineExtension({
		name: "agent",
		tasks: [Anchor, Reporter, TimerTask],
		tools: [
			structuredControl(spawnTool, DispatchOutputSchema),
			structuredControl(workTool, AgentWorkOutputSchema),
			profileTool,
			intentTool,
			structuredControl(sendTool, DispatchOutputSchema),
			structuredControl(steerTool, DispatchOutputSchema),
			abortTool,
			forkTool,
			rewindTool,
			configureTool,
			compactTool,
			commandTool,
			statusTool,
			listTool,
			inspectTool,
			attachTool,
			placeTool,
			resetTool,
			collaborateTool,
		].map(exposedControl),
		sections: [guidance, efforts, preferences],
	});
}
