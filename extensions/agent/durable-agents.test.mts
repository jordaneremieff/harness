/**
 * durable-agents tests: the native agent contribution in a real Harness.
 *
 * Pi-ai's faux provider drives native calls over MemoryStorage and retained
 * tasks over isolated SQLite. Reopen checks verify that accepted child work,
 * delivery, and reports do not duplicate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
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
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { type AgentContributionHost, type AgentControlDispatch, createAgentContribution, publishAgentControlDispatch } from "./durable-agents.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAgentExtension from "./index.ts";
import { CheckInTask, checkInMinutes } from "./durable-checkins.ts";
import { THINKING_LEVELS } from "./configuration.ts";
import { ProfileDoc, readProfile } from "./profile.ts";
import { readRequestContexts, recordRequestContext, REQUEST_CONTEXT_LIMIT, requestContextSection, type ActiveRequestContext } from "./request-context.ts";
import { handleStorageId } from "./identity.ts";
import { AgentMetaDoc, AgentDeliveryDoc, AwaitInputSuppressed, readOutcome, submitConversation } from "./durable-controls.ts";
import { AwaitDoc, type AwaitState, type AwaitOutcome } from "./awaited-results.ts";

import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry } from "./durable-host-fixture.mts";
import { readInspection } from "./durable-observation.ts";
import { AgentTimerDoc, scheduleTimer } from "./durable-timers.ts";

const context = BACKGROUND_CONTEXT;
const storageId = "test-storage";
const model = { provider: "faux", modelId: "faux-1" } as const;
const testCwdAlias = mkdtempSync(join(tmpdir(), "durable-agents-cwd-"));
const testCwd = realpathSync(testCwdAlias);
process.on("exit", () => {
	rmSync(testCwd, { recursive: true, force: true });
});

type ChildRecord = {
	readonly name: string;
	readonly conversationId?: Durable.ConversationId;
	readonly anchorTaskId?: Durable.TaskId;
	readonly foreignSessionId?: string;
	readonly createdBy: Durable.TaskId;
	reported: Durable.EntryId[];
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
});

const CONTROL_TOOLS = [
	"agent_abort",
	"agent_attach",
	"agent_await",
	"agent_collaborate",
	"agent_command",
	"agent_compact",
	"agent_configure",
	"agent_fork",
	"agent_inspect",
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
	agent_await: "safe",
	agent_collaborate: "safe",
	agent_spawn: "safe",
	agent_send: "safe",
	agent_steer: "safe",
	agent_fork: "safe",
	agent_rewind: "safe",
	agent_place: "safe",
	agent_profile: "safe",
	agent_inspect: "safe",
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
	if (sessionId === undefined) return { conversations: [], inventory: { contributions: [], ordinaryOnly: [] }, pid: 123, storageId };
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
	return { sessionId, ...(params.prompt === undefined ? {} : { result: { sessionId, submissionId: 23, requestId: params.requestId } }) };
}

async function nativeDispatchResult(holder: DispatchHolder, params: Readonly<Record<string, unknown>>, callContext: import("@earendil-works/chord").Context): Promise<unknown> {
	assert.ok(holder.harness);
	const reference = params.result as { submissionId: number; requestId?: string; sessionId: string };
	const input = await holder.harness.submission(reference.submissionId as Durable.SubmissionId, callContext);
	const record = await input?.status(callContext);
	assert.equal(record?.conversationId, sessionConversation(reference.sessionId));
	if (reference.requestId !== undefined) assert.equal(record?.requestId, reference.requestId);
	return readOutcome(holder.harness, reference.submissionId as Durable.SubmissionId, callContext);
}

function createDispatch(holder: DispatchHolder, calls: DispatchCalls): AgentControlDispatch {
	return async (method, params, callContext = context) => {
		calls.push({ method, params: { ...params } });
		switch (method) {
			case "status":
				return statusObservation(params);
			case "await-native": return nativeDispatchResult(holder, params, callContext);
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
			case "place":
				return { sessionId: holder.placeSessionId ?? "place-storage:1" };
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

const testServices: AgentContributionHost["services"] = { modelRuntime: { getModel: () => undefined } };

/** A test tool that shares the batch with agent_compact. */
const siblingExtension = Durable.defineExtension({
	name: "test-sibling",
	tools: [
		Durable.defineTool({
			name: "sibling-probe",
			description: "Return a fixed marker.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => ({ content: [{ type: "text" as const, text: "SIBLING-OK" }] }),
		}),
	],
});

function buildRegistry(dispatch?: AgentControlDispatch, checkIns = true, sourceStorageId = storageId, catalogRoot?: string): { registry: Durable.Registry; extension: Durable.Extension } {
	const registry = Durable.createRegistry();
	if (checkIns) registry.install(Durable.defineExtension({ name: "test.host", tasks: [CheckInTask] }));
	const contribution = createAgentContribution({
		source: "/abs/extensions/agent/index.ts",
		...(dispatch === undefined ? {} : { dispatch }),
	});
	const extension: Durable.Extension = contribution.create({
		durable: Durable,
		storageId: sourceStorageId,
		catalogRoot,
		cwd: testCwd,
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
	const root = await harness.root(context, { agent: { model } });
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
			watch.start(async (graph) => {
				if (running(graph)) resolve();
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
	const contribution = createAgentContribution({ source: "/abs/extensions/agent/index.ts" });
	assert.equal(contribution.name, "agent");
	assert.equal(contribution.source, "/abs/extensions/agent/index.ts");
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

it("forwards native await cancellation through the registered entrypoint contribution", { timeout: 30000 }, async (t) => {
	let contribution: ReturnType<typeof createAgentContribution> | undefined;
	registerAgentExtension({ events: { emit(event: string, value: unknown) { if (event === "durable:contribution") contribution = value as ReturnType<typeof createAgentContribution>; } }, on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as unknown as ExtensionAPI);
	assert.ok(contribution);
	let observed!: () => void;
	const observing = new Promise<void>((resolve) => { observed = resolve; });
	let cancelled = false;
	const restore = publishAgentControlDispatch(async (method, _params, requestContext) => {
		assert.equal(method, "receipts");
		const signal = requestContext?.abortSignal;
		assert.ok(signal, "the loaded contribution must retain invocation cancellation");
		observed();
		return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("Observation cancelled")); }, { once: true }));
	});
	t.after(restore);
	const registry = Durable.createRegistry();
	registry.install(contribution.create({ durable: Durable, storageId, cwd: testCwd, services: testServices }));
	const route = createRoute();
	route.script.push({ tool: "agent_await", args: { results: [{ sessionId: "remote-storage", submissionId: 77 }] } });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	const original = await root.submit({ type: "input", content: "Await a foreign result", requestId: "entrypoint-await" }, context);
	await Promise.race([observing, original.wait(context).then(() => { throw new Error("The original request ended before foreign observation"); })]);
	await root.abort(context);
	assert.equal((await original.wait(context)).status, "unanswered");
	await root.waitForIdle(context);
	assert.equal(cancelled, true);
});

it("keeps an aborted request unanswered while a late producer report starts an ordinary input", async (t) => {
	const route = createRoute();
	let finish!: (answer: AssistantMessage) => void;
	const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const models = createTestModels((...args) => {
		if (messageText(args[0].messages.findLast((message) => message.role !== "system")) === "HELD-AFTER-ABORT") return held;
		if (route.script.length > 0 && args[0].messages.some((message) => messageText(message) === "Reconsider the retained result")) return scriptedAnswer(route.batch, route.script);
		return route.route(...args);
	});
	const holder: DispatchHolder = {}; const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models); holder.harness = harness;
	t.after(async () => { finish(fauxAssistantMessage("RESULT")); await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { prompt: "HELD-AFTER-ABORT", name: "independent" } });
	await say(root, "Dispatch independent work");
	const outcome = (await toolOutcomes(harness, root.id)).find((item) => item.name === "agent_spawn");
	assert.ok(outcome);
	const result = (outcome.details as { structuredContent: { result: { sessionId: string; submissionId: number; requestId: string } } }).structuredContent.result;
	const ready = waitForAwait(harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool: "agent_await", args: { results: [result] } });
	const original = await root.submit({ type: "input", content: "Await independent work" }, context);
	await ready;
	const calls = route.requests.length;
	await root.abort(context);
	assert.equal((await original.wait(context)).status, "unanswered");
	finish(fauxAssistantMessage("RESULT"));
	await settle(harness, root.id);
	assert.equal(route.requests.length, calls + 1, "the late ordinary report uses one model turn without reviving the aborted request");
	assert.equal((await original.status(context)).status, "unanswered");
	route.script.push({ tool: "agent_await", args: { results: [result] } });
	await say(root, "Reconsider the retained result");
	const observed = await toolOutcomes(harness, root.id);
	const resumed = observed.findLast((item) => item.name === "agent_await" && item.isError !== true);
	assert.ok(resumed, JSON.stringify({ observed, queued: route.script.length, latestInput: route.requests.at(-1)?.map((message) => ({ role: message.role, text: messageText(message).slice(0, 160) })) }));
	assert.equal((resumed.details as { structuredContent: { results: { answer?: string }[] } }).structuredContent.results[0]?.answer, "RESULT", "a new explicit request still reads the retained producer result");
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

for (const tool of ["agent_spawn", "agent_send"]) it(`${tool} returns an admitted exact result before the background answer and arms one default check-in`, async (t) => {
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
	route.script.push({ tool, args: tool === "agent_spawn" ? { name: "exact-result", prompt: "CONTRACT: reply EXACT" } : { sessionId: `${storageId}:${existing.id}`, message: "CONTRACT: reply EXACT" } });
	await say(root, "Dispatch background work");
	const outcome = (await toolOutcomes(harness, root.id)).find((candidate) => candidate.name === tool);
	assert.equal(outcome?.isError, false, outcome?.text);
	const reference = (outcome?.details as { structuredContent?: { result?: { sessionId: string; submissionId: number; requestId: string } } })?.structuredContent?.result;
	assert.ok(reference);
	assert.ok(outcome?.text.includes(JSON.stringify(reference)));
	const conversationId = Number(reference.sessionId.split(":")[1]) as Durable.ConversationId;
	const admitted = await harness.commit((tx) => tx.submissionByRequest(conversationId, reference.requestId), context);
	assert.equal(admitted?.id, reference.submissionId);
	assert.equal(admitted?.conversationId, conversationId);
	assert.ok(admitted?.status === "queued" || admitted?.status === "placed");
	const checkIns = (await harness.inspect(context)).tasks.filter((task) => task.record.kind === CheckInTask.definition.name);
	assert.equal(checkIns.length, 1, "the tool and Reporter share one admission marker");
});

it("keeps the original input placed while one native await accepts two exact results without provider turns", { timeout: 30000 }, async (t) => {
	const route = createRoute();
	const finishes: Array<(answer: AssistantMessage) => void> = [];
	const held = [0, 1].map(() => new Promise<AssistantMessage>((resolve) => finishes.push(resolve)));
	const models = createTestModels((...args) => {
		const last = args[0].messages.findLast((message) => message.role !== "system");
		const task = messageText(last);
		return last?.role === "user" && task.startsWith("HELD-") ? held[Number(task.slice(5))] : route.route(...args);
	});
	const holder: DispatchHolder = {};
	const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models);
	holder.harness = harness;
	t.after(async () => { for (const finish of finishes) finish(fauxAssistantMessage("FINISHED")); await harness.close(context); });
	const results = [];
	for (const index of [0, 1]) {
		const producer = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const input = await producer.submit({ type: "input", content: `HELD-${index}`, requestId: `exact:${index}` }, context);
		results.push({ sessionId: `${storageId}:${producer.id}`, submissionId: input.id, requestId: `exact:${index}` });
	}
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const watch = await harness.watchDoc(AwaitDoc, context);
	assert.ok(watch);
	let ready!: () => void;
	let first!: () => void;
	const declared = new Promise<void>((resolve) => { ready = resolve; });
	const accepted = new Promise<void>((resolve) => { first = resolve; });
	watch.start(async (state) => { if (state?.declarations.some((item) => item.decision === "awaiting")) ready(); if (state?.declarations.some((item) => item.outcomes.length === 1)) first(); });
	t.after(() => watch.stop());
	route.script.push({ tool: "agent_await", args: { results } });
	const original = await root.submit({ type: "input", content: "Await both exact inputs" }, context);
	await declared;
	const calls = route.requests.length;
	assert.equal((await original.status(context)).status, "placed");
	finishes[0](fauxAssistantMessage("RESULT-ONE"));
	await accepted;
	assert.equal((await original.status(context)).status, "placed");
	assert.equal(route.requests.length, calls, "accepted partial results do not invoke the provider");
	finishes[1](fauxAssistantMessage("RESULT-TWO"));
	assert.equal((await original.wait(context)).status, "done");
	const output = (await toolOutcomes(harness, root.id)).find((item) => item.name === "agent_await");
	assert.equal(output?.isError, false, output?.text);
	assert.ok(output?.text.includes("RESULT-ONE") && output.text.includes("RESULT-TWO"));
});

async function waitForAwait(harness: Durable.Harness, predicate: (state: AwaitState) => boolean): Promise<void> {
	const watch = await harness.watchDoc(AwaitDoc, context);
	assert.ok(watch);
	try {
		await new Promise<void>((resolve) => {
			watch.start(async (state) => { if (state && predicate(state)) resolve(); });
			void harness.snapshot(AwaitDoc, context).then((state) => { if (state && predicate(state)) resolve(); });
		});
	} finally { await watch.stop(); }
}

for (const event of ["explicit", "report", "automatic", "abort", "reset", "failure", "unavailable"] as const) it(`native await handles ${event} without ending the original request early`, { timeout: 10000 }, async (t) => {
	const route = createRoute();
	let finish!: (answer: AssistantMessage) => void;
	const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const models = createTestModels((...args) => messageText(args[0].messages.findLast((message) => message.role !== "system")) === "HELD-RESULT" ? held : route.route(...args));
	const holder: DispatchHolder = {}; const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models); holder.harness = harness;
	t.after(async () => { finish(fauxAssistantMessage("RESULT")); await harness.close(context); });
	const producer = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const source = await producer.submit({ type: "input", content: "HELD-RESULT", requestId: "held-source" }, context);
	const result = { sessionId: `${storageId}:${producer.id}`, submissionId: event === "unavailable" ? 99999 : source.id, ...(event === "unavailable" ? {} : { requestId: "held-source" }) };
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const ready = waitForAwait(harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool: "agent_await", args: { results: [result] } });
	const original = await root.submit({ type: "input", content: "AWAIT" }, context);
	const readiness = await Promise.race([ready.then(() => "ready"), original.wait(context).then(() => "ended")]);
	assert.equal(readiness, "ready", JSON.stringify(await toolOutcomes(harness, root.id)));
	const calls = route.requests.length;
	if (event === "automatic") {
		await assert.rejects(submitConversation(root, { message: "NAMED CHECK-IN", requestId: "named-check", provenance: { classification: "automatic", automaticKind: "checkIn", sender: result.sessionId, producerRequestId: result.requestId } }, context), AwaitInputSuppressed);
		const timer = await submitConversation(root, { message: "TIMER INPUT", requestId: "timer-input", whenBusy: "steer", provenance: { classification: "automatic", automaticKind: "timer" } }, context);
		assert.equal(route.requests.length, calls); assert.equal((await original.status(context)).status, "placed");
		assert.equal((await harness.snapshot(Durable.InboxDoc, root.id, context))?.items.find((item) => item.id === timer.submissionId)?.mode, "followUp");
		finish(fauxAssistantMessage("RESULT")); await original.wait(context);
	} else if (event === "explicit" || event === "report") {
		await submitConversation(root, { message: "CORRECTION INCLUDE", requestId: "interactive", whenBusy: "followUp", provenance: { classification: event, sender: result.sessionId } }, context);
		assert.equal((await original.wait(context)).status, "done");
		assert.ok(route.requests.some((messages) => messages.some((message) => messageText(message) === "CORRECTION INCLUDE")), "the original post-tools call sees the input");
		assert.equal((await source.status(context)).status, "placed", "release does not cancel peer work");
	} else if (event === "reset") {
		await root.reset(undefined, context);
		assert.equal((await original.status(context)).status, "placed", "native reset is a queued passive write until the boundary");
		assert.equal(route.requests.length, calls);
		finish(fauxAssistantMessage("RESULT")); assert.equal((await original.wait(context)).status, "unanswered", "the native reset retires the original input at its boundary");
	} else if (event === "abort") {
		await root.abort(context);
		const ended = await original.status(context); assert.equal(ended.status, "unanswered"); assert.equal(ended.reason, "aborted");
		assert.equal(route.requests.length, calls); assert.equal((await source.status(context)).status, "placed");
	} else {
		if (event === "failure") {
			const stopped = producer.abort(context);
			finish(fauxAssistantMessage("FINISHED"));
			await stopped;
		}
		assert.equal((await original.wait(context)).status, "done");
		const output = (await toolOutcomes(harness, root.id)).find((item) => item.name === "agent_await");
		assert.equal(output?.isError, false, output?.text);
		assert.ok(output?.text.includes(event === "failure" ? "unanswered" : "unavailable"));
	}
});

for (const tool of ["agent_spawn", "agent_send"] as const) it(`keeps an original ${tool} recipient await intact across admission and Reporter replay`, { timeout: 10000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "original-await-replay-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
	const route = createRoute(); let finish!: (message: AssistantMessage) => void;
	const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const foreign = await DurableHost.open({ storageId: "foreign", storagePath: join(directory, "foreign.sqlite"), cwd: directory, registry: fixtureRegistry(), models: createTestModels(() => held), agent: { model } }, context);
	t.after(async () => { finish(fauxAssistantMessage("DEPENDENCY-DONE")); await foreign.close(); });
	let releaseRecipient!: (message: AssistantMessage) => void;
	const recipientAnswer = new Promise<AssistantMessage>((resolve) => { releaseRecipient = resolve; });
	let recipientCalls = 0;
	const models = createTestModels((...args) => {
		const request = args[0]; const last = request.messages.findLast((message) => message.role !== "system");
		if (request.messages.some((message) => message.role === "user" && messageText(message) === "RECIPIENT-WAIT")) {
			recipientCalls++;
			return last?.role === "user" ? recipientAnswer : fauxAssistantMessage("RECIPIENT-DONE");
		}
		return route.route(...args);
	});
	const holder: DispatchHolder = {}; const base = createDispatch(holder, []);
	const dispatch: AgentControlDispatch = (method, params, ctx = context) => method === "receipts" ? foreign.request(method, params, ctx) : base(method, params, ctx);
	const { registry } = buildRegistry(dispatch);
	const path = join(directory, "caller.sqlite");
	const first = await openHarness(await openNodeSqliteStorage(path), registry, models); holder.harness = first.harness;
	let currentHarness = first.harness;
	t.after(async () => { releaseRecipient(fauxAssistantMessage("STOPPED")); await currentHarness.close(context); });
	const target = await first.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	await first.harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const ready = waitForAwait(first.harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool, args: tool === "agent_spawn" ? { name: "await-recipient", prompt: "RECIPIENT-WAIT" } : { sessionId: `${storageId}:${target.id}`, message: "RECIPIENT-WAIT" } });
	await say(first.root, "Dispatch an original request");
	const output = (await toolOutcomes(first.harness, first.root.id)).find((item) => item.name === tool); assert.ok(output);
	const result = (output.details as { structuredContent: { result: { sessionId: string; submissionId: number; requestId: string } } }).structuredContent.result;
	const admission = await foreign.request("submit", { sessionId: "foreign", message: "HELD-DEPENDENCY", requestId: "dependency", ownerId: result.sessionId, origin: "model" }, context) as { submissionId: number };
	releaseRecipient(fauxAssistantMessage([fauxToolCall("agent_await", { results: [{ sessionId: "foreign", submissionId: admission.submissionId, requestId: "dependency" }] })], { stopReason: "toolUse" }));
	await ready;
	const recipientId = Number(result.sessionId.split(":")[1]) as Durable.ConversationId;
	const recipient = await first.harness.conversation(recipientId, context); assert.ok(recipient);
	await submitConversation(recipient, { message: "RECIPIENT-WAIT", requestId: result.requestId, provenance: { classification: "explicit", sender: storageId } }, context);
	assert.equal((await first.harness.snapshot(AwaitDoc, context))?.declarations.find((item) => item.conversationId === recipientId)?.decision, "awaiting");
	const reporters = await first.harness.snapshot(TestChildren, first.root.id, context);
	const reporterId = Object.values(reporters?.reporters ?? {})[0] as Durable.TaskId;
	const reporter = await first.harness.commit((tx) => tx.task(reporterId), context); assert.ok(reporter);
	assert.equal((reporter.state as { checkpoint?: { phase?: string } }).checkpoint?.phase, "deliver");
	await first.harness.close(context);
	const reopened = await openHarness(await openNodeSqliteStorage(path), registry, models); holder.harness = reopened.harness; currentHarness = reopened.harness;
	const retained = await reopened.harness.submission(result.submissionId as Durable.SubmissionId, context); assert.ok(retained);
	const current = await reopened.harness.conversation(recipientId, context); assert.ok(current);
	await submitConversation(current, { message: "RECIPIENT-WAIT", requestId: result.requestId, provenance: { classification: "explicit", sender: storageId } }, context);
	assert.equal((await retained.status(context)).status, "placed");
	assert.equal((await reopened.harness.snapshot(AwaitDoc, context))?.declarations.find((item) => item.conversationId === recipientId)?.decision, "awaiting");
	assert.equal(recipientCalls, 1, "neither original admission replay nor Reporter replay resumes the waiting model");
	finish(fauxAssistantMessage("DEPENDENCY-DONE"));
	assert.equal((await retained.wait(context)).status, "done");
	await settle(reopened.harness, reopened.root.id);
	assert.equal(recipientCalls, 2);
});

async function completedPeerResults(harness: Durable.Harness, names: string[]): Promise<AwaitOutcome[]> {
	const outcomes: AwaitOutcome[] = [];
	for (const name of names) {
		const producer = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const source = await producer.submit({ type: "input", content: `CONTRACT: reply ${name}`, requestId: name }, context);
		const terminal = await readOutcome(harness, source.id, context);
		assert.equal(terminal.status, "done");
		outcomes.push({ result: { sessionId: `${storageId}:${producer.id}`, submissionId: source.id, requestId: name }, status: "done", answer: terminal.answer, answerEntryId: terminal.answerEntryId });
	}
	return outcomes;
}
for (const mode of ["covered", "partial", "late", "placed"] as const) it(`native await withdraws only fully covered queued delivery inputs with mode=${mode}`, { timeout: 10000 }, async (t) => {
	const route = createRoute(); const holder: DispatchHolder = {}; let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let sources: AwaitOutcome[] = [];
	const base = createDispatch(holder, []);
	const deliveryId = "deliver:foreign:answer:shared";
	const dispatch: AgentControlDispatch = async (method, params, ctx = context) => {
		if (method !== "receipts") return base(method, params, ctx);
		await gate;
		const result = params.result as { submissionId: number };
		const outcome = sources.find((item) => item.result.submissionId === result.submissionId); assert.ok(outcome);
		return { outcome: { ...outcome, submissionId: outcome.result.submissionId, requestId: outcome.result.requestId }, delivery: { requestId: deliveryId, results: sources.map((item) => item.result), complete: true } };
	};
	const { registry } = buildRegistry(dispatch); const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route)); holder.harness = harness;
	t.after(async () => { release(); await harness.close(context); });
	sources = (await completedPeerResults(harness, ["ONE", "TWO"])).map((outcome) => ({ ...outcome, result: { ...outcome.result, sessionId: "foreign" } }));
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const ready = waitForAwait(harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool: "agent_await", args: { results: (mode === "partial" ? sources.slice(0, 1) : sources).map((item) => item.result) } });
	const original = await root.submit({ type: "input", content: mode === "placed" ? "DELIVERED-COPY" : "AWAIT-COVERAGE", ...(mode === "placed" ? { requestId: deliveryId } : {}) }, context); await ready;
	let copy: Durable.Submission | undefined;
	if (mode === "placed") copy = original;
	else if (mode !== "late") copy = await root.submit({ type: "input", content: "DELIVERED-COPY", requestId: deliveryId, whenBusy: "followUp" }, context);
	release(); await original.wait(context); await root.waitForIdle(context);
	if (mode === "late") { copy = await root.submit({ type: "input", content: "DELIVERED-COPY", requestId: deliveryId, whenBusy: "followUp" }, context); await copy.wait(context); await root.waitForIdle(context); }
	assert.ok(copy); const status = await copy.status(context);
	assert.equal(status.status, mode === "covered" ? "unanswered" : "done");
	if (status.status === "unanswered") assert.equal(status.reason, "aborted");
	assert.equal((await userTexts(harness, root.id)).filter((text) => text === "DELIVERED-COPY").length, mode === "covered" ? 0 : 1);
	assert.equal((await original.status(context)).status, "done");
});

it("withdraws a queued same-storage Reporter input by its actual request ID", { timeout: 10000 }, async (t) => {
	const route = createRoute(); let finish!: (answer: AssistantMessage) => void;
	const producer = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const models = createTestModels((...args) => messageText(args[0].messages.findLast((message) => message.role !== "system")) === "HELD-REPORT" ? producer : route.route(...args));
	const holder: DispatchHolder = {}; const base = createDispatch(holder, []);
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	const dispatch: AgentControlDispatch = async (method, params, ctx = context) => { const result = await base(method, params, ctx); if (method === "await-native") await gate; return result; };
	const { registry } = buildRegistry(dispatch); const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models); holder.harness = harness;
	t.after(async () => { finish(fauxAssistantMessage("RESULT")); release(); await harness.close(context); });
	route.script.push({ tool: "agent_spawn", args: { prompt: "HELD-REPORT", name: "report-producer", checkInMinutes: 0 } });
	await say(root, "Dispatch report work");
	const admission = (await toolOutcomes(harness, root.id)).find((item) => item.name === "agent_spawn"); assert.ok(admission);
	const result = (admission.details as { structuredContent: { result: { sessionId: string; submissionId: number; requestId: string } } }).structuredContent.result;
	const reportId = `agent-report:${result.requestId.slice("agent-deliver:".length)}`;
	const ready = waitForAwait(harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool: "agent_await", args: { results: [result] } });
	const original = await root.submit({ type: "input", content: "Await queued report" }, context); await ready;
	const watch = await harness.watchDoc(Durable.InboxDoc, root.id, context); assert.ok(watch);
	const queued = new Promise<void>((resolve) => watch.start(async () => { if ((await harness.commit((tx) => tx.submissionByRequest(root.id, reportId), context))?.status === "queued") resolve(); }));
	finish(fauxAssistantMessage("RESULT")); await queued; await watch.stop(); release();
	await original.wait(context); await root.waitForIdle(context);
	const report = await harness.commit((tx) => tx.submissionByRequest(root.id, reportId), context);
	assert.equal(report?.status, "unanswered"); if (report?.status === "unanswered") assert.equal(report.reason, "aborted");
	assert.equal((await userTexts(harness, root.id)).some((text) => text.startsWith("[agent report-producer answered]")), false);
});

for (const receiptFirst of [false, true]) it(`awaits a foreign recipient result and follows its exact continuation with receipt-first=${receiptFirst}`, { timeout: 10000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "foreign-await-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
	let finish!: (message: AssistantMessage) => void; const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const foreign = await DurableHost.open({ storageId: "foreign", storagePath: join(directory, "source.sqlite"), cwd: directory, registry: fixtureRegistry(), models: createTestModels(() => held), agent: { model } }, context);
	t.after(async () => { finish(fauxAssistantMessage("FINISHED")); await foreign.close(); });
	const admission = await foreign.request("submit", { message: "foreign work", requestId: "foreign-result", ownerId: storageId, origin: "operator" }, context) as { submissionId: Durable.SubmissionId };
	const result = { sessionId: "foreign", submissionId: admission.submissionId, requestId: "foreign-result" };
	const route = createRoute(); const holder: DispatchHolder = {}; const base = createDispatch(holder, []);
	let resumeObservation!: () => void; const observationGate = new Promise<void>((resolve) => { resumeObservation = resolve; });
	t.after(() => resumeObservation());
	const dispatch: AgentControlDispatch = async (method, params, callContext = context) => {
		if (method !== "receipts") return base(method, params, callContext);
		if (receiptFirst) await observationGate;
		return foreign.request(method, params, callContext);
	};
	const { registry } = buildRegistry(dispatch); const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route)); holder.harness = harness;
	t.after(() => harness.close(context));
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const ready = waitForAwait(harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool: "agent_await", args: { results: [result] } });
	const original = await root.submit({ type: "input", content: "AWAIT FOREIGN" }, context); await ready;
	assert.equal((await original.status(context)).status, "placed");
	await assert.rejects(foreign.request("receipts", { ownerId: "third-agent", result, wait: true }, context), /not addressed/u);
	const answer = `${"x".repeat(15999)}😀${"y".repeat(4000)}TAIL`;
	finish(fauxAssistantMessage(answer));
	let queuedReceipt: Durable.Submission | undefined;
	if (receiptFirst) {
		const terminal = await foreign.wait(admission.submissionId, context);
		queuedReceipt = await root.submit({ type: "input", content: "EXCERPT", whenBusy: "followUp", requestId: `deliver:foreign:answer:${terminal.answerEntryId}` }, context);
		resumeObservation();
	}
	assert.equal((await original.wait(context)).status, "done");
	if (queuedReceipt !== undefined) { const status = await queuedReceipt.status(context); assert.equal(status.status, "unanswered"); if (status.status === "unanswered") assert.equal(status.reason, "aborted"); }
	const tool = (await toolOutcomes(harness, root.id)).find((item) => item.name === "agent_await"); assert.ok(tool);
	const output = JSON.parse(tool.text);
	const continuation = output.results[0].continuation;
	assert.equal(continuation.sessionId, "foreign"); assert.equal(continuation.offset, 0);
	const conversation = await foreign.harness.conversation(Durable.ROOT_CONVERSATION_ID, context); assert.ok(conversation);
	let complete = ""; let offset = 0;
	for (let pages = 0; pages < 16; pages++) {
		const page = await readInspection(foreign.harness, "foreign", conversation, { view: "exact", entryId: continuation.entryId, offset }, context) as { text: string; nextOffset: number | null };
		complete += page.text;
		if (page.nextOffset === null) break;
		offset = page.nextOffset;
	}
	assert.ok(complete.includes(answer));
	assert.equal((await foreign.receipts(storageId)).length, 1, "observation does not acknowledge the normal source receipt");
});

for (const partial of [false, true]) it(`reopens the caller's original native await with partial=${partial}`, { timeout: 10000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "reopen-await-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
	const finishes: Array<(message: AssistantMessage) => void> = [];
	const held = [0, 1].map(() => new Promise<AssistantMessage>((resolve) => finishes.push(resolve)));
	let sourceCalls = 0;
	const foreign = await DurableHost.open({ storageId: "foreign", storagePath: join(directory, "foreign.sqlite"), cwd: directory, registry: fixtureRegistry(), models: createTestModels((request) => {
		sourceCalls++; const text = messageText(request.messages.findLast((item) => item.role !== "system")); return held[Number(text.slice(-1))];
	}), agent: { model } }, context);
	t.after(async () => { for (const finish of finishes) finish(fauxAssistantMessage("FINISHED")); await foreign.close(); });
	const results = [];
	for (const index of [0, 1]) {
		const conversation = index === 0 ? await foreign.harness.root(context) : await foreign.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const sessionId = index === 0 ? "foreign" : `foreign:${conversation.id}`;
		const admission = await foreign.request("submit", { sessionId, message: `HELD-${index}`, requestId: `foreign:${index}`, ownerId: storageId, origin: "operator" }, context) as { submissionId: number };
		results.push({ sessionId, submissionId: admission.submissionId, requestId: `foreign:${index}` });
	}
	const route = createRoute(); const holder: DispatchHolder = {}; const base = createDispatch(holder, []);
	const dispatch: AgentControlDispatch = (method, params, ctx = context) => method === "receipts" ? foreign.request(method, params, ctx) : base(method, params, ctx);
	const { registry } = buildRegistry(dispatch); const models = createTestModels(route.route); const path = join(directory, "caller.sqlite");
	const first = await openHarness(await openNodeSqliteStorage(path), registry, models); holder.harness = first.harness;
	await first.harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const ready = waitForAwait(first.harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	route.script.push({ tool: "agent_await", args: { results } });
	const original = await first.root.submit({ type: "input", content: "REOPEN AWAIT" }, context); await ready;
	if (partial) {
		const accepted = waitForAwait(first.harness, (state) => state.declarations.some((item) => item.outcomes.length === 1));
		finishes[0](fauxAssistantMessage("RESULT-ONE")); await accepted;
	}
	await first.harness.close(context);
	const reopened = await openHarness(await openNodeSqliteStorage(path), registry, models); holder.harness = reopened.harness;
	t.after(() => reopened.harness.close(context));
	const retained = await reopened.harness.submission(original.id, context); assert.ok(retained);
	assert.equal((await retained.status(context)).status, "placed");
	assert.equal(route.requests.length, 1, "safe tool replay does not call the model");
	finishes[0](fauxAssistantMessage("RESULT-ONE")); finishes[1](fauxAssistantMessage("RESULT-TWO"));
	assert.equal((await retained.wait(context)).status, "done");
	const output = (await toolOutcomes(reopened.harness, reopened.root.id)).find((item) => item.name === "agent_await");
	assert.ok(output?.text.includes("RESULT-ONE") && output.text.includes("RESULT-TWO"), output?.text);
	assert.equal(route.requests.length, 2); assert.equal(sourceCalls, 2, "caller replay does not redispatch source work");
});

for (const known of [true, false]) it(`serializes simultaneous local cycle declarations with known-request=${known}`, { timeout: 10000 }, async (t) => {
	const finishes: Array<(message: AssistantMessage) => void> = [];
	const held = [0, 1].map(() => new Promise<AssistantMessage>((resolve) => finishes.push(resolve)));
	const route = createRoute();
	const models = createTestModels((...args) => {
		const text = messageText(args[0].messages.findLast((item) => item.role !== "system"));
		return text.startsWith("PENDING-") ? held[Number(text.slice(-1))] : route.route(...args);
	});
	const holder: DispatchHolder = {}; const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models); holder.harness = harness;
	t.after(async () => { for (const finish of finishes) finish(fauxAssistantMessage("FINISHED")); await harness.close(context); });
	const peer = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const inputs = await Promise.all([root, peer].map((conversation, index) => conversation.submit({ type: "input", content: `PENDING-${index}`, requestId: `cycle:${index}` }, context)));
	const refs = inputs.map((input, index) => ({ sessionId: index === 0 ? storageId : `${storageId}:${peer.id}`, submissionId: input.id, ...(known ? { requestId: `cycle:${index}` } : {}) }));
	for (const index of [0, 1]) finishes[index](fauxAssistantMessage([fauxToolCall("agent_await", { results: [refs[1 - index]] })], { stopReason: "toolUse" }));
	assert.deepEqual((await Promise.all(inputs.map((input) => input.wait(context)))).map((item) => item.status), ["done", "done"]);
	const outcomes = [...await toolOutcomes(harness, root.id), ...await toolOutcomes(harness, peer.id)].filter((item) => item.name === "agent_await");
	assert.equal(outcomes.filter((item) => item.isError).length, 1);
	assert.match(outcomes.find((item) => item.isError)?.text ?? "", /local result cycle/u);
});

for (const order of ["before", "during"] as const) it(`closes the named check-in admission race when declaration occurs ${order} admission`, { timeout: 10000 }, async (t) => {
	const route = createRoute(); let ownerFinish!: (message: AssistantMessage) => void; let sourceFinish!: (message: AssistantMessage) => void;
	const ownerHeld = new Promise<AssistantMessage>((resolve) => { ownerFinish = resolve; }); const sourceHeld = new Promise<AssistantMessage>((resolve) => { sourceFinish = resolve; });
	const models = createTestModels((...args) => {
		const text = messageText(args[0].messages.findLast((item) => item.role !== "system"));
		if (text === "PAUSE-CHECKIN") return ownerHeld;
		return text === "HELD-CHECKIN-SOURCE" ? sourceHeld : route.route(...args);
	});
	const holder: DispatchHolder = {}; const base = createDispatch(holder, []);
	let observed!: () => void; const observing = new Promise<void>((resolve) => { observed = resolve; });
	const { registry } = buildRegistry(async (method, params, ctx) => { if (method === "await-native") observed(); return base(method, params, ctx); });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models); holder.harness = harness;
	t.after(async () => { ownerFinish(fauxAssistantMessage("FINISHED")); sourceFinish(fauxAssistantMessage("FINISHED")); await harness.close(context); });
	const producer = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const source = await producer.submit({ type: "input", content: "HELD-CHECKIN-SOURCE", requestId: "watched-source" }, context);
	const result = { sessionId: `${storageId}:${producer.id}`, submissionId: source.id, requestId: "watched-source" };
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const original = await root.submit({ type: "input", content: "PAUSE-CHECKIN" }, context);
	const releaseOwner = () => ownerFinish(fauxAssistantMessage([fauxToolCall("agent_await", { results: [result] })], { stopReason: "toolUse" }));
	const submit = root.submit.bind(root);
	if (order === "during") t.mock.method(root, "submit", async (...args: Parameters<typeof root.submit>) => { releaseOwner(); await observing; return submit(...args); });
	const automatic = { message: "NAMED RACE CHECK-IN", requestId: "race-check", whenBusy: "steer" as const, provenance: { classification: "automatic" as const, automaticKind: "checkIn" as const, sender: result.sessionId, producerRequestId: result.requestId } };
	if (order === "during") await assert.rejects(submitConversation(root, automatic, context), AwaitInputSuppressed);
	else { await submitConversation(root, automatic, context); releaseOwner(); await observing; }
	assert.equal((await original.status(context)).status, "placed");
	assert.equal((await harness.snapshot(Durable.InboxDoc, root.id, context))?.items.length, 0);
	assert.equal((await harness.commit((tx) => tx.submissionByRequest(root.id, "race-check"), context))?.status, "unanswered");
	sourceFinish(fauxAssistantMessage("RESULT")); await original.wait(context);
	assert.equal((await userTexts(harness, root.id)).includes("NAMED RACE CHECK-IN"), false);
});

it("keeps default check-ins and native scheduled delivery token-idle during the original await", { timeout: 10000 }, async (t) => {
	const epoch = Date.now(); t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
	let finish!: (message: AssistantMessage) => void; const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	let callerCalls = 0;
	const models = createTestModels((request) => {
		const last = request.messages.findLast((item) => item.role !== "system"); const text = messageText(last);
		if (text === "CONTRACT: reply HELD") return held;
		callerCalls++;
		if (last?.role === "user" && text === "START DEFAULT") return fauxAssistantMessage([fauxToolCall("agent_spawn", { prompt: "CONTRACT: reply HELD" })], { stopReason: "toolUse" });
		if (last?.role === "toolResult" && last.toolName === "agent_spawn") {
			const reference = JSON.parse(text.split("\nResult: ")[1]);
			return fauxAssistantMessage([fauxToolCall("agent_await", { results: [reference] })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("FINAL");
	});
	const holder: DispatchHolder = {}; const { registry } = buildRegistry(createDispatch(holder, []));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, models); holder.harness = harness;
	t.after(async () => { finish(fauxAssistantMessage("RESULT")); await harness.close(context); });
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); await tx.doc(AgentDeliveryDoc); }, context);
	const ready = waitForAwait(harness, (state) => state.declarations.some((item) => item.decision === "awaiting"));
	const admission = await submitConversation(root, { message: "START DEFAULT", requestId: "original-default", ownerId: "requester", origin: "model", checkInMinutes: checkInMinutes(undefined), senderIdentity: storageId }, context);
	await ready;
	const original = await harness.submission(admission.submissionId, context); assert.ok(original);
	const checks = (await harness.inspect(context)).tasks.filter((item) => item.record.kind === "agent.check-in");
	assert.equal(checks.length, 2, "default spawn and original request both retain their check-ins");
	const interval = Math.max(...checks.map((item) => (item.record.input as { intervalMs: number }).intervalMs));
	const watch = await harness.watchDoc(AgentDeliveryDoc, context); assert.ok(watch);
	let reportReady!: () => void; const reportsReady = new Promise<void>((resolve) => { reportReady = resolve; });
	watch.start(async (state) => { if ((state?.reports.length ?? 0) >= 2) reportReady(); });
	t.mock.timers.tick(interval); await reportsReady; await watch.stop();
	const reports = (await harness.snapshot(AgentDeliveryDoc, context))?.reports ?? [];
	assert.ok(reports.some((report) => report.ownerId === "requester"), "the requester still gets check-ins about the awaiter");
	const named = reports.find((report) => report.ownerId === storageId); assert.ok(named?.checkIn);
	const calls = callerCalls;
	await assert.rejects(submitConversation(root, { message: named.message, requestId: named.requestId, whenBusy: "steer", provenance: { classification: "automatic", automaticKind: "checkIn", sender: named.senderIdentity, producerRequestId: named.checkIn.requestId } }, context), AwaitInputSuppressed);
	await harness.commit(async (tx) => { await tx.doc(AgentTimerDoc); }, context);
	const timerWatch = await harness.watchDoc(AgentTimerDoc, context); assert.ok(timerWatch);
	let fired!: () => void; const timerFired = new Promise<void>((resolve) => { fired = resolve; });
	timerWatch.start(async (state) => { if (state?.timers.some((item) => item.status === "fired")) fired(); });
	await scheduleTimer(harness, { scheduleId: "automatic-native", deadline: Date.now(), conversationId: root.id, identity: storageId, message: "SCHEDULED INPUT", mode: "steer", origin: "model", ownerId: "requester", requestId: "scheduled-native", createdAt: Date.now() }, context);
	await timerFired; await timerWatch.stop();
	assert.equal(callerCalls, calls); assert.equal((await original.status(context)).status, "placed");
	assert.equal((await harness.snapshot(Durable.InboxDoc, root.id, context))?.items.length, 1);
	finish(fauxAssistantMessage("RESULT")); await original.wait(context); await root.waitForIdle(context);
});

it("creates a native child with max thinking through tool-call validation", async (t) => {
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
	assert.equal((await harness.snapshot(Durable.AgentDoc, child.conversationId, context))?.thinkingLevel, "max");
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
	assert.equal(reports.length, 1, "the owner received one report");

	const state = await harness.snapshot(TestChildren, root.id, context);
	const reporters = Object.values(state?.reporters ?? {});
	assert.equal(reporters.length, 1, "one reporter task");
	const receipt = await harness.getTask(reporters[0] as Durable.TaskId, context);
	assert.equal(receipt?.state.status, "terminal");
	assert.equal(child.reported.length, 1, "the answer is recorded as reported");
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
	assert.equal(reports.length, 2, "each child reports its own answer");
});

it("resumes a child answer and reports once across a second harness open", async (t) => {
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
	assert.equal(reports.length, 1, "exactly one report after reopen");
	assert.equal(Object.values(children?.reporters ?? {}).length, 1, "one reporter task after reopen");
	const receipt = await second.harness.getTask(reporter, context);
	assert.equal(receipt?.state.status, "terminal");
	const deliverySubmission = await storage.submissionByRequest(childConversation, `agent-deliver:${reporter}`, context);
	assert.ok(deliverySubmission, "the delivery request ID is retained");
	const reportSubmission = await storage.submissionByRequest(second.root.id, `agent-report:${reporter}`, context);
	assert.ok(reportSubmission, "the report request ID is retained");
});

it("reconciles an existing local child before Reporter admission", { timeout: 10000 }, async (t) => {
	const route = createRoute();
	const { registry } = buildRegistry();
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	registry.install({ name: "request-routes", sections: [requestContextSection(harness)] });
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
	assert.ok(prompt.includes(`"requester":"${storageId}"`));
	assert.ok(prompt.includes(`"replyTo":"${storageId}"`));
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

	resumed = await Durable.Harness.open(await openNodeSqliteStorage(storagePath), { models, registry, onReport: (error) => warnings.push(error) }, context);
	registry.install({ name: "retained-request-routes", sections: [requestContextSection(resumed)] });
	const settled = await resumed.waitForTask(taskId, context);
	assert.equal(settled.state.outcome.status, "completed");
	const reopenedRecipient = await resumed.conversation(recipient.id, context);
	await reopenedRecipient?.waitForIdle(context);
	const requestId = `agent-deliver:${taskId}`;
	assert.equal(observedRoutes.length, REQUEST_CONTEXT_LIMIT + 1, "accepted Reporter retains its route without evicting the occupied slots");
	assert.deepEqual(observedRoutes.find((route) => route.requestId === requestId), { requestId, requester: storageId, replyTo: `${storageId}:${recipient.id}`, origin: "model", status: "placed" });
	assert.equal((await userTexts(resumed, child.id)).filter((text) => text === taskText).length, 1);
	assert.equal((await userTexts(resumed, recipient.id)).filter((text) => text.includes("RETAINED-REPORTER-ANSWER")).length, 1);
	assert.equal((await userTexts(resumed, owner.id)).length, 0, "an explicit reply recipient does not become the requester");
	const delivery = await resumed.commit((tx) => tx.submissionByRequest(child.id, requestId), context);
	const report = await resumed.commit((tx) => tx.submissionByRequest(recipient.id, `agent-report:${taskId}`), context);
	assert.equal(delivery?.status, "done");
	assert.equal(report?.status, "done");
	assert.equal((await readRequestContexts(resumed, child.id, context)).length, REQUEST_CONTEXT_LIMIT);
	await assert.rejects(resumed.commit((tx) => recordRequestContext(tx, child.id, { requestId: "new-over-capacity", requester: "new-requester", replyTo: "new-recipient", origin: "model" }), context), /unfinished request routes/u);
	if (conflictingProfile) assert.ok(warnings.some((warning) => String(warning).includes("Profile identity differs")), "optional profile repair reports its failure without failing the retained task");
	else assert.deepEqual(warnings, []);
});

it("resolves a namespaced native handle before applying self-control restrictions", async (t) => {
	const route = createRoute();
	const id = handleStorageId("native", testCwd);
	const { registry } = buildRegistry(undefined, true, id, testCwd);
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_abort", args: { sessionId: "@native" } });
	await say(root, "Try self abort");
	const outcome = (await toolOutcomes(harness, root.id)).find((outcome) => outcome.name === "agent_abort");
	assert.equal(outcome?.isError, true);
	assert.match(outcome?.text ?? "", /self|calling|itself/iu);
});

it("drives one model-issued call per control tool", async (t) => {
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
	await run("agent_list", {});
	await run("agent_collaborate", { action: "list" });
	await run("agent_inspect", { sessionId: childSessionId, view: "history" });
	await run("agent_compact", {});
	await run("agent_command", { sessionId: storageId, name: "echo", args: "hi" });
	await run("agent_reset", { sessionId: childSessionId, handoff: "fresh context" });
	await run("agent_abort", { sessionId: childSessionId, timerId: 3 });

	const outcomes = await toolOutcomes(harness, root.id);
	for (const tool of CONTROL_TOOLS.filter((name) => name !== "agent_await")) {
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
		| { structuredContent?: { conversation?: { conversationId?: number } } }
		| undefined;
	assert.ok(statusDetails?.structuredContent?.conversation, "status carries validated structured content");
	const listDetails = outcomes.find((outcome) => outcome.name === "agent_list")?.details as
		| { structuredContent?: { rows?: unknown[] } }
		| undefined;
	assert.ok(Array.isArray(listDetails?.structuredContent?.rows), "list carries validated structured content");
	const inspectDetails = inspected?.details as { structuredContent?: { view?: string } } | undefined;
	assert.equal(inspectDetails?.structuredContent?.view, "history", "inspect carries validated structured content");
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
	const reference = (outcome.details as { structuredContent: { result: { sessionId: string; submissionId: number; requestId: string } } }).structuredContent.result;
	assert.equal(reference.sessionId, `${storageId}:${child.conversationId}`);
	const admitted = await harness.commit((tx) => tx.submissionByRequest(child.conversationId as Durable.ConversationId, reference.requestId), context);
	assert.equal(admitted?.id, reference.submissionId);
	assert.equal(outcome?.text, `Spawned linked as conversation ${reference.sessionId} in your storage. The prompt was admitted and the answer will report back.\nResult: ${JSON.stringify(reference)}`);
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
	assert.match(outcome.text, /report waits for its current run to end/u);
	assert.match(outcome.text, /Use steer.*next tool boundary/u);
	assert.match(outcome.text, /recipient is a busy Durable agent/u);
	assert.match(outcome.text, /reports to ordinary primaries use steer/u);
});

it("spawns a child in a new storage when the cwd differs", async (t) => {
	const route = createRoute();
	const holder: DispatchHolder = {};
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(createDispatch(holder, calls));
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	holder.harness = harness;
	holder.spawnSessionId = "other-storage:7";
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
	const reference = (outcome.details as { structuredContent: { result: { sessionId: string; submissionId: number; requestId: string } } }).structuredContent.result;
	assert.deepEqual(reference, { sessionId: "other-storage:7", submissionId: 23, requestId: spawn.params.requestId });
	assert.equal(outcome.text, `Spawned remote in /elsewhere as other-storage:7 with its own storage and host. The prompt was admitted and the answer will report back.\nResult: ${JSON.stringify(reference)}`);
});

it("adds only the caller's retained children to storage status text and structured data", async (t) => {
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
	assert.ok(!empty.text.includes("Your agents"));
	route.script.push({ tool: "agent_spawn", args: { name: "native" } });
	await say(root, "SPAWN");
	route.script.push({ tool: "agent_spawn", args: { name: "foreign", cwd: "/elsewhere" } });
	await say(root, "SPAWN");
	const local = (await harness.snapshot(TestChildren, root.id, context))?.children[0];
	assert.ok(local?.conversationId !== undefined);
	const populated = await status();
	assert.equal(populated.text, `${empty.text}\n\nYour agents (direct children, newest first; retained creation labels):\n- foreign-child "foreign": storage with own host\n- ${storageId}:${local.conversationId} "native": native child conversation`);
	assert.deepEqual(populated.details, { ...(empty.details as object), structuredContent: { ...(empty.details as { structuredContent: object }).structuredContent, lineage: {
		children: [{ identity: "foreign-child", name: "foreign", kind: "storage" }, { identity: `${storageId}:${local.conversationId}`, name: "native", kind: "native-child" }], omitted: 0,
	} } }, "lineage is available to structured tool consumers without changing host fields");
	assert.deepEqual(calls.filter((call) => call.method === "status").map((call) => call.params), [{}, {}]);
	const child = await harness.conversation(local.conversationId, context);
	assert.ok(child);
	assert.ok(!(await status(child)).text.includes("Your agents"), "a childless caller does not inherit its owner's registry");
	assert.ok(!(await status(root, { sessionId: storageId })).text.includes("Your agents"), "selected status stays unchanged");
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
	assert.equal(place.params.checkInMinutes, minutes ?? 7);
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
		| { structuredContent?: { nextCursor?: { at: number; tag: string } } }
		| undefined;
	assert.deepEqual(
		firstDetails?.structuredContent?.nextCursor,
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
		agent: { thinkingLevel: "off" as const, extensions: [], tools: extension.tools ?? [], sections: [] },
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
	const details = failed?.details as { structuredContent?: { outcome?: string } } | undefined;
	assert.equal(details?.structuredContent?.outcome, "failed", "the outcome is structured");

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

for (const mode of [undefined, "steer", "followUp"]) it(`honors immediate send disposition ${mode ?? "default steering"}`, async (t) => {
	const route = createRoute();
	const calls: DispatchCalls = [];
	const { registry } = buildRegistry(async (method, params) => { calls.push({ method, params }); return { submissionId: 1, deduped: false }; });
	const { harness, root } = await openHarness(new Durable.MemoryStorage(), registry, createTestModels(route.route));
	t.after(() => harness.close(context));
	route.script.push({ tool: "agent_send", args: { sessionId: "remote-storage", message: "A time-sensitive correction", checkInMinutes: 0, ...(mode === undefined ? {} : { mode }) } });
	await say(root, "SEND");
	assert.equal(calls[0].method, "submit");
	assert.equal(calls[0].params.whenBusy, mode ?? "steer");
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
