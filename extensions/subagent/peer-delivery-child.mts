/** Direct SDK regression for peer delivery, idle activation, and session ownership. */
import { strict as assert } from "node:assert";
import type { AssistantMessage, JsonObject, JsonValue, Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentSession, CustomMessageEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "subagent-peer-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const workerCwd = join(root, "worker-project");
const home = join(root, "home");
const { mkdirSync } = await import("node:fs");
for (const path of [agentDir, cwd, workerCwd, home]) mkdirSync(path);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = home;
const errors: unknown[] = [];
const captureError = (error: unknown) => errors.push(error);
process.on("unhandledRejection", captureError);
process.on("uncaughtException", captureError);
const watchdog = setTimeout(() => {
	console.error("Peer child exceeded its runtime bound", errors);
	process.exit(1);
}, 35_000);
function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function until(check: () => boolean, description: string) {
	const end = Date.now() + 12_000;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(
		check(),
		`${description}; asynchronous errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify([...calls])}; workers: ${JSON.stringify(sub?.listWorkers().map(({ id, state, error, task }) => ({ id, state, error, task })))}; owner: ${JSON.stringify(owner?.messages).slice(-12000)}; requests: ${JSON.stringify([...requestMessages].map(([role, messages]) => [role, messages.slice(-2)])).slice(-12000)}`,
	);
}
const busy = gate();
const releaseBusy = gate();
const releaseSubmit = gate();
const calls = new Map<string, number>();
const surfaces = new Map<string, string[]>();
const requestMessages = new Map<string, Message[]>();
const sessionMessages = new Map<string, AgentMessage[]>();
const evidence = "fixture_schema_field_7c4e";
writeFileSync(join(workerCwd, "schema.txt"), evidence);
const providerPath = join(agentDir, "peer-fixture.mjs");
const model = {
	id: "peer-model",
	name: "Peer Model",
	api: "peer-fixture-api",
	provider: "peer-fixture",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
let owner: AgentSession | null = null;
let sub: typeof import("./index.ts");
let questionId = "";
let replyId = "";
let aId = "";
let bId = "";
let bQuestionReceipt: JsonObject | undefined;
let terminalRefusal = false;
let cancelRequested = false;
let pauseRequested = false;
let pausedSendRequested = false;
const key = Symbol.for("subagent-test.peer-fixture");
const { fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import("@earendil-works/pi-ai");
const tool = (name: string, args: JsonObject) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
type AgentMessage = AgentSession["state"]["messages"][number];
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type CustomItem = Extract<AgentMessage, { role: "custom" }>;
interface FixtureMessage {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}
const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isJsonArray = (value: unknown): value is readonly JsonValue[] => Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const lastResult = (context: { messages: readonly AgentMessage[] }, name: string): ToolResultMessage | undefined =>
	context.messages
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === name)
		.at(-1);
/** The fixture reads payloads it produced itself; narrow each at its boundary. */
const resultDetails = (result: ToolResultMessage | undefined): JsonObject => {
	assert.ok(result, "expected a tool result");
	const details = result.details;
	assert.ok(isJsonObject(details), "expected object tool-result details");
	return details;
};
const custom = (context: { messages: readonly AgentMessage[] }): CustomItem[] =>
	context.messages.filter(
		(message): message is CustomItem => message.role === "custom" && message.customType === "subagent_peer",
	);
const itemDetails = (item: CustomItem): JsonObject => {
	const details = item.details;
	assert.ok(isJsonObject(details), "expected object custom-message details");
	return details;
};
const peerMessages = (role: string) => custom({ messages: sessionMessages.get(role) ?? [] });
const text = (message: FixtureMessage): string => {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
};
async function ownerResponse(count: number, context: TranscriptContext): Promise<AssistantMessage> {
	if (count === 1)
		return tool("subagent", { tasks: [{ task: "PEER_A", cwd: workerCwd }, { task: "PEER_B", cwd: workerCwd }] });
	const serialized = JSON.stringify(context.messages);
	if (serialized.includes("SEND_PAUSED_PEER") && !pausedSendRequested) {
		pausedSendRequested = true;
		const paused = sub.listWorkers().find((record) => record.task === "PEER_C");
		assert.ok(paused, "the paused peer is listed");
		return tool("subagent_message", { to: paused.id, message: "Do not resume" });
	}
	if (serialized.includes("PAUSE_WAITING_PEER") && !pauseRequested) {
		pauseRequested = true;
		const waiting = sub.listWorkers().find((record) => record.task === "PEER_C");
		assert.ok(waiting, "the waiting peer is listed");
		return tool("subagent_interrupt", { id: waiting.id });
	}
	if (serialized.includes("CANCEL_WAITING_PEER") && !cancelRequested) {
		cancelRequested = true;
		const waiting = sub.listWorkers().find((record) => record.task === "PEER_C");
		assert.ok(waiting, "the waiting peer is listed");
		return tool("subagent_kill", { id: waiting.id });
	}
	if (serialized.includes("START_CANCEL_PEER") && !sub.listWorkers().some((record) => record.task === "PEER_C"))
		return tool("subagent", { task: "PEER_C" });
	if (serialized.includes("CHECK_TERMINAL_PEER") && !terminalRefusal) {
		terminalRefusal = true;
		return tool("subagent_message", { to: aId, message: "Late message" });
	}
	return fauxAssistantMessage("OWNER_IDLE");
}

function roleAResponse(count: number, context: TranscriptContext): AssistantMessage {
	if (count === 1) return tool("fixture_gate", { stage: "busy" });
	if (count === 2) {
		const received = peerMessages("A");
		assert.equal(received.length, 1, "A receives the question after its busy tool");
		const question = received[0];
		const questionDetails = itemDetails(question);
		const questionIdValue = questionDetails.id;
		assert.ok(isString(questionIdValue), "the question carries a string id");
		questionId = questionIdValue;
		assert.match(text(question), /Which schema field/);
		assert.ok(context.messages.some((message) => text(message).includes("Which schema field")));
		return tool("read", { path: "schema.txt" });
	}
	if (count === 3) {
		const read = lastResult(context, "read");
		assert.ok(read, "the read tool returned");
		const observed = text(read).trim();
		assert.equal(observed, evidence);
		return tool("subagent_message", {
			to: itemDetails(peerMessages("A")[0]).from,
			message: `Use ${observed}`,
			replyTo: questionId,
		});
	}
	if (count === 4) {
		const reply = resultDetails(lastResult(context, "subagent_message"));
		const replyIdValue = reply.id;
		assert.ok(isString(replyIdValue), "the reply carries a string id");
		replyId = replyIdValue;
		return tool("fixture_gate", { stage: "submit" });
	}
	return tool("submit_result", { content: "A_SCHEMA_CONFIRMED" });
}

async function roleBResponse(count: number, context: TranscriptContext): Promise<AssistantMessage> {
	if (count === 1) {
		await busy.promise;
		return tool("subagent_peers", {});
	}
	if (count === 2) {
		const directory = resultDetails(lastResult(context, "subagent_peers"));
		const self = directory.self;
		assert.ok(isString(self), "the directory reports its own id");
		bId = self;
		const peers = directory.peers;
		assert.ok(isJsonArray(peers), "the directory lists peers");
		const peer = peers.find(
			(item): item is JsonObject => isJsonObject(item) && item.id !== self && item.parent !== null,
		);
		assert.ok(peer, JSON.stringify(directory));
		const peerId = peer.id;
		assert.ok(isString(peerId), "the peer carries a string id");
		aId = peerId;
		return tool("subagent_message", { to: aId, message: "Which schema field does schema.txt require?" });
	}
	if (count === 3) {
		const receipt = resultDetails(lastResult(context, "subagent_message"));
		const receiptId = receipt.id;
		assert.ok(isString(receiptId), "the receipt carries a string id");
		questionId = receiptId;
		assert.equal(receipt.status, "sent_unconfirmed");
		return tool("bash", { command: "printf independent > independent.txt" });
	}
	if (count === 4) return fauxAssistantMessage("B_IDLE");
	if (count === 5) {
		const answer = peerMessages("B").at(-1);
		assert.ok(answer, "B receives a custom peer reply, not a parent relay");
		const answerDetails = itemDetails(answer);
		assert.equal(answerDetails.replyTo, questionId);
		const answerId = answerDetails.id;
		assert.ok(isString(answerId), "the reply carries a string id");
		replyId = answerId;
		const match = text(answer).match(/Use (fixture_schema_field_[a-z0-9]+)/);
		assert.ok(match, text(answer));
		assert.ok(context.messages.some((message) => text(message).includes(`Use ${match[1]}`)));
		return tool("write", { path: "resolved-schema.txt", content: match[1] });
	}
	if (count === 6) return tool("subagent_kill", { id: aId });
	if (count === 7) {
		const killed = lastResult(context, "subagent_kill");
		assert.ok(killed, "the kill tool returned");
		assert.match(text(killed), /only its owning session/i);
		assert.equal(sub.readWorker(aId)?.state, "running");
		return tool("subagent_message", { id: questionId });
	}
	if (count === 8) {
		bQuestionReceipt = resultDetails(lastResult(context, "subagent_message"));
		assert.equal(bQuestionReceipt.status, "context_seen");
		return tool("submit_result", { content: "B_OUTPUT_COMPLETE" });
	}
	throw new Error(`Unexpected B provider request ${count}`);
}

const response = async (role: string, context: TranscriptContext): Promise<AssistantMessage> => {
	const count = (calls.get(role) ?? 0) + 1;
	calls.set(role, count);
	requestMessages.set(role, context.messages);
	surfaces.set(
		role,
		getCurrentTools(context.messages).map((item) => item.name),
	);
	if (role === "owner") return ownerResponse(count, context);
	if (role === "A") return roleAResponse(count, context);
	if (role === "B") return roleBResponse(count, context);
	if (role === "C") return fauxAssistantMessage("C_IDLE");
	throw new Error(`Unknown fixture role ${role}`);
};
type Fixture = {
	response: (role: string, context: TranscriptContext) => Promise<AssistantMessage>;
	observe(role: string, messages: AgentMessage[]): void;
	wait(stage: string): Promise<void>;
};
const fixtureHost = globalThis as Record<symbol, Fixture | undefined>;
fixtureHost[key] = {
	response,
	observe(role: string, messages: AgentMessage[]) {
		sessionMessages.set(role, messages);
	},
	async wait(stage: string) {
		if (stage === "busy") {
			busy.resolve();
			await releaseBusy.promise;
		} else await releaseSubmit.promise;
	},
};
writeFileSync(
	providerPath,
	`
import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
const model = ${JSON.stringify(model)};
export default function(pi) {
  const fixture = globalThis[Symbol.for("subagent-test.peer-fixture")];
  pi.registerTool({ name: "fixture_gate", label: "Fixture Gate", description: "Await the owned fixture boundary.",
    parameters: Type.Object({stage: Type.String()}),
    async execute(_id, args) { await fixture.wait(args.stage); return {content: [{type: "text", text: "gate open"}], details: {}}; }
  });
  const faux = fauxProvider({api: model.api, provider: model.provider, models: [model]});
  let role;
  const identify = messages => {
    const input = JSON.stringify(messages.find(message => message.role === "user"));
    return input.includes("OWNER_PEER_SCENARIO") ? "owner" : input.includes("PEER_A") ? "A" : input.includes("PEER_B") ? "B" : "C";
  };
  pi.on("context", event => { role ??= identify(event.messages); fixture.observe(role, event.messages); });
  const respond = context => {
    role ??= identify(context.messages);
    return fixture.response(role, context);
  };
  faux.setResponses(Array.from({length: 32}, () => respond));
  pi.registerProvider(faux.provider);
}
`,
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }));
try {
	sub = await import("./index.ts");
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
	});
	await resourceLoader.reload();
	owner = (
		await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.create(cwd),
			model: model as never,
			thinkingLevel: "off",
		})
	).session;
	await owner.bindExtensions({ onError: captureError });
	const inherited = owner.getActiveToolNames();
	await owner.prompt("OWNER_PEER_SCENARIO");
	assert.equal(owner.isStreaming, false);
	const ownerId = owner.sessionManager.getSessionId();
	await until(() => sub.readWorker(bId)?.idleSince != null, "B ends its turn and stays idle");
	assert.equal(readFileSync(join(workerCwd, "independent.txt"), "utf8"), "independent");
	assert.equal(calls.get("B"), 4);
	assert.equal(calls.get("A"), 1);
	const idleCalls = calls.get("B");
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(calls.get("B"), idleCalls, "an idle worker makes no provider request while waiting");
	assert.equal(calls.get("owner"), 2, "the idle parent does not relay the question");
	assert.equal(custom(owner).length, 0);
	const a = sub.listWorkers().find((record) => record.id === aId);
	const b = sub.listWorkers().find((record) => record.id === bId);
	assert.ok(a, "worker A is listed");
	assert.ok(b, "worker B is listed");
	assert.equal(sub.sharedWorkerState.peerHub.status(b.sessionId, questionId).status, "sent_unconfirmed");
	releaseBusy.resolve();
	await until(() => sub.readWorker(bId)?.state === "done", "B submits its result");
	assert.equal(readFileSync(join(workerCwd, "resolved-schema.txt"), "utf8"), evidence);
	assert.ok(bQuestionReceipt, "the second question receipt is retained");
	assert.equal(bQuestionReceipt.status, "context_seen");
	assert.equal(sub.sharedWorkerState.peerHub.status(a.sessionId, replyId).status, "context_seen");
	assert.equal(custom(owner).length, 0, "peer payloads never enter the parent transcript");
	releaseSubmit.resolve();
	await until(() => sub.readWorker(aId)?.state === "done", "A submits its result");
	for (const [id, result, role] of [
		[aId, "A_SCHEMA_CONFIRMED", "A"],
		[bId, "B_OUTPUT_COMPLETE", "B"],
	]) {
		const record = sub.readWorker(id);
		assert.ok(record, `the worker record for ${id} is readable`);
		assert.equal(readFileSync(sub.workerFiles(id).result, "utf8"), result);
		assert.deepEqual([...record.resolvedTools].sort(), [...inherited, "submit_result"].sort());
		for (const name of ["read", "write", "bash", "fixture_gate", "subagent_peers", "subagent_message"])
			assert.ok(surfaces.get(role)?.includes(name), `${role} lacks ${name}`);
		const sessionFile = record.sessionFile;
		assert.ok(sessionFile, "the worker kept its session file");
		const entries = SessionManager.open(sessionFile).getEntries();
		const messages = entries.filter(
			(entry): entry is CustomMessageEntry =>
				entry.type === "custom_message" && entry.customType === "subagent_peer",
		);
		assert.ok(
			messages.some((entry) => {
				const details = entry.details;
				return isJsonObject(details) && details.id === (role === "A" ? questionId : replyId);
			}),
			"Pi retains the incoming peer ID",
		);
		const outbound = entries.filter(
			(entry): entry is SessionMessageEntry & { message: ToolResultMessage } =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "subagent_message",
		);
		assert.ok(
			outbound.some((entry) => {
				const details = entry.message.details;
				return isJsonObject(details) && details.id === (role === "A" ? replyId : questionId);
			}),
			"Pi retains the outgoing peer ID",
		);
	}
	await owner.waitForIdle();
	await owner.prompt("CHECK_TERMINAL_PEER");
	const refused = lastResult(owner, "subagent_message");
	assert.ok(refused, "the terminal refusal result is present");
	assert.equal(refused.isError, true);
	assert.match(text(refused), /unavailable|closed/);
	await owner.prompt("START_CANCEL_PEER");
	const c = sub.listWorkers().find((record) => record.task === "PEER_C");
	assert.ok(c, "the cancelling peer is listed");
	await until(() => sub.readWorker(c.id)?.idleSince != null, "C ends its turn and stays idle");
	await owner.prompt("PAUSE_WAITING_PEER");
	assert.ok(sub.readWorker(c.id)?.interruptedAt);
	await owner.prompt("SEND_PAUSED_PEER");
	const pausedSend = lastResult(owner, "subagent_message");
	assert.ok(pausedSend, "the paused-send refusal is present");
	assert.equal(pausedSend.isError, true);
	assert.match(text(pausedSend), /paused/);
	assert.equal(calls.get("C"), 1, "peer input does not resume an operator-paused worker");
	await owner.prompt("CANCEL_WAITING_PEER");
	const cancelled = lastResult(owner, "subagent_kill");
	assert.ok(cancelled, "the cancellation result is present");
	assert.match(text(cancelled), /cancelled/);
	await until(() => sub.readWorker(c.id)?.state === "cancelled", "the owner cancels C");
	assert.ok(!sub.sharedWorkerState.peerHub.list(ownerId).peers.some((peer) => peer.id === c.id));
	assert.equal(calls.get("C"), 1, "abort does not start another provider request");
	await owner.waitForIdle();
	sub.shutdownWorkerSession(owner);
	await until(() => !sub.sharedWorkerState.reportSinks.has(ownerId), "owner shutdown removes session resources");
	owner = null;
	assert.deepEqual(errors, []);
	console.log(
		"peer delivery child: PASS (direct IDs, context_seen, idle parent, idle activation, inherited tools, results, refusal, cancellation)",
	);
} finally {
	releaseBusy.resolve();
	releaseSubmit.resolve();
	try {
		owner?.dispose();
	} catch {}
	delete fixtureHost[key];
	clearTimeout(watchdog);
	rmSync(root, { recursive: true, force: true });
	process.off("unhandledRejection", captureError);
	process.off("uncaughtException", captureError);
}
