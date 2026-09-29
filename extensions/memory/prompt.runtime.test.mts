import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

function compactNotes(corpus: string, count: number, source: (title: string) => string): void {
	for (let i = 0; i < count; i++)
		writeFileSync(join(corpus, `subject-${String(i).padStart(3, "0")}.md`), source("界😀".repeat(80)));
}

for (const form of ["titles", "slugs", "partial"] as const) {
	test(`native ${form} reach a controlled provider, avoid unchanged deltas, and remove unavailable memory`, {
		timeout: 20000,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "memory-prompt-runtime-"));
		const corpus = join(root, "corpus");
		const agentDir = join(root, "agent");
		mkdirSync(corpus);
		mkdirSync(agentDir);
		writeFileSync(join(corpus, "README.md"), "PRIVATE CONTRACT");
		const source = (title: string, body = "PRIVATE BODY") =>
			`---\nstatus: active\nsuperseded_by: null\ntitle: ${title}\n---\n${body}\n`;
		writeFileSync(join(corpus, "editor-choice.md"), source("Editor choice"));
		if (form !== "titles") compactNotes(corpus, form === "partial" ? 2200 : 274, source);
		mkdirSync(join(corpus, ".memory-history"));
		writeFileSync(join(corpus, ".memory-history", "hidden.md"), "PRIVATE HISTORY BODY");
		const previousRoot = process.env.PI_MEMORY_DIR;
		process.env.PI_MEMORY_DIR = corpus;
		const requests: TranscriptContext[] = [];
		const errors: string[] = [];
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "memory-fixture",
			defaultModel: "controlled",
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(agentDir, "models-cache.json"),
				refreshOnCreate: false,
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: root,
				agentDir,
				settingsManager,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
				extensionFactories: [
					(pi) => {
						pi.registerProvider("memory-fixture", {
							baseUrl: "https://memory.invalid",
							api: "memory-fixture",
							apiKey: "synthetic-fixture-not-a-credential",
							models: [
								{
									id: "controlled",
									name: "Controlled fixture",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 1024,
								},
							],
							streamSimple(model, context) {
								requests.push(structuredClone(context));
								const message: AssistantMessage = {
									role: "assistant",
									api: model.api,
									provider: model.provider,
									model: model.id,
									timestamp: Date.now(),
									content: [{ type: "text", text: "Controlled reply." }],
									stopReason: "stop",
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
								stream.push({ type: "done", reason: "stop", message });
								stream.end();
								return stream;
							},
						});
					},
				],
			});
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			const manager = SessionManager.inMemory(root);
			({ session } = await createAgentSession({
				cwd: root,
				agentDir,
				modelRuntime,
				settingsManager,
				resourceLoader,
				sessionManager: manager,
				tools: [],
			}));
			await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
			const model = modelRuntime.getModel("memory-fixture", "controlled");
			assert.ok(model);
			await session.setModel(model);
			const patches = () =>
				manager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" &&
						entry.message.role === "system" &&
						entry.message.sections &&
						Object.hasOwn(entry.message.sections, "memory_index")
							? [entry.message.sections.memory_index]
							: [],
					);
			const promptSection = () =>
				getCurrentSystemMessage(requests[requests.length - 1].messages)?.sections?.memory_index;
			await session.prompt("First request");
			const first = promptSection();
			assert.equal(typeof first, "string");
			assert.match(first as string, form === "titles" ? /editor-choice: Editor choice/ : /^editor-choice$/m);
			assert.match(first as string, /^<memory_index>\n[\s\S]*\n<\/memory_index>$/);
			assert.ok(Buffer.byteLength(first as string) <= 12 * 1024);
			if (form === "partial") {
				assert.match(first as string, /Metadata inspected: 2048 of 2201 candidate notes; uninspected: 153/);
				assert.match(first as string, /Cross-note lifecycle validity is not established/);
				assert.match(first as string, /Uninspected lifecycle is unknown/);
				assert.ok((first as string).split("\n").filter((line) => /^subject-\d+$/.test(line)).length > 512);
			}
			if (form === "slugs") {
				assert.match(first as string, /Observed memory subjects with active per-file status \(slugs only\)/);
				assert.equal(
					(first as string).split("\n").filter((line) => /^(editor-choice|subject-\d{3})$/.test(line)).length,
					275,
				);
				assert.doesNotMatch(first as string, /Omitted observed active cues/);
			}
			assert.doesNotMatch(first as string, /PRIVATE BODY|PRIVATE CONTRACT|PRIVATE HISTORY BODY/);
			const system = getCurrentSystemMessage(requests[0].messages);
			assert.ok(system);
			assert.match(
				getSystemMessageText(system),
				form === "titles"
					? /<memory_index>[\s\S]*editor-choice: Editor choice/
					: /<memory_index>[\s\S]*\neditor-choice\n/,
			);
			assert.deepEqual(patches(), [first]);

			await session.prompt("Unchanged request");
			assert.equal(promptSection(), first);
			assert.deepEqual(patches(), [first]);
			writeFileSync(join(corpus, "editor-choice.md"), source("Editor choice", "DIFFERENT PRIVATE BODY"));
			await session.prompt("Body-only change");
			assert.deepEqual(patches(), [first]);

			writeFileSync(join(corpus, "editor-choice.md"), source("Editor replacement"));
			await session.prompt("Changed title");
			if (form !== "titles") {
				assert.equal(promptSection(), first);
				assert.deepEqual(patches(), [first]);
				renameSync(join(corpus, "editor-choice.md"), join(corpus, "editor-replacement.md"));
				await session.prompt("Changed subject");
			}
			const changed = promptSection();
			assert.match(
				changed as string,
				form === "titles" ? /editor-choice: Editor replacement/ : /^editor-replacement$/m,
			);
			assert.deepEqual(patches(), [first, changed]);

			delete process.env.PI_MEMORY_DIR;
			await session.prompt("Unavailable memory");
			assert.equal(promptSection(), undefined);
			assert.deepEqual(patches(), [first, changed, null]);
			await session.prompt("Still unavailable");
			assert.deepEqual(patches(), [first, changed, null]);
			process.env.PI_MEMORY_DIR = corpus;
			await session.prompt("Restored memory");
			assert.equal(promptSection(), changed);
			assert.deepEqual(patches(), [first, changed, null, changed]);
			rmSync(join(corpus, "README.md"));
			await session.prompt("Missing contract");
			assert.equal(promptSection(), undefined);
			assert.deepEqual(patches(), [first, changed, null, changed, null]);
			assert.equal(requests.length, form === "titles" ? 8 : 9);
			assert.deepEqual(errors, []);
		} finally {
			if (session) {
				await session.abort();
				session.dispose();
			}
			if (previousRoot === undefined) delete process.env.PI_MEMORY_DIR;
			else process.env.PI_MEMORY_DIR = previousRoot;
			rmSync(root, { recursive: true, force: true });
		}
	});
}
