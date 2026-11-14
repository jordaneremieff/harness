import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("ordinary Pi session loads history and executes source-filtered retrieval against mixed raw entries", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "history-runtime-"));
	try {
		const faux = fauxProvider({ tokensPerSecond: Infinity });
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const eventBus = createEventBus();
		const contributions: unknown[] = [];
		eventBus.on("durable:contribution", (data) => contributions.push(data));
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
			eventBus,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		assert.equal(resourceLoader.getExtensions().extensions.length, 1);
		assert.equal(contributions.length, 1);
		const contribution = contributions[0] as { name?: string; source?: string };
		assert.equal(contribution.name, "history");
		assert.equal(contribution.source, fileURLToPath(new URL("./index.ts", import.meta.url)));
		const sm = SessionManager.inMemory(root);
		const target = sm.appendMessage({ role: "user", content: "release approved", timestamp: 1 });
		const compact = sm.appendCompaction("release summary", target, 100);
		const branch = sm.branchWithSummary(compact, "release branch");
		sm.appendCustomMessageEntry("synthetic-note", "release echo", true);
		sm.appendMessage(fauxAssistantMessage("release assistant echo"));
		const tool = sm.appendMessage({
			role: "toolResult",
			toolCallId: "prior",
			toolName: "probe",
			isError: true,
			content: [{ type: "text", text: `release output echo ${"x".repeat(10000)}` }],
			timestamp: 1,
		});
		const fromId = sm.getLeafId();
		assert.ok(fromId);
		const common = { fromId, sessionId: sm.getSessionId(), query: "release", maxScanBytes: 2048 };
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("history_search", common, { id: "baseline" }),
				fauxToolCall("history_search", { ...common, filter: { source: "user" } }, { id: "filtered" }),
				fauxToolCall(
					"history_search",
					{ fromId, filter: { source: "toolResult", toolName: "probe", errorsOnly: true } },
					{ id: "errors" },
				),
				fauxToolCall("history_search", { fromId, filter: { source: "summary" } }, { id: "summaries" }),
				fauxToolCall("history_search", { filter: { source: "user", errorsOnly: true } }, { id: "invalid" }),
			]),
			fauxAssistantMessage("Fixture complete."),
		]);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "off",
			sessionManager: sm,
			settingsManager,
			resourceLoader,
		});
		try {
			const errors: string[] = [];
			await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
			assert.ok(session.getActiveToolNames().includes("history_search"));
			assert.ok(session.getActiveToolNames().includes("history_read"));
			await session.prompt("Inspect the synthetic fixture.");
			assert.deepEqual(errors, []);
			const results = sm
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
			const result = (id: string) => {
				const message = results.find((message) => message.toolCallId === id);
				assert.ok(message, id);
				assert.equal(message.isError, false, JSON.stringify(message.content));
				const text = message.content[0];
				assert.equal(text.type, "text");
				if (text.type !== "text") throw new Error("Expected text result");
				return JSON.parse(text.text);
			};
			const baseline = result("baseline");
			const filtered = result("filtered");
			assert.equal(baseline.status, "scan_limit");
			assert.equal(baseline.scannedBytes, 2048);
			assert.deepEqual(
				baseline.matches.map((hit: { entry: { id: string } }) => hit.entry.id),
				[tool],
			);
			assert.equal(filtered.status, "ancestry_exhausted");
			assert.equal(filtered.scannedBytes, Buffer.byteLength("release approved"));
			assert.deepEqual(
				filtered.matches.map((hit: { entry: { id: string } }) => hit.entry.id),
				[target],
			);
			assert.equal(filtered.excluded, 5);
			assert.deepEqual(
				result("errors").matches.map((hit: { entry: { id: string } }) => hit.entry.id),
				[tool],
			);
			assert.deepEqual(
				result("summaries").matches.map((hit: { entry: { id: string } }) => hit.entry.id),
				[branch, compact],
			);
			assert.equal(results.find((message) => message.toolCallId === "invalid")?.isError, true);
			assert.equal(faux.state.callCount, 2);
			t.diagnostic(
				JSON.stringify({
					baseline: {
						status: baseline.status,
						visited: baseline.visited,
						scannedBytes: baseline.scannedBytes,
						matchedRole: baseline.matches[0].entry.role,
					},
					filtered: {
						status: filtered.status,
						visited: filtered.visited,
						excluded: filtered.excluded,
						scannedBytes: filtered.scannedBytes,
						matchedRole: filtered.matches[0].entry.role,
						excerpt: filtered.matches[0].excerpt,
					},
				}),
			);
		} finally {
			session.dispose();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ordinary Pi session finds an earlier edit through its arguments and reads the exact pointer", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "history-arguments-"));
	try {
		const faux = fauxProvider({ tokensPerSecond: Infinity });
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
			eventBus: createEventBus(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		});
		await resourceLoader.reload();
		await writeFile(join(root, "notes.txt"), "status: draft\n");
		const sm = SessionManager.inMemory(root);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "off",
			sessionManager: sm,
			settingsManager,
			resourceLoader,
		});
		try {
			const errors: string[] = [];
			await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
			assert.ok(session.getActiveToolNames().includes("edit"));
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"edit",
						{ path: "notes.txt", edits: [{ oldText: "draft", newText: "argument-only-token" }] },
						{ id: "edit-call" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Edited."),
			]);
			await session.prompt("Change the note status.");
			assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "status: argument-only-token\n");
			const beforeSearch = sm.getLeafId();
			assert.ok(beforeSearch);

			const resultOf = (messages: readonly { role: string }[], id: string) => {
				const message = messages.find(
					(item) => item.role === "toolResult" && (item as { toolCallId?: string }).toolCallId === id,
				) as { isError: boolean; content: { type: string; text?: string }[] } | undefined;
				assert.ok(message, id);
				assert.equal(message.isError, false, JSON.stringify(message.content));
				return JSON.parse(message.content[0].text ?? "");
			};
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("history_search", { query: "argument-only-token", mode: "arguments" }, { id: "args" }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					const found = resultOf(context.messages, "args");
					return fauxAssistantMessage(
						fauxToolCall(
							"history_read",
							{ entryId: found.matches[0].entry.id, pointer: found.matches[0].pointer },
							{ id: "read" },
						),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage(
					fauxToolCall("history_search", { query: "argument-only-token", fromId: beforeSearch }, { id: "text" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Found the edit."),
			]);
			await session.prompt("Find the earlier change to the note.");
			assert.deepEqual(errors, []);

			const messages = sm
				.getEntries()
				.flatMap((entry) => (entry.type === "message" ? [entry.message as { role: string }] : []));
			const found = resultOf(messages, "args");
			assert.equal(found.status, "ancestry_exhausted");
			assert.equal(found.matches.length, 1, "the calling search call is left out");
			assert.equal(found.matches[0].entry.role, "assistant");
			assert.deepEqual(found.matches[0].call, { name: "edit", id: "edit-call" });
			assert.equal(found.matches[0].pointer, "/message/content/0/arguments/edits/0/newText");
			const read = resultOf(messages, "read");
			assert.equal(read.status, "complete");
			assert.equal(read.text, "argument-only-token");
			const text = resultOf(messages, "text");
			assert.equal(text.status, "ancestry_exhausted");
			assert.equal(text.matches.length, 0);
			assert.equal(faux.state.callCount, 6);
			t.diagnostic(
				JSON.stringify({
					arguments: { status: found.status, visited: found.visited, pointer: found.matches[0].pointer },
					read: { status: read.status, text: read.text },
					text: { status: text.status, matches: text.matches.length },
				}),
			);
		} finally {
			session.dispose();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
