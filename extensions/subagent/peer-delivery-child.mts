/** Direct SDK regression for peer delivery, explicit wait, and session ownership. */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "subagent-peer-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const home = join(root, "home");
const { mkdirSync } = await import("node:fs");
for (const path of [agentDir, cwd, home]) mkdirSync(path);
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
const requestMessages = new Map<string, any[]>();
const sessionMessages = new Map<string, any[]>();
const evidence = "fixture_schema_field_7c4e";
writeFileSync(join(cwd, "schema.txt"), evidence);
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
let owner: any;
let sub: typeof import("./index.ts");
let questionId = "";
let replyId = "";
let aId = "";
let bId = "";
let bQuestionReceipt: any;
let terminalRefusal = false;
let cancelRequested = false;
let pauseRequested = false;
let pausedSendRequested = false;
let rootWaitRequested = false;
const key = Symbol.for("subagent-test.peer-fixture");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const tool = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const lastResult = (context: any, name: string) =>
	context.messages.filter((message: any) => message.role === "toolResult" && message.toolName === name).at(-1);
const custom = (context: any) =>
	context.messages.filter((message: any) => message.role === "custom" && message.customType === "subagent_peer");
const peerMessages = (role: string) => custom({ messages: sessionMessages.get(role) ?? [] });
const text = (message: any) =>
	typeof message?.content === "string"
		? message.content
		: (message?.content
				?.filter((part: any) => part.type === "text")
				.map((part: any) => part.text)
				.join("\n") ?? "");
const response = async (role: string, context: any) => {
	const count = (calls.get(role) ?? 0) + 1;
	calls.set(role, count);
	requestMessages.set(role, context.messages);
	surfaces.set(
		role,
		context.tools.map((item: any) => item.name),
	);
	if (role === "owner") {
		if (count === 1) return tool("subagent", { tasks: [{ task: "PEER_A" }, { task: "PEER_B" }] });
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes("CHECK_ROOT_WAIT") && !rootWaitRequested) {
			rootWaitRequested = true;
			return tool("subagent_wait", { timeoutSeconds: 1 });
		}
		if (serialized.includes("SEND_PAUSED_PEER") && !pausedSendRequested) {
			pausedSendRequested = true;
			return tool("subagent_message", {
				to: sub.listWorkers().find((record) => record.task === "PEER_C")!.id,
				message: "Do not resume",
			});
		}
		if (serialized.includes("PAUSE_WAITING_PEER") && !pauseRequested) {
			pauseRequested = true;
			return tool("subagent_interrupt", { id: sub.listWorkers().find((record) => record.task === "PEER_C")!.id });
		}
		if (serialized.includes("CANCEL_WAITING_PEER") && !cancelRequested) {
			cancelRequested = true;
			return tool("subagent_kill", { id: sub.listWorkers().find((record) => record.task === "PEER_C")!.id });
		}
		if (serialized.includes("START_CANCEL_PEER") && !sub.listWorkers().some((record) => record.task === "PEER_C"))
			return tool("subagent", { task: "PEER_C" });
		if (serialized.includes("CHECK_TERMINAL_PEER") && !terminalRefusal) {
			terminalRefusal = true;
			return tool("subagent_message", { to: aId, message: "Late message" });
		}
		return fauxAssistantMessage("OWNER_IDLE");
	}
	if (role === "A") {
		if (count === 1) return tool("fixture_gate", { stage: "busy" });
		if (count === 2) {
			assert.equal(peerMessages("A").length, 1, "A receives the question after its busy tool");
			questionId = peerMessages("A")[0].details.id;
			assert.match(text(peerMessages("A")[0]), /Which schema field/);
			assert.ok(context.messages.some((message: any) => text(message).includes("Which schema field")));
			return tool("read", { path: "schema.txt" });
		}
		if (count === 3) {
			const observed = text(lastResult(context, "read")).trim();
			assert.equal(observed, evidence);
			return tool("subagent_message", {
				to: peerMessages("A")[0].details.from,
				message: `Use ${observed}`,
				replyTo: questionId,
			});
		}
		if (count === 4) {
			replyId = lastResult(context, "subagent_message").details.id;
			return tool("fixture_gate", { stage: "submit" });
		}
		return tool("submit_result", { content: "A_SCHEMA_CONFIRMED" });
	}
	if (role === "B") {
		if (count === 1) {
			await busy.promise;
			return tool("subagent_peers", {});
		}
		if (count === 2) {
			const directory = lastResult(context, "subagent_peers").details;
			bId = directory.self;
			const peer = directory.peers.find((item: any) => item.id !== directory.self && item.parent !== null);
			assert.ok(peer, JSON.stringify(directory));
			aId = peer.id;
			return tool("subagent_message", { to: aId, message: "Which schema field does schema.txt require?" });
		}
		if (count === 3) {
			const receipt = lastResult(context, "subagent_message").details;
			questionId = receipt.id;
			assert.equal(receipt.status, "sent_unconfirmed");
			return tool("bash", { command: "printf independent > independent.txt" });
		}
		if (count === 4) return tool("subagent_wait", { timeoutSeconds: 10 });
		if (count === 5) {
			assert.equal(lastResult(context, "subagent_wait").details.status, "message");
			const answer = peerMessages("B").at(-1);
			assert.ok(answer, "B receives a custom peer reply, not a parent relay");
			assert.equal(answer.details.replyTo, questionId);
			replyId = answer.details.id;
			const match = text(answer).match(/Use (fixture_schema_field_[a-z0-9]+)/);
			assert.ok(match, text(answer));
			assert.ok(context.messages.some((message: any) => text(message).includes(`Use ${match[1]}`)));
			return tool("write", { path: "resolved-schema.txt", content: match[1] });
		}
		if (count === 6) return tool("subagent_kill", { id: aId });
		if (count === 7) {
			assert.match(text(lastResult(context, "subagent_kill")), /only its owning session/i);
			assert.equal(sub.readWorker(aId)?.state, "running");
			return tool("subagent_message", { id: questionId });
		}
		if (count === 8) {
			bQuestionReceipt = lastResult(context, "subagent_message").details;
			assert.equal(bQuestionReceipt.status, "context_seen");
			return tool("submit_result", { content: "B_OUTPUT_COMPLETE" });
		}
		throw new Error(`Unexpected B provider request ${count}`);
	}
	if (role === "C") return tool("subagent_wait", { timeoutSeconds: 10 });
	throw new Error(`Unknown fixture role ${role}`);
};
(globalThis as any)[key] = {
	response,
	observe(role: string, messages: any[]) {
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
	await until(
		() => sub.sharedWorkerState.peerHub.list(ownerId).peers.some((peer) => peer.id === bId && peer.waiting),
		"B waits for A",
	);
	assert.equal(readFileSync(join(cwd, "independent.txt"), "utf8"), "independent");
	assert.equal(calls.get("B"), 4);
	assert.equal(calls.get("A"), 1);
	const waitingCalls = calls.get("B");
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(calls.get("B"), waitingCalls, "wait performs no provider request");
	assert.equal(calls.get("owner"), 2, "the idle parent does not relay the question");
	assert.equal(custom(owner).length, 0);
	const a = sub.listWorkers().find((record) => record.id === aId)!;
	const b = sub.listWorkers().find((record) => record.id === bId)!;
	assert.ok(a && b);
	assert.equal(sub.sharedWorkerState.peerHub.status(b.sessionId, questionId).status, "sent_unconfirmed");
	releaseBusy.resolve();
	await until(() => sub.readWorker(bId)?.state === "done", "B submits its result");
	assert.equal(readFileSync(join(cwd, "resolved-schema.txt"), "utf8"), evidence);
	assert.equal(bQuestionReceipt.status, "context_seen");
	assert.equal(sub.sharedWorkerState.peerHub.status(a.sessionId, replyId).status, "context_seen");
	assert.equal(custom(owner).length, 0, "peer payloads never enter the parent transcript");
	releaseSubmit.resolve();
	await until(() => sub.readWorker(aId)?.state === "done", "A submits its result");
	for (const [id, result, role] of [
		[aId, "A_SCHEMA_CONFIRMED", "A"],
		[bId, "B_OUTPUT_COMPLETE", "B"],
	]) {
		const record = sub.readWorker(id)!;
		assert.equal(readFileSync(sub.workerFiles(id).result, "utf8"), result);
		assert.deepEqual([...record.resolvedTools].sort(), [...inherited, "submit_result"].sort());
		for (const name of ["read", "write", "bash", "fixture_gate", "subagent_peers", "subagent_message", "subagent_wait"])
			assert.ok(surfaces.get(role)?.includes(name), `${role} lacks ${name}`);
		const entries = SessionManager.open(record.sessionFile!).getEntries();
		const messages = entries.filter(
			(entry: any) => entry.type === "custom_message" && entry.customType === "subagent_peer",
		);
		assert.ok(
			messages.some((entry: any) => entry.details.id === (role === "A" ? questionId : replyId)),
			"Pi retains the incoming peer ID",
		);
		const outbound = entries.filter(
			(entry: any) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "subagent_message",
		);
		assert.ok(
			outbound.some((entry: any) => entry.message.details.id === (role === "A" ? replyId : questionId)),
			"Pi retains the outgoing peer ID",
		);
	}
	await owner.waitForIdle();
	await owner.prompt("CHECK_TERMINAL_PEER");
	const refused = lastResult(owner, "subagent_message");
	assert.equal(refused.isError, true);
	assert.match(text(refused), /unavailable|closed/);
	await owner.prompt("START_CANCEL_PEER");
	const c = sub.listWorkers().find((record) => record.task === "PEER_C")!;
	assert.ok(c);
	await until(
		() => sub.sharedWorkerState.peerHub.list(ownerId).peers.some((peer) => peer.id === c.id && peer.waiting),
		"C starts a cancellable wait",
	);
	await owner.prompt("PAUSE_WAITING_PEER");
	assert.ok(sub.readWorker(c.id)?.interruptedAt);
	await owner.prompt("SEND_PAUSED_PEER");
	assert.equal(lastResult(owner, "subagent_message").isError, true);
	assert.match(text(lastResult(owner, "subagent_message")), /paused/);
	assert.equal(calls.get("C"), 1, "peer input does not resume an operator-paused worker");
	await owner.prompt("CANCEL_WAITING_PEER");
	assert.match(text(lastResult(owner, "subagent_kill")), /cancelled/);
	await until(() => sub.readWorker(c.id)?.state === "cancelled", "the owner cancels C");
	assert.ok(!sub.sharedWorkerState.peerHub.list(ownerId).peers.some((peer) => peer.id === c.id));
	assert.equal(calls.get("C"), 1, "abort does not start another provider request");
	await owner.prompt("CHECK_ROOT_WAIT");
	assert.equal(lastResult(owner, "subagent_wait").details.status, "timeout", "the root has the same wait capability");
	await owner.waitForIdle();
	sub.shutdownWorkerSession(owner);
	await until(() => !sub.sharedWorkerState.reportSinks.has(ownerId), "owner shutdown removes session resources");
	owner = null;
	assert.deepEqual(errors, []);
	console.log(
		"peer delivery child: PASS (direct IDs, context_seen, idle parent, wait, inherited tools, results, refusal, cancellation)",
	);
} finally {
	releaseBusy.resolve();
	releaseSubmit.resolve();
	try {
		owner?.dispose();
	} catch {}
	delete (globalThis as any)[key];
	clearTimeout(watchdog);
	rmSync(root, { recursive: true, force: true });
	process.off("unhandledRejection", captureError);
	process.off("uncaughtException", captureError);
}
