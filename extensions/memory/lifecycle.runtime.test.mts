import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type Invoke = (name: string, args: JsonObject) => Promise<ToolResultMessage>;

async function readPages(invoke: Invoke, slug: string, digest: string, revision?: string): Promise<string> {
	let offset = 0;
	let collected = "";
	for (let pageNumber = 1; pageNumber <= 8; pageNumber++) {
		const page = details(await invoke("memory_read", { slug, digest, offset, ...(revision ? { revision } : {}) }));
		assert.equal(page.offset, offset);
		assert.equal(page.digest, digest);
		assert.deepEqual(page.lifecycle, { status: "active", supersededBy: null });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= 48 * 1024);
		assert.equal(typeof page.content, "string");
		if (revision) {
			assert.equal(page.source, "history");
			assert.equal(page.revision, revision);
			assert.match(page.authority as string, /Historical evidence only, not current authority/);
		}
		collected += page.content;
		if (pageNumber === 1) assert.equal(page.contentCodePoints, 12000);
		if (!page.hasMore) {
			assert.ok(pageNumber > 1);
			return collected;
		}
		assert.equal(typeof page.nextOffset, "number");
		assert.ok((page.nextOffset as number) > offset);
		offset = page.nextOffset as number;
	}
	throw new Error("Source continuation exceeded fixture bound");
}

async function listCaptures(invoke: Invoke, slug: string): Promise<string[]> {
	const captures: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 4; guard++) {
		const page = details(await invoke("memory_history", { slug, limit: 1, ...(cursor ? { cursor } : {}) }));
		captures.push(...(page.revisions as JsonObject[]).map((item) => item.revision as string));
		if (!page.nextCursor) return captures;
		cursor = page.nextCursor as string;
	}
	throw new Error("History continuation exceeded fixture bound");
}

test("loaded tools preserve a technical note through authoring, retrieval, correction and supersession", {
	timeout: 40000,
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
			tools: ["memory_search", "memory_read", "memory_history", "memory_write", "memory_edit"],
		}));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		const model = modelRuntime.getModel("memory-lifecycle-fixture", "controlled");
		assert.ok(model);
		await session.setModel(model);
		assert.deepEqual(session.getActiveToolNames().sort(), [
			"memory_edit",
			"memory_history",
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
		const collected = await readPages(invoke, input.slug, firstDigest);
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
		let currentDigest = digest(edited.digest);
		let current = readFileSync(path, "utf8");
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

		const history = details(await invoke("memory_history", { slug: input.slug, limit: 1 }));
		assert.ok(Array.isArray(history.revisions));
		const prior = history.revisions[0] as JsonObject;
		assert.equal(prior.digest, firstDigest);
		assert.equal(typeof prior.revision, "string");
		const historical = await readPages(invoke, input.slug, firstDigest, prior.revision as string);
		assert.equal(historical, collected);
		assert.equal(readFileSync(path, "utf8"), current);
		assert.equal(
			(await invoke("memory_edit", { slug: input.slug, expectedDigest: currentDigest, edits: edit.edits })).isError,
			true,
		);
		const currentRead = details(await invoke("memory_read", { slug: input.slug }));
		const corrected = details(
			await invoke("memory_edit", {
				slug: input.slug,
				expectedDigest: currentRead.digest,
				verified: false,
				edits: [{ oldText: "api_key=process.env.API_KEY", newText: "api_key=api_key" }],
			}),
		);
		currentDigest = digest(corrected.digest);
		current = readFileSync(path, "utf8");
		assert.equal(parseFrontmatter(current).body, parseFrontmatter(historical).body);
		assert.equal(parseFrontmatter(current).frontmatter.verified_date, null);
		assert.equal(parseFrontmatter(current).frontmatter.status, "active");
		const captures = await listCaptures(invoke, input.slug);
		assert.equal(captures.length, 2);
		assert.equal(new Set(captures).size, 2);

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
		const archivedActive = details(
			await invoke("memory_read", { slug: input.slug, revision: prior.revision, digest: firstDigest }),
		);
		assert.deepEqual(archivedActive.lifecycle, { status: "active", supersededBy: null });
		assert.equal((await invoke("memory_edit", { ...edit, expectedDigest: oldPage.digest })).isError, true);
		await invoke("memory_search", {});
		const section = sections.at(-1);
		assert.match(section ?? "", /configuration-choice: Configuration choice/);
		assert.doesNotMatch(section ?? "", /configuration-notes:/);

		for (let index = 0; index < 4096; index++)
			writeFileSync(join(corpus, `filler-${String(index).padStart(4, "0")}.md`), "# Ordinary subject\n");
		for (const suffix of ["a", "b", "c"])
			writeFileSync(join(corpus, `zz-${suffix}.md`), "# Late subject\nlatewindowtoken\n");
		const query = "latewindowtoken";
		const empty = details(await invoke("memory_search", { query, limit: 1 }));
		assert.deepEqual(empty.notes, []);
		assert.equal((empty.scan as JsonObject).windowEnd, 4096);
		assert.equal(typeof empty.nextCursor, "string");
		const next = details(await invoke("memory_search", { query, limit: 1, cursor: empty.nextCursor }));
		assert.equal((next.notes as JsonObject[]).length, 1);
		assert.equal((next.coverage as JsonObject).frozenSnapshot, false);
		const slugs = (next.notes as JsonObject[]).map((note) => note.slug);
		let cursor = next.nextCursor;
		for (let guard = 0; cursor && guard < 5; guard++) {
			const page = details(await invoke("memory_search", { query, limit: 1, cursor }));
			slugs.push(...(page.notes as JsonObject[]).map((note) => note.slug));
			cursor = page.nextCursor;
		}
		assert.deepEqual(slugs, ["zz-a", "zz-b", "zz-c"]);
		assert.equal((await invoke("memory_search", { query: "changedquery", cursor: next.nextCursor })).isError, true);
		writeFileSync(join(corpus, "zz-b.md"), "# Changed source\nlatewindowtoken\n");
		assert.match(text(await invoke("memory_search", { query, cursor: next.nextCursor })), /Source window changed/);
		writeFileSync(join(corpus, "zz-d.md"), "# Inventory change\n");
		assert.match(text(await invoke("memory_search", { query, cursor: empty.nextCursor })), /inventory changed/);
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
