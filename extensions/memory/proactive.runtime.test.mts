import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isolateMachineSettings } from "./settings-fixture.mts";
import { proactiveCorpus, recallText, writeRecall } from "./proactive-fixture.mts";
isolateMachineSettings();

test("native provider receives notices only at admission and preserves old bytes across streamed input and tool rounds", {
	timeout: 20000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "memory-proactive-native-"));
	const corpus = proactiveCorpus(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const templates = join(root, ".pi", "prompts");
	mkdirSync(templates, { recursive: true });
	writeFileSync(join(templates, "fixture-reuse.md"), "I prefer scoped evidence");
	writeFileSync(join(templates, "fixture-transformed.md"), "I prefer transformed evidence");
	const oldDir = process.env.PI_MEMORY_DIR;
	const oldSwitch = process.env.PI_MEMORY_PROACTIVE;
	process.env.PI_MEMORY_DIR = corpus;
	process.env.PI_MEMORY_PROACTIVE = "true";
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const requests: TranscriptContext[] = [];
	const errors: string[] = [];
	const manager = SessionManager.inMemory(root);
	try {
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: false,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						if (event.text === "I prefer scoped evidence") return { action: "handled" };
						if (event.text === "I prefer transformed evidence")
							return { action: "transform", text: "Transformed fixture input" };
					});
					pi.registerTool({
						name: "fixture_step",
						label: "Fixture",
						description: "Queue controlled input.",
						parameters: Type.Object({}),
						async execute() {
							assert.ok(session);
							await session.prompt("I prefer durable plain words", { streamingBehavior: "steer" });
							await session.prompt("From now on use short paragraphs", { streamingBehavior: "followUp" });
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					});
					pi.registerProvider("memory-proactive-fixture", {
						api: "memory-proactive-fixture",
						baseUrl: "https://memory.invalid",
						apiKey: "synthetic-fixture-not-a-credential",
						models: [
							{
								id: "controlled",
								name: "Fixture",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 1024,
							},
						],
						streamSimple(model, context) {
							requests.push(structuredClone(context));
							const first = requests.length === 1;
							const message: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								timestamp: Date.now(),
								content: first
									? [{ type: "toolCall", id: "fixture-call", name: "fixture_step", arguments: {} }]
									: [{ type: "text", text: "Controlled reply." }],
								stopReason: first ? "toolUse" : "stop",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							};
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
							stream.end();
							return stream;
						},
					});
				},
			],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader: loader,
			sessionManager: manager,
			tools: ["fixture_step"],
		}));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		const model = modelRuntime.getModel("memory-proactive-fixture", "controlled");
		assert.ok(model);
		await session.setModel(model);
		session.setActiveToolsByName(["fixture_step"]);
		await session.prompt(recallText);
		const textOf = (message: TranscriptContext["messages"][number]) =>
			"content" in message
				? typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")
				: "";
		const noticeTexts = (request: TranscriptContext) =>
			request.messages.map(textOf).filter((text) => text.includes("Memory notice."));
		assert.ok(
			requests.length >= 3,
			JSON.stringify({
				errors,
				requests: requests.map((request) =>
					request.messages.map((message) => ({ role: message.role, text: textOf(message).slice(0, 200) })),
				),
			}),
		);
		const firstNotice = noticeTexts(requests[0]);
		assert.equal(firstNotice.length, 1);
		assert.match(firstNotice[0], /Memory candidate/);
		assert.doesNotMatch(JSON.stringify(requests[0]), /durable plain words|short paragraphs/);
		for (const request of requests.slice(1)) assert.equal(noticeTexts(request)[0], firstNotice[0]);
		for (const input of [recallText, "I prefer durable plain words", "From now on use short paragraphs"]) {
			const request = requests.find((request) => request.messages.some((message) => textOf(message) === input));
			assert.ok(request);
			const index = request.messages.findIndex((message) => textOf(message) === input);
			assert.match(textOf(request.messages[index + 1]), /Memory notice\./);
		}
		const entries = manager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "memory_notice");
		assert.equal(entries.length, 3);
		assert.doesNotMatch(JSON.stringify(entries), /durable plain words|short paragraphs/);
		const beforeHandled = requests.length;
		await session.prompt("I prefer scoped evidence");
		assert.equal(requests.length, beforeHandled);
		await session.prompt("/fixture-reuse");
		assert.ok(requests.at(-1)?.messages.some((message) => textOf(message) === "I prefer scoped evidence"));
		await session.prompt("I prefer transformed evidence");
		assert.ok(requests.at(-1)?.messages.some((message) => textOf(message) === "Transformed fixture input"));
		await session.prompt("/fixture-transformed");
		assert.ok(requests.at(-1)?.messages.some((message) => textOf(message) === "I prefer transformed evidence"));
		await session.prompt("/unknown-template I prefer expanded text");
		assert.equal(
			manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "memory_notice").length,
			3,
		);
		writeRecall(corpus, "Changed source permits another recall.");
		await session.sendCustomMessage(
			{ customType: "fixture-task", content: `${recallText}. I prefer carried text`, display: false },
			{ triggerTurn: true },
		);
		const customNotices = noticeTexts(requests.at(-1) as TranscriptContext);
		assert.match(customNotices.at(-1) as string, /Source class: custom task/);
		assert.doesNotMatch(customNotices.at(-1) as string, /Memory check: this message uses preference/);
		process.env.PI_MEMORY_PROACTIVE = "false";
		delete process.env.PI_MEMORY_DIR;
		await session.prompt("I prefer no notices here");
		assert.equal(noticeTexts(requests.at(-1) as TranscriptContext).length, 0);
		assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Memory is unavailable/);
		assert.deepEqual(errors, []);
	} finally {
		await session?.dispose();
		if (oldDir === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = oldDir;
		if (oldSwitch === undefined) delete process.env.PI_MEMORY_PROACTIVE;
		else process.env.PI_MEMORY_PROACTIVE = oldSwitch;
		rmSync(root, { recursive: true, force: true });
	}
});
