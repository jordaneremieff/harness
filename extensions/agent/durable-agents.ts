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
 * task of the owner conversation. Messages and answers travel through reporter
 * tasks: one reporter delivers one message, waits for its answer, and reports
 * the answer into the owner conversation. Request IDs and a durable child
 * registry make a replay or a reopen deliver one message and one report.
 *
 * Controls the host owns (common observation, compaction, commands, foreign
 * storages) run through the injected dispatch callback. Spawning never uses
 * that callback: a child is an owned conversation in the calling storage.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { AGENT_CONTROL_TOOL_NAMES, agentControlGuidanceLines } from "./control-guidance.ts";
import { parseDeliverAt, TimerTask, type TimerMode } from "./durable-timers.ts";
import type { DurableCommand, DurableCommandCall } from "./durable-services.ts";
import {
	InspectOutputSchema,
	ListOutputSchema,
	StatusOutputSchema,
	structuredObservation,
} from "./observation-schema.ts";

// ─── Contribution contract ──────────────────────────────────────────────────

/** Runtime request methods the agent-session host serves for this contribution. */
export type AgentControlMethod =
	| "submit"
	| "spawn"
	| "place"
	| "inspect"
	| "status"
	| "list"
	| "fork"
	| "rewind"
	| "abort"
	| "compact"
	| "configure"
	| "attach"
	| "command"
	| "receipts"
	| "acknowledge"
	| "reset"
	| "timer-schedule"
	| "timer-list"
	| "timer-cancel";

/** One host control call. The host returns a structured result the tool formats for the model. */
export type AgentControlDispatch = (
	method: AgentControlMethod,
	params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/** Version of the in-process control binding between one host runtime and the contributions it installs. */
export const AGENT_CONTROL_BINDING_VERSION = 1;

/** Process-global key shared by a host runtime and every contribution it installs. */
export const AGENT_CONTROL_BINDING_KEY = Symbol.for("pi.agent.durable.controls");

/** One versioned runtime dispatch bound for the lifetime of an installed contribution. */
export interface AgentControlBinding {
	readonly version: number;
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
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0)
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
	/** Working directory this storage serves. One storage serves one cwd. */
	readonly cwd: string;
	/** Pi's model runtime, read-only; used to clamp a requested thinking level. */
	readonly services: {
		readonly modelRuntime: {
			getModel(provider: string, modelId: string): Model<Api> | undefined;
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
	/** Absolute path of the emitting extension entrypoint, for example `fileURLToPath(import.meta.url)`. */
	readonly source: string;
	/** Host control dispatch; absent features report an explicit error result. */
	readonly dispatch?: AgentControlDispatch;
	/** Commands the host registry exposes to `agent_command` and other controls. */
	readonly commands?: readonly AgentCommand[];
}

/** Effective model and thinking level a new child conversation must store explicitly. */
type ChildAgentValues = {
	readonly model: Durable.ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
};

// ─── Durable documents ──────────────────────────────────────────────────────

/** One child agent conversation, created by one tool task of the owner conversation. */
type AgentChild = {
	readonly name: string;
	/** Local child conversation when the child lives in this storage. */
	readonly conversationId?: Durable.ConversationId;
	readonly anchorTaskId?: Durable.TaskId;
	/** External identity of a child in another storage. */
	readonly foreignSessionId?: string;
	/** Tool task that created the child; a rerun of that task reuses this record. */
	readonly createdBy: Durable.TaskId;
	/** Answer entries already reported to the owner; several messages can end in one answer. */
	reported: Durable.EntryId[];
};

/** Child record with its local conversation and anchor present. */
type LocalChild = AgentChild & {
	readonly conversationId: Durable.ConversationId;
	readonly anchorTaskId: Durable.TaskId;
};

type AgentChildrenState = {
	children: AgentChild[];
	/** Reporter task by the tool task that created it; a rerun of that task reuses the reporter. */
	reporters: Record<string, number>;
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

// ─── Shared helpers ─────────────────────────────────────────────────────────

type ControlDetails = { structuredContent: Record<string, JsonValue> };

function textResult(
	text: string,
	structuredContent: Record<string, JsonValue> = {},
): Durable.ToolExecutionResult<ControlDetails> {
	return { content: [{ type: "text", text }], details: { structuredContent } };
}

function errorResult(
	text: string,
	structuredContent: Record<string, JsonValue> = {},
): Durable.ToolExecutionResult<ControlDetails> {
	return { content: [{ type: "text", text }], isError: true, details: { structuredContent } };
}

/** Render a host control result for the model without losing structure. */
function controlText(value: unknown): string {
	if (value === undefined) return "Host control completed without a result.";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return "Host control returned a result that cannot be printed.";
	}
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

function messageText(messages: readonly Message[] | undefined): string {
	if (messages === undefined) return "";
	return messages
		.flatMap((message) => {
			const content = message.content;
			if (typeof content === "string") return [content];
			return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		})
		.join("");
}

function modelOf(value: string): Durable.ModelRef {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1)
		throw new Error(`model must be "provider/model", received ${value}`);
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

// ─── Parameter schemas ──────────────────────────────────────────────────────

const StringEnum = <T extends readonly string[]>(values: T) => Type.Union(values.map((value) => Type.Literal(value)));

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SpawnParams = Type.Object(
	{
		prompt: Type.Optional(
			Type.String({ description: "Initial assignment for the child. Without one the child stays idle." }),
		),
		name: Type.Optional(Type.String({ description: "Display name for the child. Names may repeat." })),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the child. Default: inherited from the owner." }),
		),
		model: Type.Optional(
			Type.String({ minLength: 3, description: 'Exact provider/model, for example "anthropic/claude-sonnet".' }),
		),
		thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
	},
	{ additionalProperties: false },
);

const SendParams = Type.Object(
	{
		sessionId: Type.String({
			minLength: 1,
			description: "External identity: storage id for the root, storageId:conversationId otherwise.",
		}),
		message: Type.String({ minLength: 1 }),
		replyTo: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Conversation that receives the answer; default: the calling conversation.",
			}),
		),
		deliverAt: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Absolute ISO 8601 date-time; schedule the input instead of admitting it now.",
			}),
		),
		mode: Type.Optional(
			StringEnum(["followUp", "steer"]),
		),
	},
	{ additionalProperties: false },
);

const SteerParams = Type.Object(
	{
		sessionId: Type.String({
			minLength: 1,
			description: "External identity: storage id for the root, storageId:conversationId otherwise.",
		}),
		message: Type.String({ minLength: 1 }),
		replyTo: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Conversation that receives the answer; default: the calling conversation.",
			}),
		),
	},
	{ additionalProperties: false },
);

const AbortParams = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		background: Type.Optional(
			Type.Boolean({ description: "Also stop background work such as anchors and reporters." }),
		),
		timerId: Type.Optional(
			Type.Integer({ minimum: 1, description: "Timer ID from agent_status; cancels only that scheduled input." }),
		),
	},
	{ additionalProperties: false },
);

const ForkParams = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		entryId: Type.Optional(Type.String({ description: "Fork point; default: the newest visible entry." })),
		name: Type.Optional(Type.String()),
		prompt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const RewindParams = Type.Object(
	{
		sessionId: Type.String({ minLength: 1, description: "Conversation that took the wrong turn." }),
		entryId: Type.String({
			minLength: 1,
			description: "Entry that carries the wrong decision. It and everything after it are dropped.",
		}),
		correction: Type.String({ minLength: 1 }),
		name: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const ConfigureParams = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		name: Type.Optional(Type.String({ description: "Owner-visible name; stored by the session host." })),
		model: Type.Optional(
			Type.String({ minLength: 3, description: 'Exact provider/model, for example "anthropic/claude-sonnet".' }),
		),
		thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
	},
	{ additionalProperties: false },
);

const CompactParams = Type.Object(
	{
		sessionId: Type.Optional(Type.String({ minLength: 1, description: "Default: the calling conversation." })),
		instructions: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const CommandParams = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		args: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const StatusParams = Type.Object(
	{
		sessionId: Type.Optional(
			Type.String({ minLength: 1, description: "Default: the calling conversation; omit for the storage overview." }),
		),
	},
	{ additionalProperties: false },
);

const ListParams = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				description: "Case-insensitive literal in stored ID, cwd, name, or first user text.",
			}),
		),
		cwd: Type.Optional(
			Type.String({ minLength: 1, maxLength: 4096, description: "Exact absolute working directory filter." }),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
	},
	{ additionalProperties: false },
);

/** A positive native record ID in the number or numeric-string form the host accepts. */
const PositiveId = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^[0-9]+$" })]);

const InspectParams = Type.Object(
	{
		sessionId: Type.Optional(Type.String({ minLength: 1, description: "Default: the calling conversation." })),
		view: Type.Optional(StringEnum(["activity", "history", "branch", "search", "exact", "result"])),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
		cursor: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "Opaque cursor object returned as next by a previous inspect page.",
			}),
		),
		entryId: Type.Optional(PositiveId),
		fromId: Type.Optional(PositiveId),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		query: Type.Optional(Type.String({ minLength: 1 })),
		source: Type.Optional(StringEnum(["user", "assistant", "toolResult", "summary", "custom"])),
		submissionId: Type.Optional(PositiveId),
		operationId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const AttachParams = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		model: Type.Optional(Type.String({ minLength: 3 })),
		thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
	},
	{ additionalProperties: false },
);

const PlaceParams = Type.Object(
	{
		area: Type.Optional(
			Type.String({ description: "Directory the owner covers. Default: the calling conversation's cwd." }),
		),
		topic: Type.Optional(Type.String({ description: "What the owner is for; stored as its name." })),
		prompt: Type.Optional(Type.String({ description: "Work to deliver to the owner." })),
	},
	{ additionalProperties: false },
);

const ResetParams = Type.Object(
	{
		sessionId: Type.String({
			minLength: 1,
			description: "Conversation to reset: storage id for the root, storageId:conversationId otherwise.",
		}),
		handoff: Type.Optional(
			Type.String({ description: "Operator-authored text for the new context; absent starts it without a message." }),
		),
	},
	{ additionalProperties: false },
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
	"A child's answer arrives as a report in its owner conversation, prefixed [agent <name> ...].",
];

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
			return buildExtension(host, options);
		},
	};
}

function buildExtension(host: AgentContributionHost, options: AgentContributionOptions): Durable.Extension {
	const durable = host.durable;
	const dispatch = options.dispatch;

	/** Resolve an external identity against this storage. */
	const target = (
		sessionId: string | undefined,
	):
		| { kind: "self" }
		| { kind: "root" }
		| { kind: "local"; conversationId: Durable.ConversationId }
		| { kind: "foreign" } => {
		if (sessionId === undefined) return { kind: "self" };
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
			return { content: [{ type: "text", text: controlText(structured) }], details: { structuredContent: structured } };
		} catch (error) {
			return errorResult(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** Forward one control to the host dispatch and format its structured result. */
	const dispatchControl = async (
		method: AgentControlMethod,
		params: Readonly<Record<string, unknown>>,
		failure: string,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		if (dispatch === undefined) return errorResult(`${failure}: no dispatch callback.`);
		try {
			return textResult(controlText(await dispatch(method, params)));
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

	const Children = durable.defineDoc<AgentChildrenState>({
		kind: "agent.children",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		initial: () => ({ children: [], reporters: {} }),
	});

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
		/** Conversation that receives the answer; absent: the reporter's conversation. */
		reportTo?: Durable.ConversationId;
	};
	type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

	const reporterInput = (
		name: string,
		conversationId: Durable.ConversationId,
		message: string,
		whenBusy: "steer" | "followUp",
		reportTo?: Durable.ConversationId,
	): ReporterInput => ({
		name,
		conversationId,
		message,
		whenBusy,
		...(reportTo === undefined ? {} : { reportTo }),
	});

	/** Decide what, if anything, one settled delivery reports. */
	const reportFor = async (
		tx: Durable.Tx,
		name: string,
		conversationId: Durable.ConversationId,
		ownerConversationId: Durable.ConversationId,
		settled: Durable.SettledSubmissionRecord,
	): Promise<ReporterState> => {
		const next = (report?: string): ReporterState => ({ phase: "report", report });
		if (settled.status === "unanswered") {
			return next(settled.reason === "aborted" ? undefined : `[agent ${name} failed: ${settled.reason}]`);
		}
		if (settled.type !== "input") return next(`[agent ${name} failed: unexpected settlement]`);
		const registry = await tx.doc(Children, ownerConversationId);
		const record = registry.children.find((child) => child.conversationId === conversationId);
		if (record?.reported.includes(settled.answer) === true) return next();
		record?.reported.push(settled.answer);
		const answer = await tx.entry(durable.AssistantEntry, settled.answer);
		const text = messageText(answer?.model);
		return next(`[agent ${name} answered] ${text === "" ? "(no text)" : text}`);
	};

	const Reporter = durable.defineTask<ReporterInput, ReporterState, null>({
		name: "agent.reporter",
		version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			// Deliver one message, wait for its answer, and decide the report. One
			// commit records the answer as reported, so a restart does not decide twice.
			deliver: async (reporter, runtime, context) => {
				const { name, conversationId, message, whenBusy } = reporter.input;
				const child = await runtime.conversation(conversationId, context);
				if (child === undefined) {
					const checkpoint: ReporterState = {
						phase: "report",
						report: `[agent ${name} failed: its conversation is missing]`,
					};
					await runtime.commit(() => ({ status: "running", checkpoint }), context);
					return;
				}
				const submission = await child.submit(
					{ type: "input", content: message, whenBusy, requestId: `agent-deliver:${reporter.id}` },
					context,
				);
				const settled = await submission.wait(context);
				await runtime.commit(
					async (tx) => ({
						status: "running",
						checkpoint: await reportFor(tx, name, conversationId, runtime.conversationId, settled),
					}),
					context,
				);
			},
			// Post the report as a follow-up input. It starts a turn when the owner is
			// idle, or waits for the owner's current answer.
			report: async (reporter, runtime, context) => {
				const report = reporter.state.checkpoint.report;
				if (report !== undefined) {
					const destination = reporter.input.reportTo ?? runtime.conversationId;
					const owner = await runtime.conversation(destination, context);
					if (owner !== undefined) {
						await owner.submit(
							{ type: "input", content: report, whenBusy: "followUp", requestId: `agent-report:${reporter.id}` },
							context,
						);
					}
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
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
			reported: [],
		};
		return record;
	};

	/** Resolve the effective agent values a new child must store explicitly. */
	const resolveChildAgent = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		modelOverride?: string,
		thinkingLevelOverride?: ModelThinkingLevel,
	): Promise<{ kind: "ok"; values: ChildAgentValues } | { kind: "error"; message: string }> => {
		const parent = await api.agent(context);
		const model = modelOverride === undefined ? parent.model : modelOf(modelOverride);
		if (model === undefined) return { kind: "error", message: "The owner conversation has no model configured." };
		const requested = thinkingLevelOverride ?? parent.thinkingLevel;
		const catalog = host.services.modelRuntime.getModel(model.provider, model.modelId);
		return {
			kind: "ok",
			values: { model, thinkingLevel: catalog === undefined ? requested : clampThinkingLevel(catalog, requested) },
		};
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
				return { kind: "error", message: "This call already created a child in another storage." };
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
			instructions: `You are the child agent${args.name === undefined ? "" : ` "${args.name}"`} of owner ${host.storageId}:${api.conversationId}. Answer the owner's requests. Your answers are reported to the owner.`,
		};
		const child = await createChild(tx, api.conversationId, args.name ?? "child", api.taskId, change);
		registry.children.push(child);
		if (args.prompt !== undefined) {
			const reporter = await tx.createTask(
				Reporter,
				reporterInput(child.name, child.conversationId, args.prompt, "steer"),
				{ ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true },
			);
			registry.reporters[String(api.taskId)] = reporter;
		}
		return { kind: "local", child, deduped: false };
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
		if (known?.foreignSessionId !== undefined)
			return { kind: "foreign", child: known, sessionId: known.foreignSessionId, deduped: true };
		if (dispatch === undefined)
			return { kind: "error", message: "A child with a different cwd needs the host dispatch callback." };
		let result: unknown;
		try {
			result = await dispatch("spawn", {
				...args,
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
		const sessionId = sessionIdOf(result);
		if (sessionId === undefined) return { kind: "error", message: "Host spawn returned no sessionId." };
		const child = await api.commit(async (tx) => {
			const registry = await tx.doc(Children, api.conversationId);
			const added: AgentChild = {
				name: args.name ?? "child",
				foreignSessionId: sessionId,
				createdBy: api.taskId,
				reported: [],
			};
			registry.children.push(added);
			return added;
		}, context);
		return { kind: "foreign", child, sessionId, deduped: false };
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
			outcome.deduped
				? `Reused the child created by this call: ${outcome.child.name} (${outcome.sessionId}).`
				: `Spawned ${outcome.child.name} in ${cwd} as ${outcome.sessionId}.${args.prompt === undefined ? "" : " The prompt was delivered and the answer will report back."}`,
			{ sessionId: outcome.sessionId, name: outcome.child.name },
		);
	};

	const localSpawnResult = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		args: SpawnInput,
		cwd: string | undefined,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const parent = await resolveChildAgent(api, context, args.model, args.thinkingLevel);
		if (parent.kind === "error") return errorResult(parent.message);
		const outcome = await api.commit((tx) => spawnLocalInCommit(tx, api, args, cwd, parent.values), context);
		if (outcome.kind === "error") return errorResult(outcome.message);
		const child = outcome.child;
		return textResult(
			outcome.deduped
				? `Reused the child created by this call: ${child.name} (${child.conversationId}).`
				: `Spawned ${child.name} as conversation ${child.conversationId}.${args.prompt === undefined ? "" : " The prompt was delivered and the answer will report back."}`,
			{ conversationId: child.conversationId, name: child.name, anchorTaskId: child.anchorTaskId },
		);
	};

	const spawnTool = durable.defineTool({
		name: "agent_spawn",
		description:
			"Create a child agent conversation. The same cwd uses an owned conversation in this storage; a different cwd starts a child in a new storage owned by you. Answers report back to you. Names may repeat.",
		parameters: SpawnParams,
		replay: "safe",
		execute: async (args: SpawnInput, api, context) => {
			const hostCwd = resolve(host.cwd);
			const requestedCwd = args.cwd === undefined ? undefined : resolve(host.cwd, args.cwd);
			return requestedCwd !== undefined && requestedCwd !== hostCwd
				? foreignSpawnResult(api, context, args, requestedCwd)
				: localSpawnResult(api, context, args, requestedCwd);
		},
	});

	const sendReporter = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		conversationId: Durable.ConversationId,
		name: string,
		message: string,
		whenBusy: "steer" | "followUp",
		reportTo?: Durable.ConversationId,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const result = await api.commit(async (tx) => {
			const registry = await tx.doc(Children, api.conversationId);
			const key = String(api.taskId);
			const existing = registry.reporters[key];
			if (existing !== undefined) return { reporterTaskId: existing };
			const reporter = await tx.createTask(Reporter, reporterInput(name, conversationId, message, whenBusy, reportTo), {
				ownership: { kind: "conversation" },
				conversationId: api.conversationId,
				background: true,
			});
			registry.reporters[key] = reporter;
			return { reporterTaskId: reporter };
		}, context);
		return textResult(`Delivered to ${name}; the answer will report back.`, {
			reporterTaskId: result.reporterTaskId,
			conversationId,
		});
	};

	const sendForeign = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		sessionId: string,
		message: string,
		whenBusy: "steer" | "followUp",
		replyTo?: string,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const senderIdentity = `${host.storageId}:${api.conversationId}`;
		return dispatchControl(
			"submit",
			{
				sessionId,
				message,
				requestId: `agent-deliver:${api.taskId}`,
				ownerId: senderIdentity,
				senderIdentity,
				origin: "model",
				...(replyTo === undefined ? {} : { replyTo }),
				whenBusy,
			},
			`Delivery to ${sessionId} failed`,
		);
	};

	const sendLocal = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		sessionId: string,
		message: string,
		whenBusy: "steer" | "followUp",
		replyTo?: string,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> => {
		const conversationId = localConversation(sessionId, api.conversationId);
		if (conversationId === undefined) return errorResult(`Cannot resolve session ${sessionId}.`);
		let reportTo: Durable.ConversationId | undefined;
		if (replyTo !== undefined) {
			if (target(replyTo).kind === "foreign")
				return errorResult(`Cannot report to foreign session ${replyTo} from this storage.`);
			reportTo = localConversation(replyTo, api.conversationId);
			if (reportTo === undefined) return errorResult(`Cannot resolve reply target ${replyTo}.`);
		}
		const name = sessionId === host.storageId ? "root" : `conversation ${conversationId}`;
		return sendReporter(api, context, conversationId, name, message, whenBusy, reportTo);
	};

	const sendTarget = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		context: Context,
		sessionId: string,
		message: string,
		whenBusy: "steer" | "followUp",
		replyTo?: string,
	): Promise<Durable.ToolExecutionResult<ControlDetails>> =>
		target(sessionId).kind === "foreign"
			? sendForeign(api, sessionId, message, whenBusy, replyTo)
			: sendLocal(api, context, sessionId, message, whenBusy, replyTo);

	/**
	 * Schedule one delivery through the host control. The host creates a timer
	 * task whose input fixes the deadline, message, mode, origin, and request
	 * ID, so a replayed call reuses the pending timer and a crash after the
	 * deadline admits the input at most once.
	 */
	const scheduleSend = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
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
		const mode: TimerMode = args.mode ?? "followUp";
		const scheduleId = `timer:${host.storageId}:${api.taskId}`;
		return dispatchControl(
			"timer-schedule",
			{
				sessionId: args.sessionId,
				message: args.message,
				deliverAt: deadline,
				mode,
				origin: "model",
				ownerId: identity(api.conversationId),
				scheduleId,
				requestId: `${scheduleId}:delivery`,
			},
			`Scheduling an input for ${args.sessionId} failed`,
		);
	};

	const sendTool = durable.defineTool({
		name: "agent_send",
		description:
			"Send a message to an agent conversation. A busy conversation receives it after its current answer; the answer reports back to you. With deliverAt, schedule the input instead of admitting it now.",
		parameters: SendParams,
		replay: "safe",
		execute: async (args: SendInput, api, context) =>
			args.deliverAt === undefined
				? sendTarget(api, context, args.sessionId, args.message, "followUp", args.replyTo)
				: scheduleSend(api, args),
	});

	const steerTool = durable.defineTool({
		name: "agent_steer",
		description:
			"Redirect a live agent conversation. The message reaches it at its next step; the answer reports back to you.",
		parameters: SteerParams,
		replay: "safe",
		execute: async (args: SteerInput, api, context) =>
			sendTarget(api, context, args.sessionId, args.message, "steer", args.replyTo),
	});

	const abortTool = durable.defineTool({
		name: "agent_abort",
		description:
			"Stop a conversation's current work without deleting its transcript. With timerId, cancel only that scheduled input from agent_status. Background work such as anchors and reporters survives unless background is true.",
		parameters: AbortParams,
		replay: "unsafe",
		execute: async (args: AbortInput, api, context) => {
			if (args.timerId !== undefined) {
				return dispatchControl(
					"timer-cancel",
					{ sessionId: args.sessionId, timerId: args.timerId },
					`Cancellation of timer ${args.timerId} failed`,
				);
			}
			if (target(args.sessionId).kind === "foreign") {
				return dispatchControl(
					"abort",
					{ sessionId: args.sessionId, ...(args.background === true ? { background: true } : {}) },
					`Abort of ${args.sessionId} failed`,
				);
			}
			const conversationId = localConversation(args.sessionId, api.conversationId);
			if (conversationId === undefined) return errorResult(`Cannot resolve session ${args.sessionId}.`);
			if (conversationId === api.conversationId) return errorResult("Cannot abort the calling conversation.");
			const conversation = await api.conversation(conversationId, context);
			if (conversation === undefined) return errorResult(`Conversation ${conversationId} is not retained.`);
			await conversation.abort(context, args.background === true ? { background: true } : undefined);
			return textResult(`Aborted ${args.sessionId}.`, { conversationId });
		},
	});

	const forkInCommit = async (
		tx: Durable.Tx,
		api: Durable.ToolExecutionApi<ControlDetails>,
		source: Durable.ConversationId,
		at: Durable.EntryId,
		name: string,
		instructions: string,
		prompt: string | undefined,
		parent: ChildAgentValues,
	): Promise<{ kind: "child"; child: LocalChild; deduped: boolean } | { kind: "error"; message: string }> => {
		const registry = await tx.doc(Children, api.conversationId);
		const existing = registry.children.find((child) => child.createdBy === api.taskId);
		if (existing !== undefined) {
			if (existing.conversationId === undefined || existing.anchorTaskId === undefined)
				return { kind: "error", message: "This call already created a child in another storage." };
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
			instructions,
		});
		const child: LocalChild = {
			name,
			conversationId: forked.id,
			anchorTaskId: anchor,
			createdBy: api.taskId,
			reported: [],
		};
		registry.children.push(child);
		if (prompt !== undefined) {
			const reporter = await tx.createTask(Reporter, reporterInput(child.name, forked.id, prompt, "steer"), {
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
			"Create a child conversation from one point of another conversation's history. The source is unchanged; the fork starts idle unless a prompt is given.",
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
			const instructions = `You are the child agent${args.name === undefined ? "" : ` "${args.name}"`} of owner ${host.storageId}:${api.conversationId}. Continue from this fork's history. Your answers are reported to the owner.`;
			const parent = await resolveChildAgent(api, context);
			if (parent.kind === "error") return errorResult(parent.message);
			const result = await api.commit(async (tx) => {
				const at =
					args.entryId === undefined
						? (await tx.scanEntries({ conversationId: source }, 1)).items[0]?.id
						: entryIdOf(args.entryId);
				if (at === undefined)
					return { kind: "error", message: `Conversation ${source} has no visible entry to fork.` } as const;
				return forkInCommit(tx, api, source, at, args.name ?? "fork", instructions, args.prompt, parent.values);
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
			"Repair a wrong decision in a new child conversation. It drops the named entry and its descendants and redoes the work under the correction. The source stays unchanged.",
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
			const instructions = `You are the child agent${args.name === undefined ? "" : ` "${args.name}"`} of owner ${host.storageId}:${api.conversationId}. The entry ${entry} and its descendants were dropped; continue under the correction. Your answers are reported to the owner.`;
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
					instructions,
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
				...defined(args, ["name", "model", "thinkingLevel"]),
				senderIdentity: identity(api.conversationId),
				requestId: `configure:${host.storageId}:${api.taskId}`,
			});
			const parsed: unknown = JSON.parse(JSON.stringify(result ?? null));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
				return errorResult(`Configure of ${args.sessionId} failed: the host returned no configuration outcome.`);
			const structured = parsed as Record<string, JsonValue>;
			const failed = (structured as { outcome?: unknown }).outcome === "failed";
			return {
				content: [{ type: "text", text: controlText(structured) }],
				details: { structuredContent: structured },
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
		parameters: ConfigureParams,
		replay: "unsafe",
		execute: async (args: ConfigureInput, api) => dispatchConfigure(api, args),
	});

	const compactTool = {
		...durable.defineTool({
			name: "agent_compact",
			description:
				"Compact a conversation. For the calling conversation the summary applies after the whole tool batch and the run continues; another conversation goes through the session host.",
			parameters: CompactParams,
			replay: "unsafe",
			execute: async (args: CompactInput, api, context) => {
				if (isSelfCompact(args.sessionId, api.conversationId)) {
					const input: Durable.CompactionInput = {
						reason: "manual",
						...(args.instructions === undefined ? {} : { instructions: args.instructions }),
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
		exposure: "model-only",
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
				...defined(args, ["args"]),
			}),
	});

	const statusTool = {
		...durable.defineTool({
			name: "agent_status",
			description:
				"Inspect conversation state and tools through the session host's common observation. A selected session lists its bounded pending scheduled inputs with timer ID and deadline. Without a target, report the storage overview.",
			parameters: StatusParams,
			replay: "safe",
			execute: async (args: StatusInput) =>
				hostObservation(
					"status",
					defined(args, ["sessionId"]),
					`Status of ${args.sessionId ?? "the storage"} failed`,
					StatusOutputSchema,
				),
		}),
		outputSchema: StatusOutputSchema,
	};

	const listTool = {
		...durable.defineTool({
			name: "agent_list",
			description: "Discover retained conversations through the session host's common observation.",
			parameters: ListParams,
			replay: "safe",
			execute: async (args: ListInput) =>
				hostObservation(
					"list",
					{ global: true, ...defined(args, ["query", "cwd", "limit", "cursor"]) },
					"List of retained conversations failed",
					ListOutputSchema,
				),
		}),
		outputSchema: ListOutputSchema,
	};

	const inspectTool = {
		...durable.defineTool({
			name: "agent_inspect",
			description:
				"Read one conversation's history, activity, ancestry, or search results through the session host's common observation.",
			parameters: InspectParams,
			replay: "safe",
			execute: async (args: InspectInput) =>
				hostObservation(
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
							"operationId",
						]),
					},
					`Inspect of ${args.sessionId ?? "the calling conversation"} failed`,
					InspectOutputSchema,
				),
		}),
		outputSchema: InspectOutputSchema,
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

	/** Resolve or create the durable owner of an area and record any delivered prompt. */
	/** Resolve the shared place owner of an area through the host dispatch. */
	const dispatchPlace = async (
		api: Durable.ToolExecutionApi<ControlDetails>,
		area: string,
		args: PlaceInput,
	): Promise<{ kind: "ok"; sessionId: string } | { kind: "error"; message: string }> => {
		if (dispatch === undefined) return { kind: "error", message: "agent_place needs the host dispatch callback." };
		let result: unknown;
		try {
			result = await dispatch("place", {
				area,
				...(args.topic === undefined ? {} : { topic: args.topic }),
				...(args.prompt === undefined ? {} : { prompt: args.prompt }),
				origin: "model",
				senderIdentity: identity(api.conversationId),
				requestId: `place:${host.storageId}:${api.taskId}`,
			});
		} catch (error) {
			return {
				kind: "error",
				message: `Place in ${area} failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const sessionId = sessionIdOf(result);
		return sessionId === undefined
			? { kind: "error", message: "Host place returned no sessionId." }
			: { kind: "ok", sessionId };
	};

	const placeTool = durable.defineTool({
		name: "agent_place",
		description:
			"Resolve the durable owner of a directory through the session host's shared place registry. Create it on first use; reuse it when its retained context and ownership serve the task.",
		parameters: PlaceParams,
		replay: "safe",
		execute: async (args: PlaceInput, api, context) => {
			const agent = await api.agent(context);
			const resolved = resolvePlaceArea(args.area ?? agent.cwd ?? host.cwd);
			if (resolved.kind === "error") return errorResult(resolved.message);
			const outcome = await dispatchPlace(api, resolved.area, args);
			if (outcome.kind === "error") return errorResult(outcome.message);
			return textResult(`The owner of ${resolved.area} is ${outcome.sessionId}.`, {
				sessionId: outcome.sessionId,
				area: resolved.area,
			});
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

	const guidance = durable.section("agent-controls", (input) => {
		const selected = input.agent.tools.map((tool) => tool.name);
		const anyControl = selected.some((name) => (AGENT_CONTROL_TOOL_NAMES as readonly string[]).includes(name));
		if (!anyControl) return undefined;
		return [...SECTION_PREAMBLE, ...agentControlGuidanceLines(selected)].join("\n");
	});

	return durable.defineExtension({
		name: "agent",
		tasks: [Anchor, Reporter, TimerTask],
		tools: [
			spawnTool,
			sendTool,
			steerTool,
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
		],
		sections: [guidance],
	});
}
