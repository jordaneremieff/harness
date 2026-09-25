/** Execute the registered tools through an isolated ordinary Pi session and a controlled provider. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	type ToolResultMessage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SearchPage } from "./search.ts";
import { makeEntry } from "./store.ts";

test("native clipboard_list discovery flows through get and restore without the system clipboard", {
	timeout: 60000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "clipboard-native-test-"));
	const archive = join(root, "archive");
	const agentDir = join(root, "agent");
	const bin = join(root, "bin");
	const clipboard = join(root, "synthetic-clipboard.txt");
	const previous = {
		path: process.env.PATH,
		archive: process.env.PI_CLIPBOARD_DIR,
		clipboard: process.env.CLIPBOARD_TEST_DESTINATION,
	};
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await Promise.all([mkdir(archive), mkdir(agentDir), mkdir(bin)]);
		const body = `${"context ".repeat(5000)}rollback instructions: restore the saved revision`;
		await writeFile(
			join(archive, "2026-01-02.jsonl"),
			JSON.stringify(makeEntry(body, "release draft", new Date("2026-01-03T00:00:00Z"), "rollback-draft")),
		);
		await writeFile(
			join(archive, "2026-09-01.jsonl"),
			Array.from({ length: 1100 }, (_, i) =>
				JSON.stringify(makeEntry(`recent ${i}`, undefined, new Date("2026-09-01T12:00:00Z"), `recent-${i}`)),
			).join("\n"),
		);
		await writeFile(
			join(bin, "pbcopy"),
			`#!${process.execPath}\nconst fs = require("node:fs"); fs.writeFileSync(process.env.CLIPBOARD_TEST_DESTINATION, fs.readFileSync(0));\n`,
		);
		await writeFile(join(bin, "pbpaste"), `#!${process.execPath}\nprocess.exit(99);\n`);
		await Promise.all([chmod(join(bin, "pbcopy"), 0o700), chmod(join(bin, "pbpaste"), 0o700)]);
		process.env.PATH = bin;
		process.env.PI_CLIPBOARD_DIR = archive;
		process.env.CLIPBOARD_TEST_DESTINATION = clipboard;
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "catalog.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		let calls = 0;
		let searchCalls = 0;
		interface Request {
			name: string;
			args: Record<string, string | number>;
		}
		const list = (args: Request["args"]): Request => ({ name: "clipboard_list", args });
		function* workflow(): Generator<Request, void, ToolResultMessage> {
			const recent = yield list({ limit: 50 });
			assert.equal(recent.isError, false);
			assert.ok(!JSON.stringify(recent.content).includes("rollback-draft"));
			let cursor: string | null = null;
			let selected: SearchPage["matches"][number] | undefined;
			while (!selected) {
				assert.ok(++searchCalls < 10);
				const found: ToolResultMessage = yield list({ query: "rollback instructions", ...(cursor ? { cursor } : {}) });
				assert.equal(found.isError, false);
				const text = found.content.find((block) => block.type === "text");
				assert.ok(text && text.type === "text");
				const page = JSON.parse(text.text) as SearchPage;
				selected = page.matches[0];
				cursor = page.nextCursor;
				assert.ok(selected || cursor, "empty bounded search pages must expose continuation");
			}
			assert.equal(selected.id, "rollback-draft");
			assert.equal(selected.date, "2026-01-02");
			assert.match(selected.match.excerpt, /rollback instructions/);
			const get = yield { name: "clipboard_get", args: { id: selected.id, date: selected.date, max_chars: 100 } };
			assert.equal(get.isError, false);
			assert.ok(JSON.stringify(get.content).includes('date \\"2026-01-02\\"'));
			const tail = yield {
				name: "clipboard_get",
				args: { id: selected.id, date: selected.date, offset: selected.match.offset },
			};
			assert.equal(tail.isError, false);
			assert.match(JSON.stringify(tail.content), /rollback instructions/);
			const restored = yield { name: "clipboard_restore", args: { id: selected.id, date: selected.date } };
			assert.equal(restored.isError, false);
			const badCursor = yield list({ query: "rollback instructions", cursor: "invalid" });
			assert.equal(badCursor.isError, true);
			const badQuery = yield list({ query: "" });
			assert.equal(badQuery.isError, true);
		}
		const scenario = workflow();
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
			extensionFactories: [
				(pi) => {
					pi.registerProvider("clipboard-test", {
						baseUrl: "https://clipboard.invalid",
						api: "clipboard-test",
						apiKey: "synthetic-no-network",
						models: [
							{
								id: "fixture",
								name: "Fixture",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 4096,
							},
						],
						streamSimple(model, context) {
							const last = context.messages.filter((message) => message.role === "toolResult").at(-1);
							const next = last ? scenario.next(last) : scenario.next();
							const done = next.done === true;
							const message: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								timestamp: Date.now(),
								stopReason: done ? "stop" : "toolUse",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								content: next.done
									? [{ type: "text", text: "Recovered the rollback draft." }]
									: [{ type: "toolCall", id: `call-${++calls}`, name: next.value.name, arguments: next.value.args }],
							};
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: done ? "stop" : "toolUse", message });
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
			settingsManager: settings,
			modelRuntime: runtime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			tools: ["clipboard_list", "clipboard_get", "clipboard_restore"],
			thinkingLevel: "off",
		}));
		const model = runtime.getModel("clipboard-test", "fixture");
		assert.ok(model);
		await session.setModel(model);
		await session.prompt("Recover the rollback instructions I copied; I remember the phrase but not the date.");
		assert.equal(
			session.getLastAssistantText(),
			"Recovered the rollback draft.",
			JSON.stringify(
				session.messages
					.filter((message) => message.role === "assistant")
					.map((message) => ({ stopReason: message.stopReason, error: message.errorMessage })),
			),
		);
		assert.ok(searchCalls > 1);
		assert.equal(await readFile(clipboard, "utf8"), body);
		const results = session.messages.filter((message) => message.role === "toolResult");
		assert.ok(results.some((message) => message.toolName === "clipboard_restore" && !message.isError));
		for (const result of results) {
			assert.ok(Buffer.byteLength(JSON.stringify(result.content)) < 50 * 1024);
			assert.ok(
				result.content.flatMap((block) => (block.type === "text" ? block.text.split("\n") : [])).length <= 2000,
			);
		}
	} finally {
		session?.dispose();
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		if (previous.archive === undefined) delete process.env.PI_CLIPBOARD_DIR;
		else process.env.PI_CLIPBOARD_DIR = previous.archive;
		if (previous.clipboard === undefined) delete process.env.CLIPBOARD_TEST_DESTINATION;
		else process.env.CLIPBOARD_TEST_DESTINATION = previous.clipboard;
		await rm(root, { recursive: true, force: true });
	}
});
