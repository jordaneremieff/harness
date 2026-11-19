import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { ordinaryLifecycle } from "./index.ts";
import { ordinaryLive } from "./live-host.ts";
import { markdownContribution, type MarkdownHost, type MarkdownCommandCall } from "./durable.ts";
import { readLiveConfig, type LiveCommand, type LiveConfig, type LiveState } from "./live-protocol.ts";
import { responseDigest } from "./responses.ts";
const pane = () => ({ workspace: randomUUID().toUpperCase(), document: randomUUID().toUpperCase() });
async function post(config: LiveConfig, path: string, body: unknown) {
	const result = await fetch(config.endpoint + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000),
	});
	assert.equal(result.status, 200, await result.clone().text());
	return (await result.json()) as {
		handle: string;
		command: LiveCommand;
		state: LiveState;
		status: string;
		submissionId: string;
	};
}
async function nextCommand(config: LiveConfig, binding: ReturnType<typeof pane>): Promise<LiveCommand> {
	let after = 0;
	for (let turn = 0; turn < 20; turn++) {
		const poll = await post(config, "/poll", { ...binding, after });
		if (poll.command) return poll.command;
		after = poll.state.sequence;
	}
	throw new Error("No native command arrived within the bounded progress updates.");
}
test("ordinary pane prompts use the captured session and session changes revoke its capability", {
	timeout: 10000,
}, async () => {
	const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
	const sent: unknown[][] = [];
	const pi = {
		on(name: string, handler: (...args: unknown[]) => void) {
			const set = handlers.get(name) ?? new Set();
			set.add(handler);
			handlers.set(name, set);
			return () => {
				set.delete(handler);
			};
		},
		sendUserMessage: (...args: unknown[]) => sent.push(args),
	} as unknown as ExtensionAPI;
	const lifecycle = ordinaryLifecycle(pi);
	const live = ordinaryLive(pi, lifecycle);
	let id = "ordinary-one";
	const ctx = { sessionManager: { getSessionId: () => id } } as ExtensionContext;
	const config = await live.connection(ctx);
	const binding = pane();
	try {
		const handle = (await post(config, "/connect", binding)).handle;
		const operationId = randomUUID();
		await post(config, "/prompt", { ...binding, operationId, text: "Correct the current buffer." });
		assert.equal(sent.length, 1);
		assert.match(String(sent[0][0]), new RegExp(handle));
		assert.deepEqual(sent[0][1], { deliverAs: "followUp", expandPromptTemplates: false });
		const emit = (name: string, message: unknown) => {
			for (const handler of handlers.get(name) ?? []) handler({ message });
		};
		emit("message_end", fauxAssistantMessage("Chat answer before delivery"));
		assert.equal((await post(config, "/poll", { ...binding, after: 0 })).state.status, "queued");
		emit("message_start", { role: "user", content: [{ type: "text", text: sent[0][0] }] });
		emit("message_end", fauxAssistantMessage(fauxToolCall("markdown_live", {}), { stopReason: "toolUse" }));
		emit("message_end", fauxAssistantMessage("Pane answer"));
		emit("message_start", { role: "user", content: "A chat question" });
		emit("message_end", fauxAssistantMessage("A later chat answer"));
		const { state } = await post(config, "/poll", { ...binding, after: 0 });
		assert.equal(state.operationId, operationId);
		assert.equal(state.text, "Pane answer");
		for (const handler of [...(handlers.get("session_before_switch") ?? [])]) handler();
		id = "ordinary-two";
		assert.equal(await live.find(ctx), undefined);
		await assert.rejects(post(config, "/prompt", { ...binding, operationId: randomUUID(), text: "Stale request" }));
		assert.equal(sent.length, 1);
	} finally {
		for (const handler of [...(handlers.get("session_shutdown") ?? [])]) handler();
	}
});
function assertPaneReply(state: LiveState, operationId: string, mode: string, index: number) {
	assert.equal(state.operationId, operationId);
	if (mode === "all") {
		assert.equal(state.status, "error");
		assert.match(state.text, /another message/u);
		assert.doesNotMatch(state.text, /Shared chat reply/u);
	} else {
		assert.equal(state.status, "answer");
		assert.equal(state.text, index === 0 ? "First document reply." : "Second document reply.");
	}
}
test("ordinary Pi delivers queued questions to their own panes and does not guess a shared answer", {
	timeout: 15000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-ask-"));
	const faux = fauxProvider({ tokensPerSecond: 0 });
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	let config!: LiveConfig, close: (() => void) | undefined;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: settings,
		noContextFiles: true,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				const live = ordinaryLive(pi, ordinaryLifecycle(pi));
				pi.on("session_start", async (_event, ctx) => {
					config = await live.connection(ctx);
					const bridge = await live.find(ctx);
					close = () => bridge?.close();
				});
			},
		],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(root),
			settingsManager: settings,
			resourceLoader: loader,
			tools: [],
		}));
		await session.bindExtensions({ mode: "tui" });
		for (const mode of ["one-at-a-time", "all"] as const) {
			session.setFollowUpMode(mode);
			const panes = [pane(), pane()];
			const ids = [randomUUID(), randomUUID()];
			for (const binding of panes) await post(config, "/connect", binding);
			let entered!: () => void, release!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			faux.setResponses([
				async () => {
					entered();
					await gate;
					return fauxAssistantMessage("Only in chat.");
				},
				...(mode === "all" ? ["Shared chat reply."] : ["First document reply.", "Second document reply."]).map((s) =>
					fauxAssistantMessage(s),
				),
			]);
			const run = session.prompt("An unrelated chat question.");
			try {
				await started;
				for (const [i, binding] of panes.entries()) {
					const receipt = await post(config, "/prompt", {
						...binding,
						operationId: ids[i],
						text: "Explain the document.",
					});
					assert.equal(receipt.status, "requested");
				}
			} finally {
				release();
			}
			await run;
			await session.waitForIdle();
			for (const [i, binding] of panes.entries()) {
				const { state } = await post(config, "/poll", { ...binding, after: 0 });
				assertPaneReply(state, ids[i], mode, i);
			}
			assert.equal(session.getLastAssistantText(), mode === "all" ? "Shared chat reply." : "Second document reply.");
		}
	} finally {
		close?.();
		session?.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
test("the real Durable contribution reconciles lost admission and edits only its exact live native buffer", {
	timeout: 15000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "markdown-live-native-"));
	const previous = {
		PI_MARKDOWN_DIR: process.env.PI_MARKDOWN_DIR,
		PI_MARKDOWN_APP: process.env.PI_MARKDOWN_APP,
		PI_HARNESS_FILE: process.env.PI_HARNESS_FILE,
	};
	process.env.PI_MARKDOWN_DIR = join(root, "documents");
	process.env.PI_MARKDOWN_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const dispose: (() => void | Promise<void>)[] = [];
	try {
		const host: MarkdownHost = {
			durable: Durable,
			agentDir: root,
			cwd: root,
			storageId: "synthetic",
			harness,
			onClose: (fn) => dispose.push(fn),
		};
		const contribution = markdownContribution(
			new URL("./index.ts", import.meta.url).pathname,
			createEventBus(),
			() => {},
		);
		registry.install(contribution.create(host));
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const other = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
			context,
		);
		faux.setResponses([fauxAssistantMessage("Unrelated retained answer")]);
		await (await conversation.submit({ type: "input", content: "An earlier unrelated request." }, context)).wait(
			context,
		);
		const call: MarkdownCommandCall = {
			args: "",
			data: { op: "live" },
			origin: "operator",
			conversation,
			context,
			host,
			invocationId: "live",
		};
		await assert.rejects(contribution.commands[0].run({ ...call, origin: "model" }), /Only a local operator/u);
		const answer = await contribution.commands[0].run(call);
		assert.notEqual(typeof answer, "string");
		if (typeof answer === "string") throw new Error("No connection data");
		const config = readLiveConfig((answer.data as { connection: unknown }).connection);
		const binding = pane();
		const handle = (await post(config, "/connect", binding)).handle;
		const untouched = pane();
		await post(config, "/connect", untouched);
		assert.equal(
			(await post(config, "/poll", { ...binding, after: 1 })).state.text,
			"",
			"opening a pane does not replay an unrelated answer",
		);
		const operationId = randomUUID();
		let source = "Unsaved old";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("markdown_live", { op: "read", handle }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("markdown_live", {
					op: "apply",
					handle,
					operationId,
					baseGeneration: 2,
					baseDigest: responseDigest(source),
					edits: [{ start: 8, end: 11, expected: "old", replacement: "new" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The live buffer is corrected."),
		]);
		const submit = conversation.submit.bind(conversation);
		const admitted: string[] = [];
		t.mock.method(conversation, "submit", async (draft: Durable.SubmissionDraft, submitContext: typeof context) => {
			const submission = await submit(draft, submitContext);
			admitted.push(String(submission.id));
			if (admitted.length === 1) throw new Error("The admission receipt was lost.");
			return submission;
		});
		const prompt = { ...binding, operationId: randomUUID(), text: "Correct old to new." };
		assert.equal((await post(config, "/prompt", prompt)).status, "uncertain");
		const receipt = await post(config, "/prompt", prompt);
		assert.equal(receipt.status, "admitted");
		assert.deepEqual(admitted, [receipt.submissionId, receipt.submissionId]);
		assert.equal((await post(config, "/prompt", prompt)).submissionId, receipt.submissionId);
		assert.equal(admitted.length, 2, "an admitted receipt never resubmits");
		for (const op of ["read", "apply"]) {
			const command = await nextCommand(config, binding);
			assert.equal(command.op, op);
			const result =
				op === "read"
					? { status: "ok", source, generation: 2, digest: responseDigest(source), assets: [] }
					: { status: "applied", operationId, generation: 3, digest: responseDigest("Unsaved new"), retained: true };
			if (command.op === "apply") {
				assert.deepEqual(command.edits, [{ start: 8, end: 11, expected: "old", replacement: "new" }]);
				source = "Unsaved new";
			}
			await post(config, "/result", { ...binding, requestId: command.requestId, result });
		}
		await conversation.waitForIdle(context);
		assert.equal(source, "Unsaved new");
		let state: LiveState = { sequence: 0, status: "idle", text: "", truncated: false };
		for (let turn = 0; turn < 10 && state.status !== "answer"; turn++)
			state = (await post(config, "/poll", { ...binding, after: state.sequence })).state;
		assert.equal(state.status, "answer");
		assert.equal(state.text, "The live buffer is corrected.");
		assert.equal(
			(await post(config, "/poll", { ...untouched, after: 1 })).state.text,
			"",
			"the answer stays with the pane that asked",
		);
		assert.equal((await other.entries({}, 20, undefined, context)).items.length, 0);
		const entries = (await conversation.entries({}, 40, undefined, context)).items;
		const results = entries.filter((entry) => Durable.ToolResultEntry.is(entry)).map((entry) => entry.model?.[0]);
		assert.equal(results.length, 2);
		assert.ok(results.every((result) => result?.role === "toolResult" && !result.isError));
	} finally {
		for (const fn of dispose) await fn();
		await harness.close(context);
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
