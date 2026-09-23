import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonObject, TranscriptContext } from "@earendil-works/pi-ai";
import { planNames } from "./plans.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-plans-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const failCwd = join(root, "broken");
const pauseCwd = join(root, "paused-setup");
for (const path of [agentDir, cwd, failCwd, pauseCwd, join(root, "home")]) mkdirSync(path);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = join(root, "home");
const errors: unknown[] = [];
const capture = (error: unknown) => errors.push(error);
process.on("unhandledRejection", capture);
process.on("uncaughtException", capture);
const watchdog = setTimeout(() => {
	console.error("Plan fixture timed out", errors);
	process.exit(1);
}, 75_000);
let owner: AgentSession | undefined;
let context: ExtensionContext | undefined;
let releaseSetup = () => {};
const setupGate = new Promise<void>((resolve) => {
	releaseSetup = resolve;
});
let setupEntered = false;
const model = {
	id: "plan-model",
	name: "Plan Model",
	api: "plan-fixture-api",
	provider: "plan-fixture",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const tool = (name: string, args: JsonObject) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
type AgentMessage = AgentSession["state"]["messages"][number];
interface State {
	messages: AgentMessage[];
	read?: boolean;
	round?: number;
	peer?: number;
	wrote?: boolean;
	checked?: boolean;
	excess?: boolean;
	submitted?: boolean;
}
let workerCalls = 0;
let allCalls = 0;
const evidence = "source_rule=7";
writeFileSync(join(cwd, "source.txt"), evidence);
const textOf = (message: { content?: unknown }): string =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
			: "";
const resultOf = (transcript: TranscriptContext, name: string) =>
	transcript.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
function response(transcript: TranscriptContext, state: State) {
	allCalls++;
	const task = transcript.messages
		.filter((message) => message.role === "user")
		.map(textOf)
		.join("\n");
	if (task.includes("PLAIN_TASK")) {
		workerCalls++;
		return tool("submit_result", { content: "PLAIN_RESULT" });
	}
	const role = /Your role: ([a-z0-9-]+)\./.exec(task)?.[1];
	if (!role) return fauxAssistantMessage("OWNER_IDLE");
	workerCalls++;
	if (task.includes("WAIT_PLAN")) return fauxAssistantMessage("WAIT_FOR_OWNER");
	assert.ok(task.includes("shared-fixture-context"));
	assert.ok(task.includes("Source guidance"));
	assert.ok(task.includes("Output contract"));
	const roster = task.slice(task.lastIndexOf("Peer roster"));
	const peers = [...roster.matchAll(/(?:^|\n)([a-z0-9-]+): (bg-[a-z0-9]+)/g)].map((match) => ({
		role: match[1],
		id: match[2],
	}));
	assert.ok(peers.length >= 1, roster);
	const received = state.messages.filter(
		(message): message is Extract<AgentMessage, { role: "custom" }> =>
			message.role === "custom" && message.customType === "subagent_peer",
	);
	const has = (id: string, round: number) =>
		received.some(
			(message) => textOf(message).includes(`from ${id} to`) && textOf(message).includes(`ROUND ${round}: ${evidence}`),
		);
	if (!state.read) {
		state.read = true;
		return tool("read", { path: "source.txt" });
	}
	assert.equal(textOf(resultOf(transcript, "read") ?? {}), evidence);
	const exchange =
		role === "implementer" ? implementerResponse(state, peers[0].id, has) : reviewerResponse(state, peers, role, has);
	if (exchange) return exchange;
	if (!state.excess) {
		state.excess = true;
		return tool("subagent_message", { to: peers[0].id, message: "OVER_BUDGET" });
	}
	assert.match(textOf(resultOf(transcript, "subagent_message") ?? {}), /allowance is exhausted/);
	state.submitted = true;
	return tool("submit_result", {
		content: `${role}: checked source.txt; ${evidence}; acceptance satisfied; no unresolved disagreement.`,
	});
}
function implementerResponse(state: State, peer: string, has: (id: string, round: number) => boolean) {
	if (!has(peer, 0)) return fauxAssistantMessage("WAIT_FOR_ADVICE");
	if (!state.wrote) {
		state.wrote = true;
		return tool("write", { path: "implemented.txt", content: evidence });
	}
	if (!state.round) {
		state.round = 1;
		return tool("subagent_message", { to: peer, message: `ROUND 1: ${evidence}` });
	}
	if (!has(peer, 1)) return fauxAssistantMessage("WAIT_FOR_FEEDBACK");
	if (!state.checked) {
		state.checked = true;
		return tool("read", { path: "implemented.txt" });
	}
	return undefined;
}
function reviewerResponse(
	state: State,
	peers: Array<{ id: string }>,
	role: string,
	has: (id: string, round: number) => boolean,
) {
	const round = state.round ?? 0;
	const peer = state.peer ?? 0;
	if (round <= 1) {
		const ready = round === 0 || peers.every((entry) => has(entry.id, role === "advisor" ? 1 : round - 1));
		if (!ready) return fauxAssistantMessage("WAIT_FOR_PEER");
		state.peer = peer + 1;
		if (state.peer === peers.length) {
			state.peer = 0;
			state.round = round + 1;
		}
		return tool("subagent_message", { to: peers[peer].id, message: `ROUND ${round}: ${evidence}` });
	}
	if (role !== "advisor" && !peers.every((entry) => has(entry.id, 1)))
		return fauxAssistantMessage("WAIT_FOR_FINAL_PEER");
	return undefined;
}
const key = Symbol.for("subagent-test.named-plans");
const sessionStarts = new Map<string, number>();
const fixture = {
	failCwd,
	pauseCwd,
	response,
	capture(ctx: ExtensionContext) {
		const id = ctx.sessionManager.getSessionId();
		sessionStarts.set(id, (sessionStarts.get(id) ?? 0) + 1);
		if (ctx.cwd === cwd && !context) context = ctx;
	},
	async pause() {
		setupEntered = true;
		await setupGate;
	},
};
(globalThis as Record<symbol, unknown>)[key] = fixture;
const providerPath = join(agentDir, "fixture.mjs");
writeFileSync(
	providerPath,
	`
import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
export default function(pi) {
 const fixture = globalThis[Symbol.for("subagent-test.named-plans")];
 const state = {messages: []};
 pi.registerCommand("plan-fixture-reload", { description: "Reload the fixture worker", handler: async (_args, ctx) => ctx.reload() });
 pi.on("session_start", async (_, ctx) => {
   fixture.capture(ctx);
   if (ctx.cwd === fixture.failCwd) pi.setActiveTools(["submit_result"]);
   if (ctx.cwd === fixture.pauseCwd) await fixture.pause();
 });
 pi.on("context", event => { state.messages = event.messages; });
 const faux = fauxProvider({api: model.api, provider: model.provider, models: [model]});
 faux.setResponses(Array.from({length: 100}, () => context => fixture.response(context, state)));
 pi.registerProvider(model.provider, { api: model.api, apiKey: "fixture-not-used", baseUrl: model.baseUrl, models: [model], streamSimple: (...args) => faux.provider.streamSimple(...args) });
}
`,
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }));
const sub = await import("./index.ts");
async function until(check: () => boolean, label: string) {
	const end = Date.now() + 15_000;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(
		check(),
		`${label}: ${JSON.stringify(sub.listWorkers().map(({ id, state, error, lastOutput, toolErrors }) => ({ id, state, error, lastOutput, toolErrors })))}; ${JSON.stringify(errors)}`,
	);
}
try {
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
	await owner.bindExtensions({ onError: capture });
	sub.recordWorkerSurface(owner.sessionManager.getSessionId(), owner.getActiveToolNames(), owner.getAllTools());
	assert.ok(context);
	const tools = new Map<string, ToolDefinition>();
	sub.default({
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		registerMessageRenderer() {},
		registerCommand() {},
		on() {},
	} as never);
	const dispatch = tools.get("subagent");
	assert.ok(dispatch);
	const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
		dispatch.execute("fixture", args, signal, undefined, context as ExtensionContext);
	const plan = (name: (typeof planNames)[number], extra = {}) => ({
		name,
		objective: "Determine the source rule.",
		sources: "Read source.txt",
		boundaries: "Only the implementer edits implemented.txt. No publication.",
		integration: { destination: "Parent result", acceptance: "The result equals source_rule=7." },
		members: [{ task: "Inspect semantics." }, { task: "Inspect edge cases." }],
		...extra,
	});
	const inherited = owner.getActiveToolNames();
	const profilePath = join(cwd, "review.json");
	writeFileSync(
		profilePath,
		JSON.stringify({ name: "review", instructions: "Cite the checked source.", model: "plan-fixture/plan-model" }),
	);
	const before = allCalls;
	const preview = await call({
		plan: plan("panel-review"),
		profile: profilePath,
		dryRun: true,
		sharedContext: "shared-fixture-context",
	});
	assert.equal(allCalls, before, "dry-run makes no provider call, including the parent");
	assert.equal(sub.listWorkers().length, 0, "dry-run creates no worker records");
	assert.match(JSON.stringify(preview), /Cite the checked source/);
	assert.match(JSON.stringify(preview), /reviewer-1/);
	assert.ok(dispatch.renderCall);
	const card = dispatch.renderCall(
		{ plan: plan("panel-review"), dryRun: true },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
		{ expanded: true } as never,
	);
	assert.ok(card);
	assert.match(card.render(120).join("\n"), /preview only; no workers or model calls/);
	const largeProfile = join(cwd, "large.json");
	writeFileSync(largeProfile, JSON.stringify({ instructions: "x".repeat(13000) }));
	await assert.rejects(
		call({ plan: plan("panel-review"), profile: largeProfile, sharedContext: "x".repeat(16384), dryRun: true }),
		/48KiB/,
	);
	for (const args of [
		{ plan: plan("panel-review"), task: "ambiguous" },
		{ task: "ordinary", dryRun: true },
		{ plan: plan("panel-review"), tools: [] },
		{ plan: plan("panel-review", { members: [{ task: "valid" }, { task: "missing", model: "absent/no-model" }] }) },
	])
		await assert.rejects(call(args));
	assert.equal(sub.listWorkers().length, 0);
	for (const name of planNames) {
		const existing = new Set(sub.listWorkers().map((record) => record.id));
		const members =
			name === "panel-review"
				? [{ task: "Check semantics" }, { task: "Check edge cases" }, { task: "Check evidence" }]
				: undefined;
		await call({
			plan: plan(name, members ? { members } : {}),
			sharedContext: "shared-fixture-context",
			deadlineMinutes: 1,
		});
		const records = sub.listWorkers().filter((record) => !existing.has(record.id));
		assert.equal(records.length, members?.length ?? 2);
		await until(() => records.every((record) => sub.readWorker(record.id)?.state === "done"), `${name} completes`);
		for (const { id } of records) {
			const record = sub.readWorker(id);
			assert.ok(record?.collaboration);
			assert.equal(record.collaboration.messagesSent, record.collaboration.messageLimit);
			assert.deepEqual([...record.resolvedTools].sort(), [...inherited, "submit_result"].sort());
			assert.match(readFileSync(sub.workerFiles(id).result, "utf8"), /source_rule=7/);
			assert.ok(record.task.includes("Peer roster"));
		}
	}
	assert.equal(readFileSync(join(cwd, "implemented.txt"), "utf8"), evidence);
	const source = sub.listWorkers().find((record) => record.collaboration?.role === "implementer");
	assert.ok(source);
	const followup = await sub.continueWorker(source.id, "PLAIN_TASK", context);
	assert.equal(followup.state, "running", followup.error);
	await until(
		() => sub.readWorker(followup.id)?.state === "done",
		"plan continuation completes as a standalone follow-up",
	);
	assert.equal(sub.readWorker(followup.id)?.collaboration, undefined);
	assert.match(sub.readWorker(followup.id)?.task ?? "", /standalone follow-up/);
	assert.equal(sub.readWorker(source.id)?.collaboration?.messagesSent, source.collaboration?.messagesSent);
	await owner.waitForIdle();
	const beforeFailed = workerCalls;
	await assert.rejects(
		call({ plan: plan("panel-review", { members: [{ task: "good" }, { task: "bad", cwd: failCwd }] }) }),
		/Plan startup stopped/,
	);
	assert.equal(workerCalls, beforeFailed, "partial setup starts no worker task");
	assert.ok(sub.listWorkers().every((record) => record.state !== "running"));
	const abort = new AbortController();
	const pending = call(
		{ plan: plan("panel-review", { members: [{ task: "good" }, { task: "pause", cwd: pauseCwd }] }) },
		abort.signal,
	);
	const rejected = assert.rejects(pending, /Plan startup stopped/);
	await until(() => setupEntered, "setup hook entered");
	abort.abort();
	releaseSetup();
	await rejected;
	assert.equal(workerCalls, beforeFailed, "cancelled setup starts no worker task");
	assert.ok(sub.listWorkers().every((record) => record.state !== "running"));
	await call({ plan: plan("panel-review", { objective: "WAIT_PLAN" }) });
	const waiting = sub.listWorkers().filter((record) => record.state === "running");
	await until(() => waiting.every((record) => sub.readWorker(record.id)?.idleSince != null), "plan members idle");
	const sender = waiting[0];
	const peerTool = tools.get("subagent_message");
	assert.ok(peerTool);
	const peerContext = { sessionManager: { getSessionId: () => sender.sessionId } } as unknown as ExtensionContext;
	const send = () =>
		peerTool.execute("quota", { to: waiting[1].id, message: "bounded evidence" }, undefined, undefined, peerContext);
	await send();
	assert.equal(sub.readWorker(sender.id)?.collaboration?.messagesSent, 1);
	await sub.steerWorker(sender.id, "/plan-fixture-reload", owner.sessionManager.getSessionId());
	await until(
		() => (sessionStarts.get(sender.sessionId) ?? 0) >= 2 && sub.readWorker(sender.id)?.idleSince != null,
		"reload keeps plan ownership",
	);
	assert.equal(sub.readWorker(sender.id)?.collaboration?.messagesSent, 1);
	await send();
	await assert.rejects(send(), /allowance is exhausted/);
	for (const record of waiting) {
		const result = await sub.cancelWorker(record.id, owner.sessionManager.getSessionId());
		assert.equal(result.record?.state, "cancelled");
	}
	await call({ task: "PLAIN_TASK", tools: [] });
	await until(
		() => sub.listWorkers().some((record) => record.task === "PLAIN_TASK" && record.state === "done"),
		"ordinary dispatch still works",
	);
	await owner.waitForIdle();
	assert.deepEqual(errors, []);
	console.log("named plans runtime: PASS");
} catch (cause) {
	console.error(cause, errors);
	process.exitCode = 1;
} finally {
	releaseSetup();
	if (owner) {
		await owner.abort().catch(() => {});
		owner.dispose();
	}
	clearTimeout(watchdog);
	delete (globalThis as Record<symbol, unknown>)[key];
	rmSync(root, { recursive: true, force: true });
}
