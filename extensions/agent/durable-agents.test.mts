import { deliveryState as readRetainedDelivery, storeDeliveryRow, retainedReceipt, receiptReferencePage, receiptDeliveryRequestId, receiptSourceIdentity } from "./delivery-store.ts";
import { machineConfig } from "./settings-fixture.mts";
/**
 * durable-agents tests: the native agent contribution in a real Harness.
 *
 * Pi-ai's faux provider drives native calls over MemoryStorage and retained
 * tasks over isolated SQLite. Reopen checks verify that accepted child work,
 * delivery, and reports do not duplicate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { ExecutionSelection } from "./agent-preferences.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, it } from "node:test";

const preferenceOverride = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (preferenceOverride !== undefined) process.env.PI_HARNESS_FILE = preferenceOverride; });
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type AssistantMessage, type Message, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { declareOpenWork, openWorkStatus } from "./open-work.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { compile, obj } from "@earendil-works/pi-schema";
import { type AgentContributionHost, type AgentControlDispatch, createAgentContribution } from "./durable-agents.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAgentExtension from "./index.ts";
import { CheckInTask, CheckInDeadlineTask } from "./durable-checkins.ts";
import { THINKING_LEVELS } from "./configuration.ts";
import { ProfileDoc, readProfile } from "./profile.ts";
import { readRequestContexts, recordRequestContext, REQUEST_CONTEXT_LIMIT, requestContextHooks, requestContextSection, type ActiveRequestContext } from "./request-context.ts";
import { handleStorageId } from "./identity.ts";
import { AgentMetaDoc, readOutcome, submitConversation, settleDeliveries, type DeliveryReceipt } from "./durable-controls.ts";
import { AwaitDoc } from "./awaited-results.ts";

import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry } from "./durable-host-fixture.mts";
import { ContinuityDoc } from "./continuity-native.ts";
import { NATIVE_COMPACTION_SEED } from "./control-guidance.ts";
import { modelFailureText } from "./provider-block-facts.ts";

const context = BACKGROUND_CONTEXT;
const storageId = "test-storage";
const model = { provider: "faux", modelId: "faux-1" } as const;
const testCwdAlias = mkdtempSync(join(tmpdir(), "durable-agents-cwd-"));
const testCwd = realpathSync(testCwdAlias);
const testAgentDir = mkdtempSync(join(tmpdir(), "durable-agents-config-"));
const priorAgentDir = process.env.PI_AGENT_DIR;
process.env.PI_AGENT_DIR = testAgentDir;
after(() => { if (priorAgentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = priorAgentDir; });
beforeEach(() => writeFileSync(join(testAgentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${model.provider}/${model.modelId}` } }, preferences: { defaultPreset: "standard" } }))));
process.on("exit", () => {
	rmSync(testCwd, { recursive: true, force: true });
	rmSync(testAgentDir, { recursive: true, force: true });
});

type ChildRecord = {
	readonly name: string;
	readonly conversationId?: Durable.ConversationId;
	readonly anchorTaskId?: Durable.TaskId;
	readonly foreignSessionId?: string;
	readonly createdBy: Durable.TaskId;
	readonly reported?: Durable.EntryId[];
};
type ChildrenState = { children: ChildRecord[]; reporters: Record<string, number> };

/** Read tokens for the contribution's documents; storage identity is the kind. */
const TestChildren = Durable.defineDoc<ChildrenState>({
	kind: "agent.children",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ children: [], reporters: {} }),
	checkpointWhen: () => false,
});

const CONTROL_TOOLS = [
	"agent_abort",
	"agent_attach",
	"agent_collaborate",
	"agent_command",
	"agent_compact",
	"agent_configure",
	"agent_fork",
	"agent_inspect",
	"agent_intent",
	"agent_list",
	"agent_place",
	"agent_profile",
	"agent_reset",
	"agent_rewind",
	"agent_send",
	"agent_spawn",
	"agent_status",
	"agent_steer",
];

const REPLAY_CLASSIFICATION: Record<string, string> = {
	agent_collaborate: "safe",
	agent_spawn: "safe",
	agent_send: "safe",
	agent_steer: "safe",
	agent_fork: "safe",
	agent_rewind: "safe",
	agent_place: "safe",
	agent_profile: "safe",
	agent_inspect: "safe",
	agent_intent: "safe",
	agent_status: "safe",
	agent_list: "safe",
	agent_reset: "safe",
	agent_abort: "unsafe",
	agent_attach: "unsafe",
	agent_command: "unsafe",
	agent_compact: "unsafe",
	agent_configure: "unsafe",
};

function messageText(message: Message | undefined): string {
	if (message === undefined) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Declaration source for the tool-call script and the child answer hold. */
type RouteState = {
	route: Exclude<FauxResponseStep, AssistantMessage>;
	script: Array<{ tool: string; args: Durable.JsonObject }>;
	batch: Array<Array<{ tool: string; args: Durable.JsonObject }>>;
	requests: Message[][];
	hold: { children: boolean };
};

type AnswerKind = "contract" | "report" | "correction" | "summary" | "script";

function classifyAnswer(text: string): AnswerKind {
	if (text.includes("conversation to summarize")) return "summary";
	if (text.includes("CONTRACT")) return "contract";
	if (text.startsWith("[agent ")) return "report";
	if (text.startsWith("CORRECTION")) return "correction";
	return "script";
}

type DirectAnswerKind = Exclude<AnswerKind, "script">;

function scriptedAnswer(
	batch: Array<Array<{ tool: string; args: Durable.JsonObject }>>,
	script: Array<{ tool: string; args: Durable.JsonObject }>,
): AssistantMessage {
	const queued = batch.shift();
	if (queued !== undefined) {
		return fauxAssistantMessage(
			queued.map((call) => fauxToolCall(call.tool, call.args)),
			{ stopReason: "toolUse" },
		);
	}
	const call = script.shift();
	return call === undefined
		? fauxAssistantMessage("IDLE")
		: fauxAssistantMessage([fauxToolCall(call.tool, call.args)], { stopReason: "toolUse" });
}

function contentAnswer(
	text: string,
	kind: DirectAnswerKind,
	hold: boolean,
): AssistantMessage | Promise<AssistantMessage> {
	if (kind === "summary") return fauxAssistantMessage("SUMMARY-OF-EARLIER-CONTEXT");
	if (kind === "contract") {
		if (hold) return new Promise<AssistantMessage>(() => {});
		return fauxAssistantMessage(`ANSWER-${/reply (\w+)/u.exec(text)?.[1] ?? "UNKNOWN"}`);
	}
	if (kind === "report") return fauxAssistantMessage("NOTED");
	return fauxAssistantMessage(`CORRECTED-${/CORRECTION (\w+)/u.exec(text)?.[1] ?? "UNKNOWN"}`);
}

function createRoute(): RouteState {
	const script: Array<{ tool: string; args: Durable.JsonObject }> = [];
	const batch: Array<Array<{ tool: string; args: Durable.JsonObject }>> = [];
	const requests: Message[][] = [];
	const hold = { children: false };
	const route: FauxResponseStep = (request) => {
		requests.push([...request.messages]);
		const last = request.messages.findLast((message) => message.role !== "system");
		if (last === undefined) return fauxAssistantMessage("no input");
		if (last.role !== "user") return fauxAssistantMessage("DONE");
		const text = messageText(last);
		const kind = classifyAnswer(text);
		return kind === "script" ? scriptedAnswer(batch, script) : contentAnswer(text, kind, hold.children);
	};
	return { route, script, batch, requests, hold };
}

function createTestModels(route: FauxResponseStep): Models {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 500 }, () => route));
	return models;
}

type DispatchCalls = Array<{ method: string; params: Record<string, unknown> }>;
type DispatchHolder = {
	harness?: Durable.Harness;
	spawnSessionId?: string;
	spawnThinking?: { requested: string; effective: string };
	placeSessionId?: string;
	inspectPages?: Array<Record<string, unknown>>;
	configureOutcome?: "applied" | "failed";
};

/** Resolve an external identity used by the test dispatch against the opened harness. */
function sessionConversation(sessionId: unknown): Durable.ConversationId {
	if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("a session id is required");
	if (sessionId === storageId) return Durable.ROOT_CONVERSATION_ID;
	if (sessionId.startsWith(`${storageId}:`))
		return Number(sessionId.slice(storageId.length + 1)) as Durable.ConversationId;
	throw new Error(`unknown storage: ${sessionId}`);
}

function modelOfString(value: string): Durable.ModelRef {
	const split = value.indexOf("/");
	if (split < 1 || split === value.length - 1) throw new Error("model must be provider/model");
	return { provider: value.slice(0, split), modelId: value.slice(split + 1) };
}

function agentChange(params: Record<string, unknown>): Durable.AgentChange {
	return {
		...(typeof params.model === "string" ? { model: modelOfString(params.model) } : {}),
		...(typeof params.thinkingLevel === "string" ? { thinkingLevel: params.thinkingLevel as ModelThinkingLevel } : {}),
		...(typeof params.instructions === "string" ? { instructions: params.instructions } : {}),
		...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
	};
}

async function testConversation(holder: DispatchHolder, sessionId: unknown): Promise<Durable.Conversation> {
	const harness = holder.harness;
	if (harness === undefined) throw new Error("no harness is open");
	const conversation = await harness.conversation(sessionConversation(sessionId), context);
	if (conversation === undefined) throw new Error("conversation is not retained");
	return conversation;
}

/** Minimal value that satisfies the exported ConversationStatusSchema. */
function conversationStatus(conversationId: Durable.ConversationId): Record<string, unknown> {
	return {
		conversationId,
		identity: `${storageId}:${conversationId}`,
		busy: false,
		lastText: null,
		live: null,
		inbox: null,
		agent: { thinkingLevel: "off", extensions: [], tools: [] },
		tasks: [],
		submissions: [],
	};
}

const OBSERVED_AT = "2026-10-02T00:00:00.000Z";

function statusObservation(params: Record<string, unknown>): Record<string, unknown> {
	const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
	if (sessionId === undefined) return { conversations: [], coverage: { complete: true, returned: 0, scanned: 0, next: null }, inventory: { contributions: [], ordinaryOnly: [] }, pid: 123, storageId };
	return {
		conversation: conversationStatus(sessionConversation(sessionId)),
		inventory: { contributions: [], ordinaryOnly: [] },
		pid: 123,
		storageId,
	};
}

function listObservation(): Record<string, unknown> {
	return {
		rows: [],
		nextCursor: null,
		coverage: { complete: true, storagesVisited: 0, unavailable: [], profileHints: { complete: true, unknownStorages: 0, omitted: 0 } },
		observedAt: OBSERVED_AT,
		authority: "native catalog scan",
	};
}

function inspectObservation(holder: DispatchHolder): Record<string, unknown> {
	return (
		holder.inspectPages?.shift() ?? {
			view: "history",
			format: "compact",
			sessionId: `${storageId}:1`,
			conversationId: 1,
			entries: [],
			nextCursor: null,
			order: "newestFirst",
			detail: "inspection-evidence",
		}
	);
}

function dispatchedSpawn(holder: DispatchHolder, params: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const sessionId = holder.spawnSessionId ?? "other-storage:1";
	return { sessionId, ...(holder.spawnThinking === undefined ? {} : { thinking: holder.spawnThinking }), ...(params.prompt === undefined ? {} : { result: { sessionId, submissionId: 23, requestId: params.requestId } }) };
}

async function nativeDispatchResult(holder: DispatchHolder, params: Readonly<Record<string, unknown>>, callContext: import("@earendil-works/chord/context").Context): Promise<unknown> {
	assert.ok(holder.harness);
	const reference = params.result as { submissionId: number; requestId?: string; sessionId: string };
	const input = await holder.harness.submission(reference.submissionId as Durable.SubmissionId, callContext);
	const record = await input?.status(callContext);
	assert.equal(record?.conversationId, sessionConversation(reference.sessionId));
	if (reference.requestId !== undefined) assert.equal(record?.requestId, reference.requestId);
	const outcome = await readOutcome(holder.harness, reference.submissionId as Durable.SubmissionId, callContext);
	await settleDeliveries(holder.harness, callContext);
	const delivery = await holder.harness.commit(async (tx) => {
		const receipt = await retainedReceipt(tx, reference.submissionId);
		if (receipt === undefined) return undefined;
		assert.equal(receipt.ownerId, params.ownerId);
		const group = await receiptReferencePage(tx, storageId, receipt);
		return { requestId: receiptDeliveryRequestId(storageId, receipt), sourceId: receiptSourceIdentity(storageId, receipt), recipient: receipt.ownerId, ...(receipt.answerEntryId === null ? {} : { answerEntryId: receipt.answerEntryId }), results: group.results, complete: group.complete };
	}, callContext);
	return { outcome, ...(delivery === undefined ? {} : { delivery }) };
}

function dispatchedPlace(holder: DispatchHolder, params: Readonly<Record<string, unknown>>) {
	const sessionId = holder.placeSessionId ?? "place-storage";
	return { sessionId, ...(params.prompt === undefined ? {} : { submissionId: 1, requestId: params.requestId, result: { sessionId, submissionId: 1, requestId: params.requestId } }) };
}

function createDispatch(holder: DispatchHolder, calls: DispatchCalls): AgentControlDispatch {
	return async (method, params, callContext = context) => {
		calls.push({ method, params: { ...params } });
		switch (method) {
			case "status":
				return statusObservation(params);
			case "receipts": return nativeDispatchResult(holder, params, callContext);
			case "profile-list":
				return listObservation();
			case "profile-read": {
				const conversation = await testConversation(holder, params.sessionId);
				assert.ok(holder.harness);
				return readProfile(holder.harness, storageId, conversation.id, context, true);
			}
			case "collaboration-list": return { items: [], nextCursor: null, coverage: { complete: true, visited: 0, omitted: 0 } };
			case "inspect":
				return inspectObservation(holder);
			case "compact":
				return { taskId: 7, status: "task" };
			case "spawn": return dispatchedSpawn(holder, params);
			case "place": return dispatchedPlace(holder, params);
			case "command":
				return { name: params.name, text: `command:${String(params.name)}`, conversationId: params.sessionId ?? null };
			case "reset":
				return { conversationId: 5, requestId: params.requestId ?? "test-reset", submissionId: 11, status: "placed", entryId: 12, reason: null, deduped: false };
			case "timer-list":
				return { timers: [] };
			case "timer-cancel":
				return { timerId: params.timerId ?? 3, outcome: "marked", status: "cancelled" };
			case "fork":
				return { conversationId: 9, identity: "other-storage:9" };
			case "rewind":
				return { conversationId: 10, identity: "other-storage:10" };
			case "configure": {
				const conversation = await testConversation(holder, params.sessionId);
				const change = agentChange(params);
				if (Object.keys(change).length > 0) await conversation.configure(change, context);
				return { sessionId: params.sessionId, outcome: holder.configureOutcome ?? "applied" };
			}
			case "attach": {
				const conversation = await testConversation(holder, params.sessionId);
				const change = agentChange(params);
				if (Object.keys(change).length > 0) await conversation.configure(change, context);
				return { sessionId: params.sessionId, status: "attached" };
			}
			default:
				throw new Error(`unexpected control method ${method}`);
		}
	};
}

const testServices: AgentContributionHost["services"] = { modelRuntime: { getModel: (provider, modelId) => provider === model.provider ? fauxProvider().getModel(modelId) : undefined } };

/** A test tool that shares the batch with agent_compact. */
const siblingExtension = Durable.defineExtension({
	name: "test-sibling",
	tools: [
		Durable.defineTool({
			name: "sibling-probe",
			description: "Return a fixed marker.",
			parameters: obj({}, { open: true }),
			replay: "safe",
			execute: async () => ({ output: [{ type: "text" as const, text: "SIBLING-OK" }] }),
		}),
	],
});

function buildRegistry(dispatch?: AgentControlDispatch, checkIns = true, sourceStorageId = storageId, catalogRoot?: string): { registry: Durable.Registry; extension: Durable.Extension } {
	const registry = Durable.createRegistry();
	if (checkIns) registry.install(Durable.defineExtension({ name: "test.host", tasks: [CheckInTask, CheckInDeadlineTask] }));
	const contribution = createAgentContribution({ configureSettings: () => {},
		source: "/abs/extensions/agent/index.ts",
		...(dispatch === undefined ? {} : { dispatch }),
	});
	const extension: Durable.Extension = contribution.create({ onClose() {},
		durable: Durable,
		storageId: sourceStorageId,
		catalogRoot,
		cwd: testCwd,
		agentDir: testAgentDir,
		services: testServices,
	});
	registry.install(extension);
	registry.install(siblingExtension);
	return { registry, extension };
}

async function openHarness(
	storage: Durable.Storage,
	registry: Durable.Registry,
	models: Models,
	settings?: Durable.HarnessSettings,
): Promise<{ harness: Durable.Harness; root: Durable.Conversation }> {
	const harness = await Durable.Harness.open(
		storage,
		{ models, registry, ...(settings === undefined ? {} : { settings }) },
		context,
	);
	harness.resume();
	const deferred = registry.snapshot().installed().flatMap((entry) => (entry.tools ?? []).filter((tool) => tool.deferred === true));
	const root = await harness.root(context, { agent: { model, modelTools: { add: deferred } } });
	return { harness, root };
}

async function say(root: Durable.Conversation, text: string): Promise<void> {
	const submission = await root.submit({ type: "input", content: text }, context);
	await submission.wait(context);
}

async function entriesOf(
	harness: Durable.Harness,
	conversationId: Durable.ConversationId,
): Promise<readonly Durable.EntryRecord[]> {
	const page = await harness.commit((tx) => tx.scanEntries({ conversationId }, 200), context);
	return page.items;
}

async function userTexts(harness: Durable.Harness, conversationId: Durable.ConversationId): Promise<string[]> {
	const entries = await entriesOf(harness, conversationId);
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "user" ? [messageText(message)] : [];
	});
}

async function assistantTexts(harness: Durable.Harness, conversationId: Durable.ConversationId): Promise<string[]> {
	const entries = await entriesOf(harness, conversationId);
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "assistant" ? [messageText(message)] : [];
	});
}

type ToolOutcome = { name: string; isError: boolean; text: string; details?: unknown };

async function toolOutcomes(harness: Durable.Harness, conversationId: Durable.ConversationId): Promise<ToolOutcome[]> {
	const entries = await entriesOf(harness, conversationId);
	return entries.flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult"
			? [{ name: message.toolName, isError: message.isError, text: messageText(message), details: message.details }]
			: [];
	});
}

/** Wait for every reporter started by the owner registry, then for the owner's ordinary work. */
async function settle(harness: Durable.Harness, rootId: Durable.ConversationId): Promise<void> {
	const children = await harness.snapshot(TestChildren, rootId, context);
	for (const reporter of Object.values(children?.reporters ?? {})) {
		await harness.waitForTask(reporter as Durable.TaskId, context);
	}
	const root = await harness.conversation(rootId, context);
	await root?.waitForIdle(context);
}

/** Resolve once a child generation of the owner runs; driven by the task-graph watch, not polling. */
async function waitForChildGeneration(harness: Durable.Harness, rootId: Durable.ConversationId): Promise<void> {
	const running = (graph: Durable.TaskGraph): boolean =>
		Object.values(graph.tasks).some(
			(node) => node.kind === "pi.generation" && node.conversationId !== rootId && node.state.status === "running",
		);
	const watch = await harness.watchTaskGraph(context);
	if (running(watch.value)) {
		await watch.stop();
		return;
	}
	try {
		await new Promise<void>((resolve) => {
			watch.start(async (call) => {
				if (call.kind === "value" && running(call.value)) resolve();
			});
		});
	} finally {
		await watch.stop();
	}
}

async function spawnChild(
	harness: Durable.Harness,
	root: Durable.Conversation,
	route: RouteState,
	name: string,
	reply: string,
): Promise<ChildRecord & { readonly conversationId: Durable.ConversationId; readonly anchorTaskId: Durable.TaskId }> {
	route.script.push({ tool: "agent_spawn", args: { name, prompt: `CONTRACT: reply ${reply}` } });
	await say(root, "SPAWN");
	await settle(harness, root.id);
	const state = await harness.snapshot(TestChildren, root.id, context);
	const child = state?.children.find((candidate) => candidate.name === name);
	assert.ok(child, `child ${name} is registered`);
	assert.ok(child.conversationId !== undefined && child.anchorTaskId !== undefined, `child ${name} is local`);
	return { ...child, conversationId: child.conversationId, anchorTaskId: child.anchorTaskId };
}

it("declares every control tool with an explicit replay classification", () => {
	const { extension } = buildRegistry();
	const tools = extension.tools ?? [];
	assert.deepEqual(tools.map((tool) => tool.name).sort(), CONTROL_TOOLS);
	for (const tool of tools) {
		assert.equal(tool.replay, REPLAY_CLASSIFICATION[tool.name], `${tool.name} declares replay`);
	}
	assert.deepEqual((extension.tasks ?? []).map((task) => task.definition.name).sort(), [
		"agent.anchor",
		"agent.reporter",
		"agent.timer",
	]);
	const reporter = extension.tasks?.find((task) => task.definition.name === "agent.reporter");
	assert.equal(reporter?.definition.version, 2);
	assert.equal(reporter?.definition.migrate, undefined, "old active Reporter tasks must drain before adoption");
	assert.deepEqual(Object.keys(reporter?.definition.phases ?? {}), ["deliver"]);
	const contribution = createAgentContribution({ configureSettings: () => {}, source: "/abs/extensions/agent/index.ts" });
	assert.equal(contribution.name, "agent");
	assert.equal(contribution.source, "/abs/extensions/agent/index.ts");
});

it("labels a spawn prompt and a send without a mode as new work, and only a steer as a correction", async (t) => {
	const route = createRoute();
	const { registry, extension } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(async () => { await harness.close(context); });
	const child = await spawnChild(harness, root, route, "labelled", "SPAWNED");
	const sessionId = `${storageId}:${child.conversationId}`;
	const call = async (tool: string, args: Durable.JsonObject): Promise<void> => {
		route.script.push({ tool, args });
		await say(root, `RUN ${tool}`);
		await settle(harness, root.id);
	};
	await call("agent_send", { sessionId, message: "CONTRACT: reply DEFAULT" });
	await call("agent_send", { sessionId, message: "CONTRACT: reply FOLLOW", mode: "followUp" });
	await call("agent_send", { sessionId, message: "CONTRACT: reply CORRECT", mode: "steer" });
	await call("agent_steer", { sessionId, message: "CONTRACT: reply STEERED" });
	const classes: Record<string, unknown> = {};
	for (const entry of await entriesOf(harness, child.conversationId)) {
		if (entry.kind === "agent.input") classes[messageText(entry.model?.[0])] = (entry.data as { class?: unknown }).class;
	}
	assert.deepEqual(classes, {
		"CONTRACT: reply SPAWNED": "followUp",
		"CONTRACT: reply DEFAULT": "followUp",
		"CONTRACT: reply FOLLOW": "followUp",
		"CONTRACT: reply CORRECT": "steer",
		"CONTRACT: reply STEERED": "steer",
	});
	const send = extension.tools?.find((tool) => tool.name === "agent_send");
	assert.ok(send);
	const mode = (send.parameters as { properties: Record<string, { description?: string }> }).properties.mode;
	assert.match(mode.description ?? "", /Default followUp: new work/u, "the schema states the default class");
});

it("states the tool-round boundary for a steer and the check-in default of zero in the native tool descriptions", () => {
	const { extension } = buildRegistry();
	const description = (name: string): string => extension.tools?.find((tool) => tool.name === name)?.description ?? "";
	assert.match(description("agent_steer"), /placed at its next tool boundary, the end of its current tool round/u);
	assert.doesNotMatch(description("agent_steer"), /next step/u);
	for (const name of ["agent_send", "agent_spawn"]) {
		assert.match(description(name), /Owner check-ins for an unanswered task run only when checkInMinutes, or the configured agent\.checkInMinutes setting, names an interval; the default is 0\./u, name);
		assert.doesNotMatch(description(name), /send automatic owner check-ins/u, name);
	}
});

it("saves an explicit handle-less creation role and documents it in both schemas", async (t) => {
	const ordinary: { name: string; parameters: { properties: Record<string, { description?: string }> } }[] = [];
	await registerAgentExtension({ events: { on: () => () => {}, emit() {} }, on() {}, registerTool(tool: typeof ordinary[number]) { ordinary.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {} } as unknown as ExtensionAPI);
	const { extension, registry } = buildRegistry();
	for (const tools of [ordinary, extension.tools ?? []]) {
		const spawn = tools.find((tool) => tool.name === "agent_spawn");
		assert.ok(spawn);
		const schema = spawn.parameters as { properties: Record<string, { description?: string }> };
		assert.equal(schema.properties.role.description, "Durable role text saved on the new agent's profile, with or without a handle. Reuse does not change the role.");
	}
	const route = createRoute();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_spawn", args: { role: "Review source" } });
	await say(root, "Create a role without a handle");
	const result = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_spawn");
	assert.ok(result && !result.isError, result?.text);
	const children = (await harness.snapshot(TestChildren, root.id, context))?.children ?? [];
	assert.equal(children.length, 1);
	const childId = children[0].conversationId as Durable.ConversationId;
	const profile = await readProfile(harness, storageId, childId, context);
	assert.equal(profile.role, "Review source");
	assert.equal(profile.handle, null);
	const child = await harness.conversation(childId, context);
	assert.ok(child);
	assert.match((await child.agent(context)).instructions ?? "", /Your role: Review source/u);
});

it("preserves closed control objects, optional fields, enums and inspect cursors", async () => {
	const { extension } = buildRegistry();
	const ordinary: Array<{ name: string; parameters: object }> = [];
	await registerAgentExtension({ events: { on: () => () => {}, emit() {} }, on() {}, registerTool(tool: typeof ordinary[number]) { ordinary.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {} } as unknown as ExtensionAPI);
	for (const tools of [ordinary, extension.tools ?? []]) {
		const schemaFor = (name: string) => {
			const tool = tools.find((candidate) => candidate.name === name);
			assert.ok(tool, name);
			return compile(tool.parameters);
		};
		for (const [name, input] of [
			["agent_steer", { sessionId: storageId, message: "Continue" }],
			["agent_reset", { sessionId: storageId }],
			["agent_command", { sessionId: storageId, name: "reload" }],
			["agent_inspect", { sessionId: storageId }],
		] as const) {
			const schema = schemaFor(name);
			assert.equal(schema.check(input), true, name);
			assert.equal(schema.check({ ...input, extra: true }), false, name);
			assert.equal(schema.check({ ...input, sessionId: "" }), false, name);
		}
		for (const [name, input] of [
			["agent_spawn", {}],
			["agent_place", {}],
			["agent_configure", { sessionId: storageId }],
		] as const) {
			const schema = schemaFor(name);
			assert.equal(schema.check(input), true, name);
			assert.equal(schema.check({ ...input, preset: "standard" }), true, name);
			assert.equal(schema.check({ ...input, preset: 7 }), false, name);
			assert.equal(schema.check({ ...input, preset: "" }), false, name);
			assert.equal(schema.check({ ...input, extra: true }), false, name);
		}
		const status = schemaFor("agent_status");
		assert.equal(status.check({}), true);
		assert.equal(status.check({ view: "fleet" }), true);
		assert.equal(status.check({ view: "fleet", model: "sample/a", provider: "sample" }), true);
		assert.equal(status.check({ view: "fleet", provider: 7 }), false);
		assert.equal(status.check({ view: "fleet", model: "" }), false);
		const inspect = schemaFor("agent_inspect");
		assert.equal(inspect.check({ sessionId: storageId, view: "history", source: "toolResult", cursor: { position: 2, nested: { token: "page" } } }), true);
		assert.equal(inspect.check({ sessionId: storageId, view: "unsupported" }), false);
		assert.equal(inspect.check({ sessionId: storageId, cursor: "page" }), false);
		assert.equal(inspect.check({ sessionId: storageId, offset: -1 }), false);
	}
});

it("accepts every shared thinking level in native spawn, configure, and attach schemas", () => {
	const { extension } = buildRegistry();
	for (const name of ["agent_spawn", "agent_configure", "agent_attach"]) {
		const tool = extension.tools?.find((candidate) => candidate.name === name);
		assert.ok(tool, `${name} is declared`);
		for (const thinkingLevel of THINKING_LEVELS) {
			const args = { ...(name === "agent_spawn" ? {} : { sessionId: storageId }), thinkingLevel };
			assert.deepEqual(validateToolArguments(tool, fauxToolCall(name, args)), args);
		}
		assert.throws(() => validateToolArguments(tool, fauxToolCall(name, {
			...(name === "agent_spawn" ? {} : { sessionId: storageId }), thinkingLevel: "unsupported",
		})), /Validation failed/u);
	}
});

it("releases failed admission provenance before preparation exhausts its bound", async (t) => {
	let providerCalls = 0;
	const route = createRoute();
	const models = createTestModels((...args) => { providerCalls++; return route.route(...args); });
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models);
	t.after(() => harness.close(context));
	for (let index = 0; index < 256; index++) await assert.rejects(submitConversation(root, { message: "Not admitted", requestId: `failed-prepare:${index}`, ownerId: "requester" }, context), /no admission origin/u);
	assert.equal((await harness.snapshot(AwaitDoc, context))?.provenance.length, 0);
	assert.equal(providerCalls, 0);
});

for (const tool of ["agent_spawn", "agent_send"]) it(`${tool} returns an admitted exact result before the background answer and arms one configured check-in`, async (t) => {
	const route = createRoute();
	let finish!: (answer: AssistantMessage) => void;
	const producer = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const models = createTestModels((...args) => {
		const last = args[0].messages.findLast((message) => message.role !== "system");
		return last?.role === "user" && messageText(last) === "CONTRACT: reply EXACT" ? producer : route.route(...args);
	});
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models);
	t.after(async () => { finish(fauxAssistantMessage("ANSWER-EXACT")); await harness.close(context); });
	const existing = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	route.script.push({ tool, args: tool === "agent_spawn" ? { name: "exact-result", prompt: "CONTRACT: reply EXACT", checkInMinutes: 30 } : { sessionId: `${storageId}:${existing.id}`, message: "CONTRACT: reply EXACT", checkInMinutes: 30 } });
	await say(root, "Dispatch background work");
	const outcome = (await toolOutcomes(harness, root.id)).find((candidate) => candidate.name === tool);
	assert.equal(outcome?.isError, false, outcome?.text);
	const reference = (outcome?.details as { result?: { sessionId: string; submissionId: number; requestId: string } })?.result;
	assert.ok(reference);
	assert.ok(outcome?.text.includes(JSON.stringify(reference)));
	const conversationId = Number(reference.sessionId.split(":")[1]) as Durable.ConversationId;
	const admitted = await harness.commit((tx) => tx.submissionByRequest(conversationId, reference.requestId), context);
	assert.equal(admitted?.id, reference.submissionId);
	assert.equal(admitted?.conversationId, conversationId);
	assert.ok(admitted?.status === "queued" || admitted?.status === "placed");
	const checkIns = (await harness.inspect(context)).tasks.filter((task) => task.record.kind === CheckInTask.definition.name);
	assert.equal(checkIns.length, 1, "the tool and Reporter share one admission marker");
	const state = await readRetainedDelivery(harness, context, true);
	const intent = state.intents.find((item) => item.requestId === reference.requestId && item.conversationId === conversationId);
	assert.ok(intent, "the producer retains its delivery intent before its answer");
	assert.equal(intent.ownerId, storageId);
	assert.equal(intent.submissionId, reference.submissionId);
	assert.equal(intent.origin, "model");
	const request = (await readRequestContexts(harness, conversationId, context)).find((item) => item.requestId === reference.requestId);
	assert.equal(request?.requester, storageId);
	assert.equal(request?.replyTo, storageId);
});

it("arms no check-in for a model task that names no interval", async (t) => {
	const route = createRoute();
	let finish!: (answer: AssistantMessage) => void;
	const producer = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const models = createTestModels((...args) => {
		const last = args[0].messages.findLast((message) => message.role !== "system");
		return last?.role === "user" && messageText(last) === "CONTRACT: reply QUIET" ? producer : route.route(...args);
	});
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models);
	t.after(async () => { finish(fauxAssistantMessage("ANSWER-QUIET")); await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { name: "quiet-result", prompt: "CONTRACT: reply QUIET" } });
	await say(root, "Dispatch unsupervised work");
	const outcome = (await toolOutcomes(harness, root.id)).find((candidate) => candidate.name === "agent_spawn");
	assert.equal(outcome?.isError, false, outcome?.text);
	assert.ok((outcome?.details as { result?: { submissionId: number } })?.result, "the task is admitted with an exact result reference");
	const checkIns = (await harness.inspect(context)).tasks.filter((task) => task.record.kind === CheckInTask.definition.name);
	assert.equal(checkIns.length, 0, "the default interval of zero arms no watchdog");
});

for (const contentRefusal of [true, false]) it(`retains ${contentRefusal ? "content refusal" : "unclassified failure"} receipts without a second Reporter input`, { timeout: 10000 }, async (t) => {
	const raw = `${contentRefusal ? "This content was flagged for possible cybersecurity risk" : "Unknown request rejection"}; api_key=sk-abcdefghijklmnopqrstuv; ${"x".repeat(2000)}`;
	const route = createRoute(); let finish!: (message: AssistantMessage) => void; let calls = 0;
	const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const models = createTestModels((...args) => {
		const last = args[0].messages.findLast((message) => message.role !== "system");
		if (last?.role === "user" && messageText(last) === "REFUSED-TASK") { calls++; return held; }
		return route.route(...args);
	});
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models, { retry: { enabled: true, maxRetries: 3 } }); holder.harness = harness;
	t.after(async () => { finish(fauxAssistantMessage("FINISHED")); await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { name: "refused-task", prompt: "REFUSED-TASK" } });
	await say(root, "Dispatch a task");
	const spawned = (await toolOutcomes(harness, root.id)).find((item) => item.name === "agent_spawn"); assert.ok(spawned);
	const result = (spawned.details as { result: { sessionId: string; submissionId: number; requestId: string } }).result;
	finish(fauxAssistantMessage([], { stopReason: "error", errorMessage: raw }));
	const input = await harness.submission(result.submissionId as Durable.SubmissionId, context); assert.ok(input);
	const native = await input.wait(context); assert.equal(native.status, "unanswered");
	if (native.status !== "unanswered") assert.fail("Expected a native model failure");
	assert.equal(native.reason, "model_error"); assert.equal(native.detail, raw);
	const expected = modelFailureText("model_error", raw);
	await settle(harness, root.id);
	assert.equal((await userTexts(harness, root.id)).some((text) => text.includes(expected)), false, "Reporter posts no second failure body");
	await settleDeliveries(harness, context);
	const receipt = await harness.commit((tx) => retainedReceipt(tx, result.submissionId), context);
	assert.equal(receipt?.status, "unanswered");
	assert.equal(receipt?.ownerId, storageId);
	assert.equal(calls, 1, "the native host does not retry or substitute the model");
	assert.ok(Buffer.byteLength(expected) <= 1024); assert.doesNotMatch(expected, /abcdefghijkl/u);
});

for (const ownership of ["unowned", "owned", "mismatching-reference"] as const) it(`checks exact receipt ownership with ${ownership} native request identity`, { timeout: 10000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "exact-receipt-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const foreign = await DurableHost.open({ storageId: "foreign", storagePath: join(directory, "source.sqlite"), cwd: directory, registry: fixtureRegistry(), models: createTestModels(() => fauxAssistantMessage("EXACT")), agent: { model } }, context);
	t.after(() => foreign.close());
	const input = await foreign.root().submit({ type: "input", content: "native work" }, context);
	const terminal = await input.wait(context);
	assert.ok(terminal.type === "input" && terminal.status === "done");
	assert.equal(terminal.requestId, undefined);
	const retainedRequestId = "retained-admission";
	if (ownership !== "unowned") {
		// Receipt ownership uses the submission identity, independently of the optional native request key.
		const receipt: DeliveryReceipt = { submissionId: terminal.id, requestId: retainedRequestId, ownerId: storageId, conversationId: terminal.conversationId,
			operationId: null, origin: "operator", status: "done", entryId: terminal.entry ?? null, answerEntryId: terminal.answer, answer: "EXACT", reason: null, acknowledged: false };
		await foreign.harness.commit((tx) => storeDeliveryRow(tx, "receipt", receipt, true), context);
	}
	const result = { sessionId: "foreign", submissionId: terminal.id, ...(ownership === "mismatching-reference" ? { requestId: retainedRequestId } : {}) };
	if (ownership === "unowned") await assert.rejects(foreign.request("receipts", { ownerId: storageId, result }, context), /not addressed/u);
	else if (ownership === "mismatching-reference") await assert.rejects(foreign.request("receipts", { ownerId: storageId, result }, context), /does not identify the selected native input/u);
	else {
		const selected = await foreign.request("receipts", { ownerId: storageId, result }, context) as { outcome: { submissionId: number; requestId?: string; answer?: string }; delivery: { results: Array<{ sessionId: string; submissionId: number; requestId: string }> } };
		assert.equal(selected.outcome.submissionId, terminal.id);
		assert.equal(selected.outcome.requestId, undefined);
		assert.equal(selected.outcome.answer, "EXACT");
		assert.deepEqual(selected.delivery.results, [{ sessionId: "foreign", submissionId: terminal.id, requestId: retainedRequestId }]);
		assert.equal((await input.status(context)).requestId, undefined, "receipt lookup never adds a native request key");
	}
});

it("reports the requested and effective thinking level when native creation clamps it", async (t) => {
	const route = createRoute();
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(async () => { await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { name: "max-child", thinkingLevel: "max", checkInMinutes: 0 } });
	await say(root, "Create a child at max thinking.");
	const spawn = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_spawn");
	assert.equal(spawn?.isError, false, spawn?.text);
	const children = await harness.snapshot(TestChildren, root.id, context);
	const child = children?.children.find((record) => record.name === "max-child");
	assert.ok(child?.conversationId !== undefined, "the native child exists");
	assert.equal((await harness.snapshot(Durable.AgentDoc, child.conversationId, context))?.thinkingLevel, "off");
	assert.match(spawn?.text ?? "", /requested max; effective off/u);
	assert.ok(spawn);
	assert.deepEqual((spawn.details as { thinking: unknown }).thinking, { requested: "max", effective: "off" });
});

it("retains native preset selection through replay after a machine file edit", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "native-preset-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const path = join(agentDir, "harness.json");
	writeFileSync(path, JSON.stringify(machineConfig({ presets: { review: { model: "faux/faux-1", thinkingLevel: "max", role: "Review", checkInMinutes: 0 } } })));
	const registry = Durable.createRegistry(); const route = createRoute();
	const extension = createAgentContribution({ configureSettings: () => {}, source: "/abs/extensions/agent/index.ts" }).create({ onClose() {}, durable: Durable, storageId, cwd: testCwd, agentDir, services: testServices });
	let original: ExecutionSelection | undefined;
	registry.install({ ...extension, tools: extension.tools?.map((tool) => tool.name !== "agent_spawn" ? tool : { ...tool, execute: async (args, api, ctx) => {
		const first = await tool.execute(args, api, ctx);
		original = (first.details as { selection: ExecutionSelection }).selection;
		writeFileSync(path, "invalid json");
		return tool.execute(args, api, ctx);
	} }) });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_spawn", args: { preset: "review" } });
	await say(root, "Create a preset child");
	const outcome = (await toolOutcomes(harness, root.id)).find((entry) => entry.name === "agent_spawn");
	assert.ok(outcome && !outcome.isError, outcome?.text);
	const selection = (outcome.details as { selection: ExecutionSelection }).selection;
	assert.deepEqual(selection, original);
	assert.equal(selection.preset, "review");
	assert.deepEqual(selection.unapplied, ["role", "checkInMinutes"]);
	assert.deepEqual(selection.thinking, { requested: "max", effective: "off" });
	assert.equal((await harness.snapshot(TestChildren, root.id, context))?.children.length, 1);
	assert.match(getCurrentSystemPrompt(route.requests.at(-1) ?? []), /Machine document is invalid/u);
});

it("forwards native preset inputs and snapshots through handle, foreign, place, and configure dispatch", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "native-preset-dispatch-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify(machineConfig({ presets: { review: { model: "faux/faux-1", checkInMinutes: 2 } } })));
	const seen: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
	const extension = createAgentContribution({ configureSettings: () => {}, source: "/abs/extensions/agent/index.ts", dispatch: async (method, params) => { seen.push({ method, params }); return { sessionId: "foreign-storage", selection: { marker: "retained" }, ...(method === "place" ? { submissionId: 1, result: { sessionId: "foreign-storage", submissionId: 1, requestId: params.requestId } } : {}) }; } }).create({ onClose() {}, durable: Durable, storageId, cwd: testCwd, agentDir, services: testServices });
	const registry = Durable.createRegistry(); registry.install(extension);
	const route = createRoute();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push(
		{ tool: "agent_spawn", args: { handle: "reviewer", preset: "review" } },
		{ tool: "agent_spawn", args: { cwd: agentDir, preset: "review" } },
		{ tool: "agent_place", args: { area: agentDir, preset: "review", model: "faux/faux-1", thinkingLevel: "high", prompt: "Task" } },
		{ tool: "agent_configure", args: { sessionId: "foreign-storage", preset: "review", thinkingLevel: "low" } },
	);
	for (let index = 0; index < 4; index++) await say(root, "Use preset controls");
	assert.deepEqual(seen.map((entry) => entry.method), ["resolve-agent", "spawn", "place", "configure"]);
	for (const entry of seen) { assert.equal(entry.params.preset, "review"); assert.ok(entry.params.preferenceSnapshot); }
	assert.equal(seen[2].params.checkInMinutes, undefined, "place must not override a preset with an early environment default");
	assert.equal(seen[2].params.thinkingLevel, "high");
	assert.equal(seen[3].params.thinkingLevel, "low");
	assert.match((await toolOutcomes(harness, root.id)).find((entry) => entry.name === "agent_place")?.text ?? "", /retained/u);
});

it("uses isolated preferences despite an ambient agent directory", async (t) => {
	const ambientDir = mkdtempSync(join(tmpdir(), "native-ambient-preferences-"));
	const previous = process.env.PI_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
		rmSync(ambientDir, { recursive: true, force: true });
	});
	writeFileSync(join(ambientDir, "harness.json"), JSON.stringify(machineConfig({ presets: { ambient: { model: "faux/faux-1" } },
		preferences: { reportingNotes: "AMBIENT-PREFERENCES-MARKER" },
	})));
	process.env.PI_AGENT_DIR = ambientDir;
	const route = createRoute();
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_spawn", args: {} });
	await say(root, "Create an isolated child");
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_spawn");
	assert.ok(outcome && !outcome.isError, outcome?.text);
	assert.doesNotMatch(getCurrentSystemPrompt(route.requests.at(-1) ?? []), /AMBIENT-PREFERENCES-MARKER/u);
	const selection = (outcome.details as { selection: ExecutionSelection }).selection;
	assert.equal(selection.source.status, "loaded");
	assert.equal(selection.origins.model, "defaultPreset");
	assert.equal(selection.source.path, join(testAgentDir, "harness.json"));
});

it("returns retained native creation facts without revalidating a later catalog", async (t) => {
	let available = true;
	let catalogReads = 0;
	const route = createRoute();
	const registry = Durable.createRegistry();
	const extension = createAgentContribution({ configureSettings: () => {}, source: "/abs/extensions/agent/index.ts" }).create({ onClose() {},
		durable: Durable, storageId, cwd: testCwd, agentDir: testAgentDir,
		services: { modelRuntime: { getModel: (_provider, id) => { catalogReads++; return available ? fauxProvider().getModel(id) : undefined; } } },
	});
	registry.install({ ...extension, tools: extension.tools?.map((tool) => tool.name !== "agent_spawn" ? tool : {
		...tool, execute: async (args, api, ctx) => {
			const first = await tool.execute(args, api, ctx);
			assert.equal(first.isError, undefined);
			available = false;
			const beforeReplay = catalogReads;
			const replay = await tool.execute(args, api, ctx);
			assert.equal(catalogReads, beforeReplay, "replay does not revalidate the retained selection");
			return replay;
		},
	}) });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_spawn", args: { thinkingLevel: "max" } });
	await say(root, "Create a worker");
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_spawn");
	assert.ok(outcome && !outcome.isError, outcome?.text);
	assert.match(outcome.text, /Reused the agent created by this call/u);
	assert.match(outcome.text, /requested max; effective off/u);
	assert.equal((await harness.snapshot(TestChildren, root.id, context))?.children.length, 1);
	assert.ok(catalogReads > 0);
});

it("refuses an absent native spawn model before child or reporter creation", async (t) => {
	const route = createRoute();
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(async () => { await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { model: "faux/absent", prompt: "Do the review", checkInMinutes: 0 } });
	await say(root, "Delegate the review.");
	const spawn = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_spawn");
	assert.equal(spawn?.isError, true);
	assert.match(spawn?.text ?? "", /Model is not in the configured catalog: faux\/absent/u);
	const children = await harness.snapshot(TestChildren, root.id, context);
	assert.equal(children?.children.length ?? 0, 0);
	assert.equal(Object.keys(children?.reporters ?? {}).length, 0);
});

it("spawns an anchor-owned child and reports its answer once", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	const child = await spawnChild(harness, root, route, "alpha", "ALPHA");

	const record = await harness.commit((tx) => tx.conversation(child.conversationId), context);
	assert.equal(record?.owner?.conversationId, root.id, "the owner conversation owns the child");
	assert.equal(record?.owner?.taskId, child.anchorTaskId, "the anchor task owns the child");
	const rootAgent = await root.agent(context);
	const childAgent = await harness.snapshot(Durable.AgentDoc, child.conversationId, context);
	assert.equal((await harness.snapshot(AgentMetaDoc, child.conversationId, context))?.firstMessage, "CONTRACT: reply ALPHA", "the historical first input contains only task text");
	assert.deepEqual(childAgent?.model, rootAgent.model, "the child stores the resolved model");
	assert.equal(childAgent?.thinkingLevel, rootAgent.thinkingLevel, "the child stores the resolved thinking level");
	const anchor = await harness.getTask(child.anchorTaskId, context);
	assert.equal(anchor?.kind, "agent.anchor");
	assert.equal(anchor?.background, true, "the anchor is background work");
	assert.equal(anchor?.owner, undefined, "the anchor belongs to the owner conversation");

	const deliveries = (await userTexts(harness, child.conversationId)).filter((text) =>
		text.includes("CONTRACT: reply ALPHA"),
	);
	assert.equal(deliveries.length, 1, "the child received the prompt once");
	const answers = await assistantTexts(harness, child.conversationId);
	assert.ok(
		answers.some((text) => text.includes("ANSWER-ALPHA")),
		"the child answered",
	);
	const reports = (await userTexts(harness, root.id)).filter(
		(text) => text.includes("[agent alpha answered]") && text.includes("ANSWER-ALPHA"),
	);
	assert.equal(reports.length, 0, "Reporter leaves answer delivery to the common receipt watcher");

	const state = await harness.snapshot(TestChildren, root.id, context);
	const reporters = Object.values(state?.reporters ?? {});
	assert.equal(reporters.length, 1, "one reporter task");
	const receipt = await harness.getTask(reporters[0] as Durable.TaskId, context);
	assert.equal(receipt?.state.status, "terminal");
	assert.equal(Object.hasOwn(child, "reported"), false, "new children do not track answer delivery");
	await settleDeliveries(harness, context);
	const delivered = await readRetainedDelivery(harness, context, true);
	assert.equal(Object.values(delivered.receipts).filter((row) => row.conversationId === child.conversationId && row.ownerId === storageId).length, 1);
});

it("keeps two children when the same name is used deliberately", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	await spawnChild(harness, root, route, "reader", "ONE");
	await spawnChild(harness, root, route, "reader", "TWO");
	const state = await harness.snapshot(TestChildren, root.id, context);
	assert.equal(state?.children.filter((child) => child.name === "reader").length, 2, "names may repeat");
	const reports = (await userTexts(harness, root.id)).filter((text) => text.includes("[agent reader answered]"));
	assert.equal(reports.length, 0, "Reporter never posts a second answer input");
	await settleDeliveries(harness, context);
	const receipts = Object.values((await readRetainedDelivery(harness, context, true)).receipts);
	assert.equal(receipts.filter((receipt) => state.children.some((child) => child.conversationId === receipt.conversationId)).length, 2);
});

it("resumes a child answer with one delivery intent across a second harness open", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const models = createTestModels(route.route);
	const storage = new Durable.MemoryStorage();
	route.hold.children = true;
	const first = await openHarness(storage, registry, models);
	holder.harness = first.harness;
	route.script.push({ tool: "agent_spawn", args: { name: "crash", prompt: "CONTRACT: reply CRASH", checkInMinutes: 0 } });
	await say(first.root, "SPAWN");
	const before = await first.harness.snapshot(TestChildren, first.root.id, context);
	assert.equal(before?.children.length, 1, "the child is committed before the crash");
	await waitForChildGeneration(first.harness, first.root.id);
	const reporter = Object.values(before?.reporters ?? {})[0] as Durable.TaskId;

	// Abandon the first Harness without close; reopen the same storage.
	route.hold.children = false;
	const second = await openHarness(storage, registry, models);
	holder.harness = second.harness;
	t.after(async () => {
		await second.harness.close(context);
	});
	await settle(second.harness, second.root.id);

	const children = await second.harness.snapshot(TestChildren, second.root.id, context);
	assert.equal(children?.children.length, 1, "exactly one child after reopen");
	const child = children.children[0];
	assert.ok(child.conversationId !== undefined, "the child is local");
	const childConversation = child.conversationId;
	const deliveries = (await userTexts(second.harness, childConversation)).filter((text) =>
		text.includes("CONTRACT: reply CRASH"),
	);
	assert.equal(deliveries.length, 1, "exactly one delivery after reopen");
	const answers = await assistantTexts(second.harness, childConversation);
	assert.ok(
		answers.some((text) => text.includes("ANSWER-CRASH")),
		"the child answered after reopen",
	);
	const reports = (await userTexts(second.harness, second.root.id)).filter((text) =>
		text.includes("[agent crash answered]"),
	);
	assert.equal(reports.length, 0, "Reporter does not post an answer input after reopen");
	assert.equal(Object.values(children?.reporters ?? {}).length, 1, "one reporter task after reopen");
	const receipt = await second.harness.getTask(reporter, context);
	assert.equal(receipt?.state.status, "terminal");
	const deliverySubmission = await storage.submissionByRequest(childConversation, `agent-deliver:${reporter}`, context);
	assert.ok(deliverySubmission, "the delivery request ID is retained");
	const reportSubmission = await storage.submissionByRequest(second.root.id, `agent-report:${reporter}`, context);
	assert.equal(reportSubmission, undefined, "the retired Reporter answer route is absent");
	await settleDeliveries(second.harness, context);
	const retained = await second.harness.commit((tx) => retainedReceipt(tx, deliverySubmission.id), context);
	assert.equal(retained?.ownerId, storageId);
});

it("reconciles an existing local child before Reporter admission", { timeout: 10000 }, async (t) => {
	const route = createRoute();
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	registry.install({ name: "request-routes", sections: [requestContextSection(harness)], hooks: [Durable.hook(Durable.GenerationTask, requestContextHooks(harness))] });
	const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions: "OLD CHILD INSTRUCTIONS" } }, context);
	await child.commit(async (tx) => { const meta = await tx.doc(AgentMetaDoc, child.id); meta.name = "Retained child"; meta.owner = "original-founder"; }, context);
	route.script.push({ tool: "agent_send", args: { sessionId: `${storageId}:${child.id}`, message: "CONTRACT: reply RETAINED", checkInMinutes: 0 } });
	await say(root, "Contact the retained child");
	await settle(harness, root.id);
	const messages = route.requests.find((messages) => messages.some((message) => message.role === "user" && messageText(message) === "CONTRACT: reply RETAINED"));
	assert.ok(messages);
	const prompt = getCurrentSystemPrompt(messages);
	assert.doesNotMatch(prompt, /OLD CHILD INSTRUCTIONS/u);
	assert.ok(prompt.includes(`${storageId}:${child.id}`));
	assert.ok(prompt.includes("Retained child"));
	assert.ok(JSON.stringify(messages).includes(`\\"requester\\":\\"${storageId}\\"`));
	assert.ok(JSON.stringify(messages).includes(`\\"replyTo\\":\\"${storageId}\\"`));
	assert.match(prompt, /mode: report/u);
	assert.equal((await readProfile(harness, storageId, child.id, context)).creator, "original-founder");
});

for (const conflictingProfile of [false, true]) it(`resumes an accepted Reporter beyond explicit-route capacity with profile conflict=${conflictingProfile}`, { timeout: 10000 }, async (t) => {
	assert.equal(REQUEST_CONTEXT_LIMIT, 128);
	const directory = mkdtempSync(join(tmpdir(), "retained-reporter-"));
	const storagePath = join(directory, "agent.sqlite");
	const { registry, extension } = buildRegistry(undefined, false);
	const reporter = extension.tasks?.find((task) => task.definition.name === "agent.reporter");
	assert.ok(reporter, "use the native contribution's actual Reporter task");
	let resumed: Durable.Harness | undefined;
	let childId: Durable.ConversationId;
	let observedRoutes: ActiveRequestContext[] = [];
	const warnings: unknown[] = [];
	const taskText = "Retained Reporter task";
	const models = createTestModels(async (request) => {
		const text = messageText(request.messages.findLast((message) => message.role === "user"));
		if (text === taskText) {
			assert.ok(resumed);
			observedRoutes = await readRequestContexts(resumed, childId, context);
			return fauxAssistantMessage("RETAINED-REPORTER-ANSWER");
		}
		return fauxAssistantMessage("NOTED");
	});
	const first = await Durable.Harness.open(await openNodeSqliteStorage(storagePath), { models, registry }, context);
	t.after(async () => { await resumed?.close(context); await first.close(context); rmSync(directory, { recursive: true, force: true }); });
	const owner = await first.root(context, { agent: { model } });
	const child = await first.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions: "Retained child instructions" } }, context);
	childId = child.id;
	const recipient = await first.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const taskId = await owner.commit((tx) => tx.createTask(reporter as Durable.Task<Durable.JsonObject, { phase: string }, null, object>, { name: "Retained child", conversationId: child.id, message: taskText, whenBusy: "followUp", reportTo: recipient.id, checkInMinutes: 0 }, { ownership: { kind: "conversation" }, conversationId: owner.id, background: true }), context);
	await child.commit(async (tx) => {
		const meta = await tx.doc(AgentMetaDoc, child.id);
		meta.name = "Retained child";
		meta.owner = "retained-founder";
		if (conflictingProfile) (await tx.doc(ProfileDoc, child.id)).identity = "different-storage";
		for (let index = 0; index < REQUEST_CONTEXT_LIMIT; index++) await recordRequestContext(tx, child.id, { requestId: `occupied-${index}`, requester: "queued-requester", replyTo: "queued-recipient", origin: "model" });
	}, context);
	assert.equal((await readRequestContexts(first, child.id, context)).length, REQUEST_CONTEXT_LIMIT);
	await first.close(context);

	resumed = await Durable.Harness.open(await openNodeSqliteStorage(storagePath), { models, registry, onReport: (report) => warnings.push(report.error) }, context);
	registry.install({ name: "retained-request-routes", sections: [requestContextSection(resumed)] });
	const settled = await resumed.waitForTask(taskId, context);
	assert.equal(settled.state.outcome.status, "completed");
	const reopenedRecipient = await resumed.conversation(recipient.id, context);
	await reopenedRecipient?.waitForIdle(context);
	const requestId = `agent-deliver:${taskId}`;
	assert.equal(observedRoutes.length, REQUEST_CONTEXT_LIMIT + 1, "accepted Reporter retains its route without evicting the occupied slots");
	assert.deepEqual(observedRoutes.find((route) => route.requestId === requestId), { requestId, requester: storageId, replyTo: `${storageId}:${recipient.id}`, origin: "model", status: "placed" });
	assert.equal((await userTexts(resumed, child.id)).filter((text) => text === taskText).length, 1);
	assert.equal((await userTexts(resumed, recipient.id)).filter((text) => text.includes("RETAINED-REPORTER-ANSWER")).length, 0, "Reporter does not deliver answer bodies");
	assert.equal((await userTexts(resumed, owner.id)).length, 0, "an explicit reply recipient does not become the requester");
	const delivery = await resumed.commit((tx) => tx.submissionByRequest(child.id, requestId), context);
	const report = await resumed.commit((tx) => tx.submissionByRequest(recipient.id, `agent-report:${taskId}`), context);
	assert.equal(delivery?.status, "done");
	assert.equal(report, undefined);
	await settleDeliveries(resumed, context);
	assert.ok(delivery);
	const receipt = await resumed.commit((tx) => retainedReceipt(tx, delivery.id), context);
	assert.equal(receipt?.ownerId, `${storageId}:${recipient.id}`);
	assert.equal((await readRequestContexts(resumed, child.id, context)).length, REQUEST_CONTEXT_LIMIT);
	await assert.rejects(resumed.commit((tx) => recordRequestContext(tx, child.id, { requestId: "new-over-capacity", requester: "new-requester", replyTo: "new-recipient", origin: "model" }), context), /unfinished request routes/u);
	if (conflictingProfile) assert.ok(warnings.some((warning) => String(warning).includes("Profile identity differs")), "optional profile repair reports its failure without failing the retained task");
	else assert.deepEqual(warnings, []);
});

it("resolves a namespaced native handle before applying self-control restrictions", async (t) => {
	const route = createRoute();
	const id = handleStorageId("native", testCwd);
	const { registry } = buildRegistry(async (method) => { assert.equal(method, "resolve-target"); return id; }, true, id, testCwd);
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_abort", args: { sessionId: "@native" } });
	await say(root, "Try self abort");
	const outcome = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_abort");
	assert.equal(outcome?.isError, true);
	assert.match(outcome?.text ?? "", /self|calling|itself/iu);
});

it("checks the resolved identity before an alias can abort the caller", async (t) => {
	const route = createRoute();
	const calls: string[] = [];
	const { registry } = buildRegistry(async (method) => { calls.push(method); if (method === "resolve-target") return storageId; throw new Error("unexpected abort dispatch"); });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_abort", args: { sessionId: "remote-alias", background: true } });
	await say(root, "Try alias abort");
	const outcome = (await toolOutcomes(harness, root.id)).find((entry) => entry.name === "agent_abort");
	assert.match(outcome?.text ?? "", /abort scope includes the calling conversation/u);
	assert.deepEqual(calls, ["resolve-target"]);
});

it("dispatches release to the resolved target and refuses a timer combination", async (t) => {
	const route = createRoute();
	const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
	const { registry } = buildRegistry(async (method, params) => {
		calls.push({ method, params });
		if (method === "resolve-target") return "canonical-remote";
		if (method === "release") return { retiring: false, blockers: ["active work"], writesPlaced: 0 };
		if (method === "abort") return { identity: "canonical-remote", background: true };
		throw new Error(`unexpected ${method}`);
	});
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_abort", args: { sessionId: "alias", release: true } });
	await say(root, "Release the remote host");
	assert.deepEqual(calls.map((call) => call.method), ["resolve-target", "release"]);
	assert.equal(calls[1].params.sessionId, "canonical-remote");
	route.script.push({ tool: "agent_abort", args: { sessionId: "alias", release: true, timerId: 1 } });
	await say(root, "Reject release with a timer");
	assert.match((await toolOutcomes(harness, root.id)).find((entry) => entry.name === "agent_abort")?.text ?? "", /cannot be combined with timerId/u);
	assert.equal(calls.length, 2);
	route.script.push({ tool: "agent_abort", args: { sessionId: "alias", release: true, background: true } });
	await say(root, "Reject release with background");
	assert.match((await toolOutcomes(harness, root.id)).find((entry) => entry.name === "agent_abort")?.text ?? "", /release cannot be combined with background; abort with background first, then release/u);
	assert.equal(calls.length, 2);
	route.script.push({ tool: "agent_abort", args: { sessionId: "alias", background: true } });
	await say(root, "Abort background work");
	assert.deepEqual(calls.slice(2).map((call) => call.method), ["resolve-target", "abort"]);
	assert.equal(calls.at(-1)?.params.background, true);
});

it("reports unavailable native release without inferring global host absence", async t => {
	const route = createRoute();
	const { registry } = buildRegistry(async method => {
		if (method === "resolve-target") return "canonical-remote";
		if (method === "release") throw new Error("No verified native host endpoint; writer release is unconfirmed");
		throw new Error(`unexpected ${method}`);
	});
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_abort", args: { sessionId: "alias", release: true } });
	await say(root, "Release a cold host");
	const output = (await toolOutcomes(harness, root.id)).find(entry => entry.name === "agent_abort")?.text ?? "";
	assert.match(output, /writer release is unconfirmed/u);
	assert.doesNotMatch(output, /not running/u);
});

it("a local abort closes the open work of the target and of each conversation below it", async (t) => {
	/** A live task that owns a conversation below the abort target and ends only at an abort. */
	const HoldTask = Durable.defineTask<Record<string, never>, { phase: "hold" }, null>({
		name: "fixture.hold",
		version: 1,
		initial: () => ({ phase: "hold" }),
		phases: { hold: async (task, runtime, taskContext) => { await runtime.sleepUntil(Number.MAX_SAFE_INTEGER, task.state.checkpoint, taskContext); } },
		abort: (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
	});
	const route = createRoute();
	const holder: DispatchHolder = {};
	const dispatch: AgentControlDispatch = async (method, params, callContext) => method === "resolve-target" ? params.sessionId : createDispatch(holder, [])(method, params, callContext);
	const { registry } = buildRegistry(dispatch);
	registry.install(Durable.defineExtension({ name: "fixture.hold", tasks: [HoldTask] }));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => { await harness.close(context); });
	const child = await spawnChild(harness, root, route, "stopped-parent", "PARENT");
	const childIdentity = `${storageId}:${child.conversationId}`;
	const owner = await harness.commit((tx) => tx.createTask(HoldTask, {}, { ownership: { kind: "conversation" }, conversationId: child.conversationId }), context);
	const below = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id, context);
	// Each conversation has one placed routed input and its declared open work without a dependency.
	for (const [conversationId, requestId, replyTo] of [[child.conversationId, "parent-task", "requester-outside"], [below, "below-task", childIdentity]] as const) {
		await harness.commit(async (tx) => {
			await recordRequestContext(tx, conversationId, { requestId, requester: replyTo, replyTo, origin: "model" });
			const entry = await tx.appendEntry(conversationId, { kind: "agent.input", data: { author: { role: "agent", identity: replyTo } }, model: [{ role: "user", content: "Task", timestamp: 1 }] });
			const submission = await tx.createSubmission({ conversationId, requestId, type: "input", status: "placed", entry: entry.id });
			(await tx.doc(Durable.LiveDoc, conversationId)).run = { taskId: 999_999 as Durable.TaskId, inputs: [submission.id], turns: 0 };
		}, context);
		const declared = await harness.commit((tx) => declareOpenWork(tx, storageId, conversationId, { results: [], note: "owes a final result" }, 10), context);
		assert.ok(!("error" in declared), JSON.stringify(declared));
	}
	const work = async (conversationId: Durable.ConversationId) => {
		const [item] = await harness.commit((tx) => openWorkStatus(tx, storageId, conversationId), context);
		assert.ok(item);
		return { state: item.state, ...(item.close === undefined ? {} : { status: item.close.status, delivery: item.close.delivery }) };
	};
	route.script.push({ tool: "agent_abort", args: { sessionId: childIdentity } });
	await say(root, "ABORT");
	const outcome = (await toolOutcomes(harness, root.id)).find((entry) => entry.name === "agent_abort");
	assert.equal(outcome?.isError, false, outcome?.text);
	assert.deepEqual(await work(child.conversationId), { state: "closed", status: "stopped", delivery: "active" }, "the requester outside the scope gets the final report");
	assert.deepEqual(await work(below), { state: "closed", status: "stopped", delivery: "terminal" }, "a report to the stopped target is kept out of delivery");
});

it("refuses an owner abort that crosses the caller's background anchor", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const dispatch: AgentControlDispatch = async (method, params, callContext) => method === "resolve-target" ? params.sessionId : createDispatch(holder, [])(method, params, callContext);
	const { registry } = buildRegistry(dispatch);
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(() => harness.close(context));
	const child = await spawnChild(harness, root, route, "owner-abort", "ready");
	const conversation = await harness.conversation(child.conversationId, context);
	assert.ok(conversation);
	route.script.push({ tool: "agent_abort", args: { sessionId: storageId, background: true } });
	await say(conversation, "Try owner abort");
	let outcome = (await toolOutcomes(harness, child.conversationId)).find((entry) => entry.name === "agent_abort");
	assert.match(outcome?.text ?? "", /abort scope includes the calling conversation/u);
	route.script.push({ tool: "agent_abort", args: { sessionId: storageId } });
	await say(conversation, "Abort owner without background");
	outcome = (await toolOutcomes(harness, child.conversationId)).find((entry) => entry.name === "agent_abort");
	assert.equal(outcome?.isError, false, outcome?.text);
});

it("drives one model-issued call per control tool", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls), true, storageId, join(testCwd, "durable"));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	const child = await spawnChild(harness, root, route, "alpha", "ALPHA");
	const childSessionId = `${storageId}:${child.conversationId}`;

	const run = async (tool: string, args: Durable.JsonObject): Promise<void> => {
		route.script.push({ tool, args });
		await say(root, `RUN ${tool}`);
	};

	await run("agent_send", { sessionId: childSessionId, message: "CONTRACT: reply BETA" });
	await settle(harness, root.id);
	await run("agent_steer", { sessionId: childSessionId, message: "CONTRACT: reply GAMMA" });
	await settle(harness, root.id);
	await run("agent_fork", { sessionId: childSessionId, name: "forked", prompt: "CONTRACT: reply FORK" });
	await settle(harness, root.id);
	const childEntries = await entriesOf(harness, child.conversationId);
	const lastAssistant = childEntries.find((entry) => entry.model?.[0]?.role === "assistant");
	assert.ok(lastAssistant, "the child has an assistant entry to rewind to");
	await run("agent_rewind", {
		sessionId: childSessionId,
		entryId: String(lastAssistant.id),
		correction: "CORRECTION reply DELTA",
		name: "repaired",
	});
	await settle(harness, root.id);
	await run("agent_configure", { sessionId: childSessionId, thinkingLevel: "high" });
	await run("agent_abort", { sessionId: childSessionId });
	await run("agent_attach", { sessionId: childSessionId });
	await run("agent_place", { area: `${testCwd}/.`, topic: "area-x", prompt: "CONTRACT: reply PLACE" });
	await settle(harness, root.id);
	await run("agent_status", { sessionId: childSessionId });
	await run("agent_profile", { action: "read", sessionId: childSessionId });
	await run("agent_intent", { action: "publish", purpose: "Tool contract", integration: "Compose the fixture", authority: "Synthetic fixture authority", scope: { paths: ["extensions/agent"], branches: ["topic"] } });
	await run("agent_list", {});
	await run("agent_collaborate", { action: "list" });
	await run("agent_inspect", { sessionId: childSessionId, view: "history" });
	await run("agent_compact", {});
	await run("agent_command", { sessionId: storageId, name: "echo", args: "hi" });
	await run("agent_reset", { sessionId: childSessionId, handoff: "fresh context" });
	await run("agent_abort", { sessionId: childSessionId, timerId: 3 });

	const outcomes = await toolOutcomes(harness, root.id);
	for (const tool of CONTROL_TOOLS) {
		const found = outcomes.filter((outcome) => outcome.name === tool);
		assert.ok(found.length >= 1, `${tool} was called`);
		assert.ok(
			found.some((outcome) => !outcome.isError),
			`${tool} succeeded`,
		);
	}
	const inspected = outcomes.find((outcome) => outcome.name === "agent_inspect");
	assert.match(inspected?.text ?? "", /inspection-evidence/u);
	const statusDetails = outcomes.find((outcome) => outcome.name === "agent_status")?.details as
		| { conversation?: { conversationId?: number } }
		| undefined;
	assert.ok(statusDetails?.conversation, "status carries validated structured content");
	const listDetails = outcomes.find((outcome) => outcome.name === "agent_list")?.details as
		| { rows?: unknown[] }
		| undefined;
	assert.ok(Array.isArray(listDetails?.rows), "list carries validated structured content");
	const inspectDetails = inspected?.details as { view?: string } | undefined;
	assert.equal(inspectDetails?.view, "history", "inspect carries validated structured content");
	const commanded = outcomes.find((outcome) => outcome.name === "agent_command");
	assert.match(commanded?.text ?? "", /command:echo/u);

	const agentState = await harness.snapshot(Durable.AgentDoc, child.conversationId, context);
	assert.equal(agentState?.thinkingLevel, "high", "configure applied the thinking level");

	const children = await harness.snapshot(TestChildren, root.id, context);
	assert.equal(children?.children.length, 3, "spawn, fork, and rewind each recorded one child");
	for (const childRecord of children?.children ?? []) {
		if (childRecord.conversationId === undefined) continue;
		const stored = await harness.snapshot(Durable.AgentDoc, childRecord.conversationId, context);
		assert.ok(stored?.model, `${childRecord.name} stores an explicit model`);
		assert.ok(stored?.thinkingLevel, `${childRecord.name} stores an explicit thinking level`);
	}
	const placed = calls.find((call) => call.method === "place");
	assert.ok(placed, "place used the host dispatch");
	assert.equal(placed.params.area, testCwd, "the place area is normalized");
	assert.equal(placed.params.topic, "area-x");
	assert.match(String(placed.params.requestId), /^place:test-storage:\d+$/u);
	assert.equal(placed.params.senderIdentity, storageId);

	assert.ok(
		calls.some((call) => call.method === "status"),
		"status used the host observation",
	);
	assert.ok(
		calls.some((call) => call.method === "profile-list"),
		"list used the host observation",
	);
	assert.ok(
		calls.some((call) => call.method === "inspect"),
		"inspect used the host observation",
	);
	const listed = calls.find((call) => call.method === "profile-list");
	assert.equal(listed?.params.global, true, "list requests the global catalog");
	const configured = calls.find((call) => call.method === "configure");
	assert.ok(configured, "configure used the host dispatch");
	assert.equal(configured.params.senderIdentity, storageId);
	assert.match(String(configured.params.requestId), /^configure:test-storage:\d+$/u);
	const compact = calls.find((call) => call.method === "compact");
	assert.equal(compact, undefined, "self-compaction stays native");
	const command = calls.find((call) => call.method === "command");
	assert.equal(command?.params.name, "echo");
});

it("returns an explicit error result for a missing conversation and a missing dispatch", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	route.script.push({ tool: "agent_attach", args: { sessionId: `${storageId}:999999` } });
	await say(root, "MISSING");
	const missing = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_attach");
	assert.equal(missing?.isError, true, "a missing conversation is an error result");
	assert.match(missing?.text ?? "", /not retained/u);

	const routeBare = createRoute();
	const bare = buildRegistry();
	const opened = await openHarness(new Durable.MemoryStorage(), bare.registry, createTestModels(routeBare.route));
	routeBare.script.push({ tool: "agent_status", args: {} });
	await say(opened.root, "STATUS");
	const unavailable = (await toolOutcomes(opened.harness, opened.root.id)).find(
		(outcome) => outcome.name === "agent_status",
	);
	assert.equal(unavailable?.isError, true, "a missing dispatch callback is an error result");
	assert.match(unavailable?.text ?? "", /unavailable/u);
	await opened.harness.close(context);
});

it("applies a self-compaction after the whole tool batch and continues the run", async (t) => {
	const route = createRoute();
	route.batch.push([
		{ tool: "agent_compact", args: {} },
		{ tool: "sibling-probe", args: {} },
	]);
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route), {
		compaction: { keepRecentTokens: 1 },
	});
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	await say(root, "SELFTEST");

	const entries = await entriesOf(harness, root.id);
	const compaction = entries.find((entry) => entry.kind === "pi.compaction");
	assert.ok(compaction, "the batch placed a compaction entry");
	assert.ok(compaction.head !== undefined, "the compaction sets the kept range");
	assert.match(messageText(compaction.model?.[0]), /SUMMARY-OF-EARLIER-CONTEXT/u);

	const postBatch = route.requests.find((messages) =>
		messages.some((message) => message.role === "user" && messageText(message).includes("SUMMARY-OF-EARLIER-CONTEXT")),
	);
	assert.ok(postBatch, "the next request carries the summary");
	const text = postBatch.map((message) => messageText(message)).join("\n");
	assert.match(text, /SIBLING-OK/u, "the next request carries the sibling result");
	assert.match(text, /Self-compaction requested/u, "the next request carries the compact result");
	assert.ok(
		postBatch.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.name === "sibling-probe"),
		),
		"the whole batch assistant entry is kept",
	);
	assert.ok(
		!postBatch.some((message) => message.role === "user" && messageText(message).includes("SELFTEST")),
		"the dropped prefix is gone",
	);
});

it("spawns a native child through the existing temporary-directory alias", async (t) => {
	if (testCwdAlias === testCwd) { t.skip("the system temporary directory has no distinct canonical spelling"); return; }
	const linkedCwd = testCwdAlias;
	const route = createRoute();
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch({}, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(async () => { await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { name: "linked", cwd: linkedCwd, prompt: "CONTRACT: reply LINKED", checkInMinutes: 0 } });
	await say(root, "SPAWN");
	await settle(harness, root.id);
	const child = (await harness.snapshot(TestChildren, root.id, context))?.children[0];
	assert.ok(child?.conversationId !== undefined, "the child uses the caller's storage");
	assert.equal(child.foreignSessionId, undefined);
	assert.equal(calls.some((call) => call.method === "spawn"), false, "no foreign host spawn occurs");
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_spawn");
	assert.ok(outcome);
	assert.equal(outcome.isError, false);
	const reference = (outcome.details as { result: { sessionId: string; submissionId: number; requestId: string } }).result;
	assert.equal(reference.sessionId, `${storageId}:${child.conversationId}`);
	const admitted = await harness.commit((tx) => tx.submissionByRequest(child.conversationId as Durable.ConversationId, reference.requestId), context);
	assert.equal(admitted?.id, reference.submissionId);
	assert.ok(outcome.text.startsWith(`Spawned linked as conversation ${reference.sessionId} in your storage. The prompt was admitted and the answer will report back.\nResult: ${JSON.stringify(reference)}\nExecution selection: `));
});

it("includes the busy-run boundary in native report receipts", async (t) => {
	const route = createRoute();
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(async (method, params) => {
		calls.push({ method, params: { ...params } });
		return { sourceId: "report-source", acknowledged: false };
	});
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(async () => { await harness.close(context); });
	route.script.push({ tool: "agent_send", args: { sessionId: "other-storage", message: "Progress", mode: "report" } });
	await say(root, "REPORT");
	assert.equal(calls[0]?.method, "report");
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_send");
	assert.ok(outcome && !outcome.isError);
	assert.match(outcome.text, /report to a busy Durable agent normally waits for the current run to end/u);
	assert.match(outcome.text, /A report sent from an ordinary primary uses explicit admission/u);
	assert.match(outcome.text, /even from an unrelated sender/u);
	assert.match(outcome.text, /A report sent from a native Durable agent uses retained report provenance/u);
	assert.match(outcome.text, /only a named awaited producer's report releases the wait/u);
	assert.match(outcome.text, /unrelated native reports stay queued/u);
	assert.match(outcome.text, /Automatic native Reporter result copies remain raw follow-ups/u);
	assert.match(outcome.text, /Use steer.*next tool boundary/u);
	assert.match(outcome.text, /reports to ordinary primaries use steer/u);
});

for (const adjusted of [false, true]) it(`spawns a child in a new storage and preserves its thinking adjustment (${adjusted})`, async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	holder.spawnSessionId = "other-storage:7";
	if (adjusted) holder.spawnThinking = { requested: "max", effective: "off" };
	t.after(async () => {
		await harness.close(context);
	});
	route.script.push({
		tool: "agent_spawn",
		args: { name: "remote", cwd: "/elsewhere", prompt: "CONTRACT: reply REMOTE" },
	});
	await say(root, "SPAWN");

	const spawn = calls.find((call) => call.method === "spawn");
	assert.ok(spawn, "spawn used the host dispatch");
	assert.equal(spawn.params.senderIdentity, storageId, "the root identity is the bare storage id");
	assert.match(String(spawn.params.requestId), /^spawn:test-storage:\d+$/u);
	assert.equal(spawn.params.cwd, "/elsewhere");
	const state = await harness.snapshot(TestChildren, root.id, context);
	const child = state?.children.find((candidate) => candidate.name === "remote");
	assert.equal(child?.foreignSessionId, "other-storage:7");
	assert.equal(child?.conversationId, undefined, "no local conversation is created");
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_spawn");
	assert.ok(outcome && !outcome.isError, "the spawn result is not an error");
	const reference = (outcome.details as { result: { sessionId: string; submissionId: number; requestId: string } }).result;
	assert.deepEqual(reference, { sessionId: "other-storage:7", submissionId: 23, requestId: spawn.params.requestId });
	assert.equal(outcome.text, `Spawned remote in /elsewhere as other-storage:7 with its own storage and host. The prompt was admitted and the answer will report back.\nResult: ${JSON.stringify(reference)}${adjusted ? "\nThinking level: requested max; effective off." : ""}`);
	assert.deepEqual((outcome.details as { thinking?: unknown }).thinking, holder.spawnThinking);
});

it("omits retained creation detail from compact storage status without changing child records", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = { spawnSessionId: "foreign-child" };
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => { await harness.close(context); });
	const status = async (caller = root, args: Durable.JsonObject = {}) => {
		route.script.push({ tool: "agent_status", args });
		await say(caller, "STATUS");
		const outcome = (await toolOutcomes(harness, caller.id)).find((result) => result.name === "agent_status");
		assert.ok(outcome && !outcome.isError, outcome?.text);
		return outcome;
	};
	const empty = await status();
	assert.ok(!empty.text.includes("Created agents"));
	route.script.push({ tool: "agent_spawn", args: { name: "native" } });
	await say(root, "SPAWN");
	route.script.push({ tool: "agent_spawn", args: { name: "foreign", cwd: "/elsewhere" } });
	await say(root, "SPAWN");
	const local = (await harness.snapshot(TestChildren, root.id, context))?.children[0];
	assert.ok(local?.conversationId !== undefined);
	const populated = await status();
	assert.equal(populated.text, empty.text);
	assert.deepEqual(populated.details, empty.details);
	assert.equal((populated.details as { format: string }).format, "compact");
	assert.ok((populated.details as { omitted: string[] }).omitted.includes("created-agent detail"));
	assert.equal((await harness.snapshot(TestChildren, root.id, context))?.children.length, 2, "presentation leaves creation records intact");
	assert.deepEqual(calls.filter((call) => call.method === "status").map((call) => call.params), [{}, {}]);
	const child = await harness.conversation(local.conversationId, context);
	assert.ok(child);
	assert.ok(!(await status(child)).text.includes("Created agents"), "a childless caller does not inherit its owner's registry");
	assert.ok(!(await status(root, { sessionId: storageId })).text.includes("Created agents"), "selected status stays unchanged");
});

it("refuses a self abort and continues the run", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	route.script.push({ tool: "agent_abort", args: { sessionId: storageId } });
	await say(root, "ABORT-SELF");
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_abort");
	assert.equal(outcome?.isError, true, "a self abort is refused");
	assert.match(outcome?.text ?? "", /calling conversation/u);
	const answers = await assistantTexts(harness, root.id);
	assert.ok(
		answers.some((text) => text.includes("DONE")),
		"the run continued after the refusal",
	);
});

it("sends stable request IDs for foreign fork and rewind", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	route.script.push({ tool: "agent_fork", args: { sessionId: "other-storage:1" } });
	await say(root, "FORK-FOREIGN");
	route.script.push({
		tool: "agent_rewind",
		args: { sessionId: "other-storage:1", entryId: "5", correction: "fix" },
	});
	await say(root, "REWIND-FOREIGN");

	const fork = calls.find((call) => call.method === "fork");
	assert.ok(fork, "foreign fork used dispatch");
	assert.match(String(fork.params.requestId), /^fork:test-storage:\d+$/u);
	assert.equal(fork.params.sessionId, "other-storage:1");
	const rewind = calls.find((call) => call.method === "rewind");
	assert.ok(rewind, "foreign rewind used dispatch");
	assert.match(String(rewind.params.requestId), /^rewind:test-storage:\d+$/u);
	assert.equal(rewind.params.entryId, "5");
	assert.equal(rewind.params.correction, "fix");
});

for (const minutes of [undefined, 0, 2.5]) it(`dispatches place with interval ${minutes}, resolved area, and stable request ID`, async (t) => {
	const prior = process.env.PI_AGENT_CHECK_IN_MINUTES;
	process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
	t.after(() => { if (prior === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES; else process.env.PI_AGENT_CHECK_IN_MINUTES = prior; });
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	holder.placeSessionId = "place-storage:7";
	const area = realpathSync(mkdtempSync(join(tmpdir(), "durable-agents-place-")));
	t.after(async () => {
		await harness.close(context);
		rmSync(area, { recursive: true, force: true });
	});
	route.script.push({
		tool: "agent_place",
		args: { area: `${area}/.`, topic: "far", prompt: "CONTRACT: reply FAR", ...(minutes === undefined ? {} : { checkInMinutes: minutes }) },
	});
	await say(root, "PLACE");

	const place = calls.find((call) => call.method === "place");
	assert.ok(place, "agent_place used the host dispatch");
	assert.equal(place.params.area, area, "the dispatched area is resolved");
	assert.equal(place.params.topic, "far");
	assert.equal(place.params.checkInMinutes, minutes, "the manager resolves absent intervals after preset selection");
	assert.ok(place.params.preferenceSnapshot);
	assert.match(String(place.params.requestId), /^place:test-storage:\d+$/u);
	assert.equal(place.params.senderIdentity, storageId);
	const outcome = (await toolOutcomes(harness, root.id)).find((result) => result.name === "agent_place");
	assert.ok(outcome && !outcome.isError, "the place result is not an error");
	assert.match(outcome.text, /place-storage:7/u);
});

it("forwards an object inspect cursor for pagination", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	holder.inspectPages = [
		{
			view: "history",
			format: "compact",
			sessionId: `${storageId}:1`,
			conversationId: 1,
			entries: [],
			nextCursor: { at: 7, tag: "more" },
			order: "newestFirst",
			detail: "page-one",
		},
		{
			view: "history",
			format: "compact",
			sessionId: `${storageId}:1`,
			conversationId: 1,
			entries: [],
			nextCursor: null,
			order: "newestFirst",
			detail: "page-two",
		},
	];
	t.after(async () => {
		await harness.close(context);
	});
	route.script.push({ tool: "agent_inspect", args: { view: "history", limit: 1 } });
	await say(root, "INSPECT-PAGE-ONE");
	const first = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_inspect");
	assert.ok(first, "the first inspect returned a result");
	const page = JSON.parse(first.text) as { nextCursor?: { at: number; tag: string } };
	assert.deepEqual(page.nextCursor, { at: 7, tag: "more" });
	const firstDetails = first.details as
		| { nextCursor?: { at: number; tag: string } }
		| undefined;
	assert.deepEqual(
		firstDetails?.nextCursor,
		{ at: 7, tag: "more" },
		"the validated structured content carries the cursor",
	);

	route.script.push({
		tool: "agent_inspect",
		args: { view: "history", cursor: page.nextCursor, limit: 1 },
	});
	await say(root, "INSPECT-PAGE-TWO");
	const inspects = calls.filter((call) => call.method === "inspect");
	assert.equal(inspects.length, 2, "both inspect calls reached the host");
	assert.deepEqual(inspects[1]?.params.cursor, { at: 7, tag: "more" }, "the object cursor is forwarded unchanged");
	const results = (await toolOutcomes(harness, root.id)).filter((outcome) => outcome.name === "agent_inspect");
	assert.equal(results.length, 2, "both inspect calls produced results");
	assert.ok(
		results.every((outcome) => !outcome.isError),
		"both inspect calls succeeded",
	);
});

it("renders the delegation guidance into the model-facing section", async () => {
	const { extension } = buildRegistry();
	const section = (extension.sections ?? []).find((candidate) => candidate.key === "agent-controls");
	assert.ok(section, "the contribution has the control section");
	const read = {
		snapshot: async () => undefined,
		snapshotAsOf: async () => undefined,
	} as unknown as Durable.PromptInput["read"];
	const input = {
		conversationId: Durable.ROOT_CONVERSATION_ID,
		agent: { thinkingLevel: "off" as const, extensions: [], tools: (extension.tools ?? []).filter((tool) => tool.deferred !== true), callable: (extension.tools ?? []).filter((tool) => tool.callers === undefined || tool.callers.includes("tools")), deferred: [], sections: [] },
		env: undefined,
		shown: {},
		read,
	};
	const text = await section.render(input, context);
	assert.ok(text, "the section renders when agent_spawn is offered");
	assert.match(text, /Spawn a background full agent session/u);
	assert.match(text, /Intent authority/u);
	assert.match(text, /Never poll with sleeps/u);
	assert.match(text, /Every conversation has an external identity/u);
	assert.doesNotMatch(text, /agent_detach/u);
	const exposed = extension.tools ?? [];
	assert.deepEqual(
		exposed.filter((tool) => tool.deferred === true).map((tool) => tool.name).sort(),
		["agent_attach", "agent_command", "agent_configure", "agent_fork", "agent_inspect", "agent_list", "agent_place", "agent_profile", "agent_reset", "agent_rewind"],
	);
	assert.deepEqual(exposed.filter((tool) => tool.callers?.includes("model") && !tool.callers.includes("tools")).map((tool) => tool.name).sort(), ["agent_compact"]);
	for (const name of ["agent_inspect", "agent_list", "agent_attach", "agent_place", "agent_fork", "agent_rewind", "agent_reset", "agent_configure", "agent_profile", "agent_command"])
		assert.doesNotMatch(text ?? "", new RegExp(`^- ${name}:`, "mu"), `${name} contributes no guidance until offered`);
	const deferredOnly = await section.render(
		{ ...input, agent: { ...input.agent, tools: exposed.filter((tool) => tool.name === "agent_list") } },
		context,
	);
	assert.ok(deferredOnly, "an offered deferred control renders its guidance");
	assert.match(deferredOnly, /^- agent_list: Find retained agent sessions$/mu);
	assert.doesNotMatch(deferredOnly, /- agent_spawn:/u);
	const withoutSpawn = await section.render(
		{
			...input,
			agent: { ...input.agent, tools: (extension.tools ?? []).filter((tool) => tool.name === "agent_status") },
		},
		context,
	);
	assert.ok(withoutSpawn, "status-only guidance still renders");
	assert.match(withoutSpawn, /- agent_status: Show agent session status/u);
	assert.match(withoutSpawn, /Never poll with sleeps/u);
	assert.doesNotMatch(withoutSpawn, /- agent_spawn:/u);
	const withoutControls = await section.render(
		{
			...input,
			agent: { ...input.agent, tools: (extension.tools ?? []).filter((tool) => !CONTROL_TOOLS.includes(tool.name)) },
		},
		context,
	);
	assert.equal(withoutControls, undefined, "no delegation section without any control");
});

it("returns the host configure outcome and refuses self configuration", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(async () => {
		await harness.close(context);
	});
	const child = await spawnChild(harness, root, route, "alpha", "ALPHA");
	const childSessionId = `${storageId}:${child.conversationId}`;
	holder.configureOutcome = "failed";
	route.script.push({ tool: "agent_configure", args: { sessionId: childSessionId, thinkingLevel: "high" } });
	await say(root, "CONFIGURE-FAILED");
	const failed = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_configure");
	assert.equal(failed?.isError, true, "a failed outcome is an error result");
	const details = failed?.details as { outcome?: string } | undefined;
	assert.equal(details?.outcome, "failed", "the outcome is structured");

	holder.configureOutcome = "applied";
	route.script.push({ tool: "agent_configure", args: { sessionId: storageId, thinkingLevel: "high" } });
	await say(root, "CONFIGURE-SELF");
	const selfOutcome = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_configure");
	assert.equal(selfOutcome?.isError, true, "self configuration is refused");
	assert.match(selfOutcome?.text ?? "", /calling conversation/u);
	assert.equal(calls.filter((call) => call.method === "configure").length, 1, "the self guard runs before dispatch");
});

it("arms native Reporter check-ins with the model default and releases them on settlement", async (t) => {
	const route = createRoute();
	let releaseAnswer: (message: AssistantMessage) => void = () => {};
	const answer = new Promise<AssistantMessage>((resolve) => { releaseAnswer = resolve; });
	const models = createTestModels((request, options, state, model) => {
		const last = request.messages.findLast((message) => message.role === "user");
		if (messageText(last).includes("CONTRACT: reply CHECKIN")) return answer;
		return typeof route.route === "function" ? route.route(request, options, state, model) : route.route;
	});
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models);
	holder.harness = harness;
	const previous = process.env.PI_AGENT_CHECK_IN_MINUTES;
	process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
	t.after(async () => {
		releaseAnswer(fauxAssistantMessage("ANSWER-CHECKIN"));
		await harness.close(context);
		if (previous === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES;
		else process.env.PI_AGENT_CHECK_IN_MINUTES = previous;
	});
	route.script.push({ tool: "agent_spawn", args: { name: "native-check", prompt: "CONTRACT: reply CHECKIN" } });
	await say(root, "SPAWN");
	await waitForChildGeneration(harness, root.id);
	const task = (await harness.inspect(context)).tasks.find((row) => row.record.kind === "agent.check-in");
	assert.ok(task);
	const input = task.record.input as { intervalMs: number; ownerId: string; senderIdentity: string };
	assert.equal(input.intervalMs, 420000);
	assert.equal(input.ownerId, storageId);
	assert.notEqual(input.senderIdentity, input.ownerId);
	releaseAnswer(fauxAssistantMessage("ANSWER-CHECKIN"));
	await harness.waitForTask(task.record.id, context);
	await settle(harness, root.id);
	assert.equal((await harness.inspect(context)).tasks.some((row) => row.record.kind === "agent.check-in"), false);
});

it("leaves native check-ins absent when the host registry supplies no deadline task", async (t) => {
	const route = createRoute();
	const storage = new Durable.MemoryStorage();
	const { registry } = buildRegistry(undefined, false);
	const { harness, root } = await openHarness(storage, registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	await spawnChild(harness, root, route, "plain-host", "HOST");
	const tasks = await storage.scanTasks({ kind: "agent.check-in" }, 10, undefined, context);
	assert.equal(tasks.items.length, 0, "the native contribution never supplies or faults a host-owned deadline task");
});

it("namespaces foreign admissions by source storage even when task IDs coincide", async (t) => {
	const keys: string[] = [];
	const receiver = new Set<string>();
	for (const source of ["left-storage", "right-storage"]) {
		const route = createRoute();
		const { registry } = buildRegistry(async (method, params) => {
			assert.equal(method, "submit");
			const key = String(params.requestId);
			keys.push(key);
			const deduped = receiver.has(key);
			receiver.add(key);
			return { submissionId: receiver.size, deduped };
		}, true, source);
		const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
		t.after(() => harness.close(context));
		route.script.push({ tool: "agent_send", args: { sessionId: "remote-storage", message: "Independent contribution", checkInMinutes: 0 } });
		await say(root, "SEND");
	}
	assert.equal(keys.length, 2);
	assert.equal(keys[0].split(":").at(-1), keys[1].split(":").at(-1), "the independent storages reused the same tool task number");
	assert.notEqual(keys[0], keys[1]);
	assert.equal(receiver.size, 2);
});

for (const mode of [undefined, "steer", "followUp"]) it(`honors immediate send disposition ${mode ?? "default followUp"}`, async (t) => {
	const route = createRoute();
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(async (method, params) => { calls.push({ method, params }); return { submissionId: 1, deduped: false }; });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_send", args: { sessionId: "remote-storage", message: "A time-sensitive correction", checkInMinutes: 0, ...(mode === undefined ? {} : { mode }) } });
	await say(root, "SEND");
	assert.equal(calls[0].method, "submit");
	assert.equal(calls[0].params.whenBusy, mode ?? "followUp", "a send without a mode is new work");
	assert.match(String(calls[0].params.requestId), /^agent-deliver:test-storage:\d+$/u);
});

it("dispatches collaboration with actual caller identity and a source-qualified replay key", async (t) => {
	const route = createRoute();
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(async (method, params) => { calls.push({ method, params }); return { threadId: "thread", sequence: 1, deduped: false }; });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_collaborate", args: { action: "post", threadId: "thread", message: "A supported finding", notify: [] } });
	await say(root, "COLLABORATE");
	assert.equal(calls[0].method, "collaboration-mutate");
	assert.equal(calls[0].params.senderIdentity, storageId);
	assert.equal(calls[0].params.origin, "model");
	assert.match(String(calls[0].params.requestId), /^collaboration:test-storage:\d+$/u);
});

it("keeps the fake model helpers honest", () => {
	assert.equal(messageText(fauxAssistantMessage("text")), "text");
	assert.equal(messageText(fauxAssistantMessage([fauxText("one"), fauxToolCall("t", {})])), "one");
});

/** Retained continuity facts of one conversation as [phase, target, request, submission or timer]. */
async function continuityFacts(harness: Durable.Harness, conversationId: Durable.ConversationId): Promise<Array<[string, string, string, number | undefined]>> {
	const state = await harness.snapshot(ContinuityDoc, conversationId, context);
	return (state?.events ?? []).map((event) => [event.phase, event.sessionId, event.requestId, event.submissionId ?? event.timerId]);
}

it("records a local request before its admission and then the admission with its exact submission", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(() => harness.close(context));
	const child = await spawnChild(harness, root, route, "worker", "FIRST");
	const target = `${storageId}:${child.conversationId}`;
	const spawned = await continuityFacts(harness, root.id);
	assert.deepEqual(spawned.map(([phase, sessionId]) => [phase, sessionId]), [["requested", target], ["admitted", target]]);
	const requestId = spawned[0][2];
	assert.match(requestId, /^agent-deliver:\d+$/u);
	assert.equal(spawned[1][2], requestId);
	const submission = await harness.commit((tx) => tx.submissionByRequest(child.conversationId, requestId), context);
	assert.equal(spawned[1][3], submission?.id, "the admitted fact names the target's submission of that request");
	assert.equal((await harness.snapshot(ContinuityDoc, root.id, context))?.events.every((event) => event.replyTo === storageId), true);

	route.script.push({ tool: "agent_send", args: { sessionId: target, message: "CONTRACT: reply SECOND", checkInMinutes: 0 } });
	await say(root, "SEND");
	await settle(harness, root.id);
	const sent = (await continuityFacts(harness, root.id)).slice(2);
	assert.deepEqual(sent.map(([phase, sessionId]) => [phase, sessionId]), [["requested", target], ["admitted", target]]);
	assert.notEqual(sent[0][2], requestId);
	assert.deepEqual(await continuityFacts(harness, child.conversationId), [], "the producer keeps no outgoing fact for work it received");
});

it("records a foreign request before the dispatch and closes or keeps it by what the receipt proves", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const before: Array<Array<[string, string, string, number | undefined]>> = [];
	const { registry } = buildRegistry(async (method, params) => {
		if (method !== "submit") return createDispatch(holder, [])(method, params);
		assert.ok(holder.harness);
		before.push(await continuityFacts(holder.harness, Durable.ROOT_CONVERSATION_ID));
		const requestId = String(params.requestId);
		if (params.sessionId === "remote-storage") return { submissionId: 41, deduped: false, result: { sessionId: "remote-storage", submissionId: 41, requestId } };
		if (params.sessionId === "primary-session") return { admitted: true, sourceId: "report:primary" };
		throw new Error("target unavailable");
	});
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(() => harness.close(context));
	for (const sessionId of ["remote-storage", "primary-session", "broken-storage"]) {
		route.script.push({ tool: "agent_send", args: { sessionId, message: "A bounded task", checkInMinutes: 0 } });
		await say(root, `SEND ${sessionId}`);
	}
	const facts = await continuityFacts(harness, root.id);
	const requestOf = (sessionId: string): string => facts.find(([phase, target]) => phase === "requested" && target === sessionId)?.[2] ?? "";
	assert.deepEqual(before.map((seen) => seen.map(([phase]) => phase)), [["requested"], ["requested", "admitted", "requested"], ["requested", "admitted", "requested", "refused", "requested"]], "each request is retained before its dispatch");
	assert.deepEqual(facts, [
		["requested", "remote-storage", requestOf("remote-storage"), undefined],
		["admitted", "remote-storage", requestOf("remote-storage"), 41],
		["requested", "primary-session", requestOf("primary-session"), undefined],
		["refused", "primary-session", requestOf("primary-session"), undefined],
		["requested", "broken-storage", requestOf("broken-storage"), undefined],
	]);
	for (const sessionId of ["remote-storage", "primary-session", "broken-storage"]) assert.match(requestOf(sessionId), /^agent-deliver:test-storage:\d+$/u);
	const outcomes = await toolOutcomes(harness, root.id);
	const failed = outcomes.filter((outcome) => outcome.isError);
	assert.equal(failed.length, 1);
	assert.match(failed[0].text, /target unavailable/u, "a failed dispatch keeps its request listed as unconfirmed");
});

it("records the prompt of an agent created in another storage once its identity exists", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_spawn", args: { name: "foreign", cwd: "/elsewhere", prompt: "CONTRACT: reply FOREIGN", checkInMinutes: 0 } });
	await say(root, "SPAWN");
	const facts = await continuityFacts(harness, root.id);
	assert.equal(facts.length, 1);
	assert.deepEqual([facts[0][0], facts[0][1], facts[0][3]], ["admitted", "other-storage", 23]);
	assert.match(facts[0][2], /^spawn:test-storage:\d+$/u);
});

it("lists a scheduled input with its timer and closes it only on a cancellation before firing", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	let timerId = 8;
	const { registry } = buildRegistry(async (method, params) => {
		if (method === "timer-schedule") return { timerId: ++timerId, conversationId: 1, identity: "remote-storage", deadline: params.deliverAt, mode: params.mode, origin: "model", scheduleId: params.scheduleId, deduped: false, disposition: "scheduled", status: "sleeping" };
		// Timer IDs are local to a storage: the other storage has its own timer 10, and one receipt names no identity.
		if (method === "timer-cancel") return { timerId: params.timerId, outcome: "marked", status: params.timerId === 11 ? "fired" : "cancelled", ...(params.sessionId === "unnamed-storage" ? {} : { identity: params.sessionId === "@handle" ? "remote-storage" : params.sessionId }) };
		return createDispatch(holder, [])(method, params);
	});
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	t.after(() => harness.close(context));
	const deliverAt = new Date(Date.now() + 3_600_000).toISOString();
	const calls: Array<{ tool: string; args: Durable.JsonObject }> = [
		{ tool: "agent_send", args: { sessionId: "@handle", message: "Later task", deliverAt } },
		{ tool: "agent_send", args: { sessionId: "@handle", message: "Second later task", deliverAt } },
		{ tool: "agent_send", args: { sessionId: "@handle", message: "Third later task", deliverAt } },
		{ tool: "agent_abort", args: { sessionId: "other-storage", timerId: 10 } },
		{ tool: "agent_abort", args: { sessionId: "unnamed-storage", timerId: 10 } },
		{ tool: "agent_abort", args: { sessionId: "@handle", timerId: 11 } },
		{ tool: "agent_abort", args: { sessionId: "@handle", timerId: 9 } },
	];
	for (const call of calls) {
		route.script.push(call);
		await say(root, `TIMER ${call.tool}`);
	}
	const facts = await continuityFacts(harness, root.id);
	assert.deepEqual(facts.map(([phase, sessionId, , id]) => [phase, sessionId, id]), [
		["requested", "remote-storage", 9],
		["requested", "remote-storage", 10],
		["requested", "remote-storage", 11],
		["refused", "remote-storage", undefined],
	], "a cancelled timer of another storage, a receipt without an identity and a fired timer close nothing");
	assert.match(facts[0][2], /^timer:test-storage:\d+:delivery$/u);
	assert.equal(facts[3][2], facts[0][2], "the handle's cancellation closes the request listed under the identity that the host resolved");
	assert.equal((await toolOutcomes(harness, root.id)).filter((outcome) => outcome.name === "agent_abort" && !outcome.isError).length, 4, "every cancellation itself succeeded");
});

it("starts a self-compaction's summarizer instructions with the continuity seed", async (t) => {
	const route = createRoute();
	route.batch.push([{ tool: "agent_compact", args: { instructions: "Keep the parser notes." } }]);
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route), { compaction: { keepRecentTokens: 1 } });
	holder.harness = harness;
	t.after(() => harness.close(context));
	await say(root, "SELFTEST");
	const summarizer = route.requests.map((messages) => messages.map((message) => messageText(message)).join("\n")).find((text) => text.includes("conversation to summarize"));
	assert.ok(summarizer, "the compaction asked the model for a summary");
	assert.ok(summarizer.includes(`${NATIVE_COMPACTION_SEED}\n\nKeep the parser notes.`), summarizer.slice(-600));
	const description = registry.snapshot().tools().find(({ tool }) => tool.name === "agent_compact")?.tool.description ?? "";
	assert.ok(description.includes(NATIVE_COMPACTION_SEED));
});
