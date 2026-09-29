import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	type JsonObject,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	parseFrontmatter,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

function text(result: ToolResultMessage): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
function details(result: ToolResultMessage): JsonObject {
	assert.equal(result.isError, false, text(result));
	assert.ok(result.details && typeof result.details === "object" && !Array.isArray(result.details));
	return result.details as JsonObject;
}
function digest(value: unknown): string {
	assert.equal(typeof value, "string");
	assert.match(value as string, /^[a-f0-9]{64}$/);
	return value as string;
}

test("loaded tools preserve a technical note through authoring, retrieval, correction and supersession", {
	timeout: 20000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "memory-lifecycle-runtime-"));
	const corpus = join(root, "corpus");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const previousRoot = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = corpus;
	const errors: string[] = [];
	const sections: Array<string | undefined> = [];
	let pending: ToolCall | undefined;
	let sequence = 0;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "memory-lifecycle-fixture",
			defaultModel: "controlled",
			compaction: { enabled: false },
			retry: { enabled: false },
		});
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
					pi.registerProvider("memory-lifecycle-fixture", {
						baseUrl: "https://memory.invalid",
						api: "memory-lifecycle-fixture",
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
							sections.push(getCurrentSystemMessage(context.messages)?.sections?.memory_index ?? undefined);
							const call = pending;
							pending = undefined;
							const reason = call ? "toolUse" : "stop";
							const message: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								timestamp: Date.now(),
								content: call ? [call] : [{ type: "text", text: "Controlled reply." }],
								stopReason: reason,
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
							stream.push({ type: "done", reason, message });
							stream.end();
							return stream;
						},
					});
				},
			],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(root),
			tools: ["memory_search", "memory_read", "memory_write", "memory_edit"],
		}));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		const model = modelRuntime.getModel("memory-lifecycle-fixture", "controlled");
		assert.ok(model);
		await session.setModel(model);
		assert.deepEqual(session.getActiveToolNames().sort(), [
			"memory_edit",
			"memory_read",
			"memory_search",
			"memory_write",
		]);
		const active = session;
		const invoke = async (name: string, args: JsonObject): Promise<ToolResultMessage> => {
			const id = `memory-call-${++sequence}`;
			pending = { type: "toolCall", id, name, arguments: args };
			await active.prompt(`Execute controlled call ${sequence}`);
			const result = active.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
			assert.ok(result?.role === "toolResult", `Missing native result for ${name}`);
			return result;
		};

		const unavailable = await invoke("memory_search", {});
		assert.equal(unavailable.isError, true);
		assert.equal(existsSync(corpus), false);
		const input = {
			slug: "configuration-notes",
			title: "Configuration notes",
			tags: ["configuration"],
			summary: "Use environment references in technical examples.",
			details: `Introductory qualification.\n\n\`api_key=api_key\`\n\n\`\`\`js\npassword=process.env.PASSWORD\n# Fenced example\n\`\`\`\n\n${"Unicode 😀 context. ".repeat(900)}\nTAIL qualification.`,
			sources: "Synthetic operator statement, 2026-01-01.",
			verified: true,
		};
		const created = details(await invoke("memory_write", input));
		assert.equal(created.initialized, true);
		const firstDigest = digest(created.digest);
		assert.equal(details(await invoke("memory_read", { slug: "README" })).source, "contract");
		const found = details(
			await invoke("memory_search", { query: ["api_key configuration", "environment references"] }),
		);
		assert.ok(Array.isArray(found.notes));
		const hit = found.notes[0] as JsonObject;
		assert.equal(hit.slug, input.slug);
		assert.equal(hit.digest, firstDigest);
		let offset = 0;
		let collected = "";
		let pages = 0;
		for (;;) {
			assert.ok(++pages <= 8);
			const page = details(await invoke("memory_read", { slug: input.slug, digest: firstDigest, offset }));
			assert.equal(page.offset, offset);
			assert.equal(page.digest, firstDigest);
			assert.deepEqual(page.lifecycle, { status: "active", supersededBy: null });
			assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 48 * 1024);
			assert.equal(typeof page.content, "string");
			collected += page.content;
			if (pages === 1) assert.equal(page.contentCodePoints, 12000);
			if (!page.hasMore) break;
			assert.equal(typeof page.nextOffset, "number");
			assert.ok((page.nextOffset as number) > offset);
			offset = page.nextOffset as number;
		}
		assert.ok(pages > 1);
		const path = join(corpus, `${input.slug}.md`);
		assert.equal(collected, readFileSync(path, "utf8"));
		assert.ok(collected.includes(input.details));
		const edit = {
			slug: input.slug,
			expectedDigest: firstDigest,
			verified: false,
			edits: [{ oldText: "api_key=api_key", newText: "api_key=process.env.API_KEY" }],
		};
		const edited = details(await invoke("memory_edit", edit));
		const currentDigest = digest(edited.digest);
		const current = readFileSync(path, "utf8");
		assert.ok(current.includes("`api_key=process.env.API_KEY`"));
		assert.ok(current.includes("TAIL qualification."));
		assert.equal(parseFrontmatter(current).frontmatter.verified_date, null);
		const stale = await invoke("memory_edit", edit);
		assert.equal(stale.isError, true);
		assert.match(text(stale), /Memory write incomplete: .*digest changed/);
		const receipt = JSON.parse(text(stale).slice("Memory write incomplete: ".length));
		assert.deepEqual(receipt.written, []);
		assert.equal(readFileSync(path, "utf8"), current);
		const staleRead = await invoke("memory_read", { slug: input.slug, digest: firstDigest, offset: 4000 });
		assert.equal(staleRead.isError, true);
		assert.match(text(staleRead), /source changed.*restart memory_read at offset 0/);

		const token = `ghp_${"x".repeat(24)}`;
		const refused = await invoke("memory_write", { ...input, slug: "refused", details: `\`\`\`\n${token}\n\`\`\`` });
		assert.equal(refused.isError, true);
		assert.match(text(refused), /details \(recognized token prefix\)/);
		assert.ok(!text(refused).includes(token));
		assert.equal(existsSync(join(corpus, "refused.md")), false);
		const replacement = details(
			await invoke("memory_write", {
				...input,
				slug: "configuration-choice",
				title: "Configuration choice",
				supersedes: [{ slug: input.slug, digest: currentDigest }],
			}),
		);
		assert.deepEqual(replacement.written, ["configuration-choice.md", "configuration-notes.md"]);
		const old = parseFrontmatter(current);
		const retired = parseFrontmatter(readFileSync(path, "utf8"));
		assert.equal(retired.body, old.body);
		assert.equal(retired.frontmatter.status, "superseded");
		assert.equal(retired.frontmatter.superseded_by, "configuration-choice");
		const oldPage = details(await invoke("memory_read", { slug: input.slug }));
		assert.deepEqual(oldPage.lifecycle, { status: "superseded", supersededBy: "configuration-choice" });
		const oldContinuation = details(
			await invoke("memory_read", {
				slug: input.slug,
				digest: digest(oldPage.digest),
				offset: oldPage.nextOffset,
			}),
		);
		assert.deepEqual(oldContinuation.lifecycle, oldPage.lifecycle);
		await invoke("memory_search", {});
		const section = sections.at(-1);
		assert.match(section ?? "", /configuration-choice: Configuration choice/);
		assert.doesNotMatch(section ?? "", /configuration-notes:/);
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
