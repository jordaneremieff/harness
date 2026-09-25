import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
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
