import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context as ProviderContext } from "@earendil-works/pi-ai";
import { ModelRuntime, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function directories() {
	const root = mkdtempSync(join(tmpdir(), "agent-setup-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	return { root, cwd, agentDir };
}

async function settled(worker: AgentWorkerSession): Promise<void> {
	await worker.waitForIdle();
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

test("setup preserves callback identities, branched ancestry, retained custom context, and reopen", async () => {
	const dirs = directories();
	const store = new AgentStore({ sessionsRoot: join(dirs.root, "sessions") });
	const runtime = await createTestRuntime();
	const model = { ...testModel, provider: "setup-contract", id: "setup-model" };
	const seen: ProviderContext[] = [];
	const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "DONE" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	const stream = (_model: unknown, context: ProviderContext) => {
		seen.push(context);
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: response });
		events.push({ type: "done", reason: "stop", message: response });
		events.end(response);
		return events;
	};
	runtime.registerNativeProvider({ id: model.provider, name: "Setup contract", getModels: () => [model], auth: { apiKey: { name: "Keyless test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	let saved: SessionEntry[] = [];
	let managerId = "";
	let compactId = "";
	let keptId = "";
	let sideId = "";
	let worker = await AgentWorkerSession.create({ ...dirs, extensionPaths: [join(import.meta.dirname, "testdata", "lifecycle-command", "index.ts")], store, modelRuntime: runtime, model: { provider: model.provider, modelId: model.id }, rootContext: BACKGROUND_CONTEXT,
		setup: async (manager) => {
			manager.newSession();
			managerId = manager.getSessionId();
			const root = manager.appendMessage({ role: "user", content: "DISCARDED_MARKER", timestamp: Date.now() });
			sideId = manager.appendCustomEntry("setup.side", { side: true });
			manager.branch(root);
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			keptId = manager.appendLabelChange(root, "root label");
			manager.appendCustomMessageEntry("setup.visible", "RETAINED_CUSTOM_MARKER", true, { source: "setup" });
			manager.appendMessage({ role: "user", content: "RETAINED_USER_MARKER", timestamp: Date.now() });
			compactId = manager.appendCompaction("SUMMARY_MARKER", keptId, 100, { source: "setup" }, true);
			manager.appendSessionInfo("setup name");
			manager.branch(compactId);
			saved = manager.getEntries();
		},
	});
	try {
		assert.equal(worker.sessionId(), managerId);
		const view = worker.sessionManager();
		for (const entry of saved) {
			assert.equal(view.getEntry(entry.id)?.parentId, entry.parentId);
			assert.equal(view.getEntry(entry.id)?.type, entry.type);
		}
		assert.ok(view.getEntry(sideId));
		assert.equal(view.getLeafEntry()?.parentId, compactId);
		assert.equal(view.getSessionName(), "setup name");
		const compaction = view.getEntry(compactId);
		assert.ok(compaction?.type === "compaction");
		assert.equal(compaction.firstKeptEntryId, keptId);
		assert.ok(view.buildContextEntries().some((entry) => entry.id === keptId));
		await worker.start("Inspect the retained context.");
		await settled(worker);
		assert.equal(worker.lastErrorMessage(), undefined);
		assert.equal(seen.length, 1);
		const input = seen[0].messages.map(textOf).join("\n");
		assert.match(input, /SUMMARY_MARKER/u);
		assert.match(input, /RETAINED_CUSTOM_MARKER/u);
		assert.match(input, /RETAINED_USER_MARKER/u);
		assert.doesNotMatch(input, /DISCARDED_MARKER/u);
		const metadata = (await store.list(BACKGROUND_CONTEXT))[0];
		await worker.close();
		worker = await AgentWorkerSession.open(metadata, { ...dirs, store, modelRuntime: runtime, rootContext: BACKGROUND_CONTEXT });
		assert.ok(worker.sessionManager().getEntry(sideId));
		for (const entry of saved) assert.equal(worker.sessionManager().getEntry(entry.id)?.parentId, entry.parentId);
		await worker.start("Inspect the retained context again.");
		await settled(worker);
		assert.equal(seen.length, 2);
		assert.match(seen[1].messages.map(textOf).join("\n"), /RETAINED_CUSTOM_MARKER/u);
		await worker.runCommand("agent-tree-test", saved[0].id);
		assert.equal(seen.length, 3);
		const branchRequest = seen[2].messages.map(textOf).join("\n");
		assert.ok(branchRequest.endsWith("\n\nREPLACED_BRANCH_INSTRUCTIONS"));
		assert.doesNotMatch(branchRequest, /Additional focus:/u);
		const branchSummary = worker.sessionManager().getBranch().findLast((entry) => entry.type === "branch_summary");
		assert.ok(branchSummary);
		assert.equal(worker.sessionManager().getLabel(branchSummary.id), "selected branch");
		assert.equal(worker.sessionManager().getLeafEntry()?.type, "label");
	} finally { await worker.close(); await store.close(BACKGROUND_CONTEXT); rmSync(dirs.root, { recursive: true, force: true }); }
});

test("real provider sees setup custom content after compaction and reopen", { skip: process.env.PI_AGENT_LIVE !== "1", timeout: 60000 }, async () => {
	const dirs = directories();
	const store = new AgentStore({ sessionsRoot: join(dirs.root, "sessions") });
	const runtime = await ModelRuntime.create({ refreshOnCreate: false });
	const selected = (await runtime.getAvailable())[0];
	assert.ok(selected, "A configured provider is required for the opt-in live test");
	let worker = await AgentWorkerSession.create({ ...dirs, store, modelRuntime: runtime, model: { provider: selected.provider, modelId: selected.id, thinkingLevel: "off" }, rootContext: BACKGROUND_CONTEXT,
		setup: async (manager) => {
			manager.appendMessage({ role: "user", content: "Old text to discard", timestamp: Date.now() });
			const kept = manager.appendCustomMessageEntry("setup.secret-word", "The test word is RETAINED_ORCHID. If asked for the test word, reply with exactly that word.", true);
			manager.appendCompaction("Earlier setup details are omitted.", kept, 100);
		},
	});
	try {
		const metadata = (await store.list(BACKGROUND_CONTEXT))[0];
		await worker.close();
		worker = await AgentWorkerSession.open(metadata, { ...dirs, store, modelRuntime: runtime, rootContext: BACKGROUND_CONTEXT });
		await worker.start("Return only the test word from your retained setup context.");
		await settled(worker);
		const messages = worker.sessionManager().getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const last = messages.at(-1);
		assert.ok(last?.type === "message" && last.message.role === "assistant");
		assert.equal(last.message.stopReason, "stop");
		assert.equal(textOf(last.message).trim(), "RETAINED_ORCHID");
	} finally { await worker.close(); await store.close(BACKGROUND_CONTEXT); rmSync(dirs.root, { recursive: true, force: true }); }
});
