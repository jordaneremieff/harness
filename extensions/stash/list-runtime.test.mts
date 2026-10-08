import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import registerStash from "./index.ts";
import { ListOutputSchema } from "./list-result.ts";

test("native codemode consumes recent, search, empty and error objects without parsing prose", {
	timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "stash-list-runtime-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = join(root, "stashes");
	await mkdir(store);
	const sources = [
		["one", '---\ntitle: "Open title"\nstate: "open"\n---\nneedle\n'],
		["two", '---\ntitle: "Closed title"\nstate: "closed"\n---\nneedle\n'],
		["three", '---\ntitle: "Unknown title"\nstate: "mystery"\n---\nneedle\n'],
		["four", '---\nstate: "open"\n'],
	] as const;
	for (const [id, text] of sources) await writeFile(join(store, `${id}.md`), text, { mode: 0o600 });
	const saved = ["PI_STASH_DIR", "PI_STASH_CAPACITY", "PI_CODING_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]] as const);
	t.after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_HARNESS_FILE = join(root, "agent", "harness.json");
	process.env.PI_STASH_DIR = store;
	process.env.PI_STASH_CAPACITY = "0";
	const faux = fauxProvider({
		provider: "stash-list-fixture",
		models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 512 }],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const observed: unknown[] = [];
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Synthetic structured result test.",
		extensionFactories: [
			registerStash,
			createCodemodeExtension(),
			(pi) => {
				pi.on("tool_result", (event) => {
					if (event.toolName !== "stash_list") return;
					assert.ok(Value.Check(ListOutputSchema, event.structuredContent));
					observed.push(event.structuredContent);
				});
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(root),
		tools: ["stash_list", "codemode"],
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "print" });
	const code = `
		const page = await tools.stash_list({ state: "open" });
		const all = await tools.stash_list({});
		const empty = await tools.stash_list({ tag: "absent" });
		const emptySearch = await tools.stash_list({ query: "absent" });
		const error = await tools.stash_list({ cursor: "bad" });
		const search = await tools.stash_list({ query: "needle", limit: 1 });
		const next = await tools.stash_list({ query: "needle", cursor: search.nextCursor });
		console.log({ records: page.records.map(({ id, title, state }) => ({ id, title, state })),
			unknown: all.records.filter(r => r.state === "unknown").map(r => r.id),
			empty: empty.records.length, emptySearch: emptySearch.matches.length, error: error.kind, continuation: !!search.nextCursor,
			skips: next.coverage.skippedTotal, complete: next.coverage.complete });
	`;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: "composition" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	await session.prompt("Run the synthetic composition.", { expandPromptTemplates: false });
	const result = session.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "composition",
	);
	assert.ok(result && result.role === "toolResult");
	assert.equal(result.isError, false);
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	assert.match(text, /Open title/);
	assert.match(text, /"error":\s*"error"/);
	assert.match(text, /"empty":\s*0/);
	assert.match(text, /"continuation":\s*true/);
	assert.match(text, /"complete":\s*false/);
	assert.equal(observed.length, 7);
	assert.deepEqual(observed[0], {
		kind: "recent",
		records: [{ id: "one", title: "Open title", state: "open" }],
		limit: 10,
		selectedCount: 1,
		omittedRecords: 0,
		textTruncated: false,
		limitReached: false,
		nextCursor: null,
		coverage: { complete: null },
	});
	assert.ok(observed[1] && typeof observed[1] === "object" && "records" in observed[1]);
	assert.deepEqual(observed[1].records, [
		{ id: "two", title: "Closed title", state: "closed" },
		{ id: "three", title: "Unknown title", state: "unknown" },
		{ id: "one", title: "Open title", state: "open" },
		{ id: "four", title: "four", state: "unknown" },
	]);
	for (const [id, original] of sources) assert.equal(await readFile(join(store, `${id}.md`), "utf8"), original);
});
