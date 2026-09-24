import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { AgentStore } from "./store.ts";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentWorkerSession, projectInspection } from "./worker.ts";

function signedAnswer(): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: "inspection-test", model: "synthetic",
		content: [
			{ type: "thinking", thinking: "Visible reasoning", thinkingSignature: "OPAQUE-THINKING-PAYLOAD".repeat(4000) },
			{ type: "text", text: "The substantive answer.", textSignature: "OPAQUE-TEXT-PAYLOAD".repeat(4000) },
		],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 1,
	};
}

test("inspection omits opaque signatures before preview and exact-entry pagination", () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendMessage(signedAnswer());
	const before = JSON.stringify(manager.getEntries());
	const page = projectInspection(manager, manager.getSessionId(), { limit: 1 });
	assert.ok("entries" in page);
	assert.ok(!page.entries[0].text.includes("OPAQUE-"), "opaque signatures must not occupy the serialized preview");
	assert.match(page.entries[0].text, /The substantive answer/);
	const detail = projectInspection(manager, manager.getSessionId(), { entryId: id });
	assert.ok("text" in detail);
	assert.ok(!detail.text.includes("OPAQUE-"), "opaque signatures must not enter exact-entry chunks");
	assert.match(detail.text, /Visible reasoning/);
	assert.match(detail.text, /The substantive answer/);
	assert.equal(detail.nextOffset, null);
	assert.equal(JSON.stringify(manager.getEntries()), before);
});

type Inspect = (options: Parameters<typeof projectInspection>[2]) => ReturnType<typeof projectInspection> | Promise<ReturnType<typeof projectInspection>>;

async function readInspection(inspect: Inspect, entryId: string, offset = 0, prefix = "") {
	let text = prefix;
	let chunks = 0;
	let previousOmissions: unknown;
	for (;;) {
		const chunk = await inspect({ entryId, offset });
		assert.ok("text" in chunk);
		assert.equal(chunk.entryId, entryId);
		assert.equal(chunk.offset, offset);
		assert.ok(Buffer.byteLength(chunk.text) <= 12000);
		assert.ok(Buffer.byteLength(JSON.stringify(chunk, null, 2)) < 32000);
		assert.ok(!chunk.text.includes("\uFFFD"));
		if (chunks > 0) assert.deepEqual(chunk.omissions, previousOmissions);
		previousOmissions = chunk.omissions;
		text += chunk.text;
		chunks++;
		if (chunk.nextOffset === null) {
			assert.equal(chunk.truncated, false);
			break;
		}
		assert.equal(chunk.truncated, true);
		assert.equal(chunk.nextOffset, offset + chunk.text.length);
		assert.ok(chunk.nextOffset > offset);
		offset = chunk.nextOffset;
	}
	return { text, entry: JSON.parse(text) as SessionEntry, chunks, omissions: previousOmissions };
}

function populateInspection(manager: SessionManager) {
	const arbitrary = { type: "image", data: "tool-owned data", thinkingSignature: "tool-owned signature", nested: { type: "thinking", redacted: true, thinking: "tool-owned text" } };
	const signedText: TextContent = { type: "text", text: "Readable content", textSignature: "OPAQUE-TEXT-PAYLOAD" };
	const image: ImageContent = { type: "image", mimeType: "image/png", data: "BINARY-IMAGE-PAYLOAD".repeat(4000) };
	const call: ToolCall = { type: "toolCall", id: "call-id", name: "inspect_fixture", namespace: "fixture", arguments: arbitrary, thoughtSignature: "OPAQUE-CALL-PAYLOAD" };
	const assistant = signedAnswer();
	assistant.responseId = "response-id";
	assistant.responseModel = "response-model";
	assistant.providerThinkingLevel = "high";
	assistant.stopReason = "error";
	assistant.rawStopReason = "provider-error";
	assistant.errorMessage = "Provider error evidence";
	assistant.content.push({ type: "thinking", thinking: "HIDDEN-REDACTED-PAYLOAD", thinkingSignature: "OPAQUE-REDACTED-PAYLOAD", redacted: true }, call);
	const ids = {
		system: manager.appendMessage({ role: "system", content: [signedText], sections: { test: "System section" }, toolsAdded: [{ name: "inspect_fixture", description: "Test", parameters: arbitrary }], toolsRemoved: [{ name: "retired" }], timestamp: 1 }),
		user: manager.appendMessage({ role: "user", content: [signedText, image], timestamp: 2 }),
		assistant: manager.appendMessage(assistant),
		result: manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [signedText, image], details: arbitrary, isError: true, timestamp: 3 }),
		customRole: manager.appendMessage({ role: "custom", customType: "fixture", content: [signedText, image], display: false, details: arbitrary, timestamp: 4 }),
		customMessage: manager.appendCustomMessageEntry("fixture", [signedText, image], false, arbitrary),
		customData: manager.appendCustomEntry("fixture", arbitrary),
		bash: manager.appendMessage({ role: "bashExecution", command: "example", output: "Shell output", exitCode: 1, cancelled: false, truncated: false, timestamp: 5 }),
	};
	return { ...ids,
		editAssistant: manager.appendContextEdit(ids.assistant, { content: assistant.content }),
		editImage: manager.appendContextEdit(ids.user, { content: [signedText, image] }),
		editOmission: manager.appendContextEdit(ids.user, null),
		compaction: manager.appendCompaction("Retained summary", ids.assistant, 100, arbitrary),
	};
}

function assertEvidence(entry: SessionEntry, source: SessionEntry, text: string) {
	assert.deepEqual([entry.id, entry.parentId, entry.type, entry.timestamp], [source.id, source.parentId, source.type, source.timestamp]);
	if (entry.type === "message" && source.type === "message") {
		const { content: _content, ...metadata } = entry.message as AssistantMessage;
		const { content: _original, ...originalMetadata } = source.message as AssistantMessage;
		assert.deepEqual(metadata, originalMetadata);
		if (entry.message.role === "assistant") {
			assert.equal(entry.message.content[0].type, "thinking");
			assert.ok(text.includes("Visible reasoning") && text.includes("The substantive answer."));
			const call = entry.message.content.find((part) => part.type === "toolCall");
			const original = (source.message as AssistantMessage).content.find((part) => part.type === "toolCall");
			assert.deepEqual(call?.arguments, original?.arguments);
			assert.deepEqual([call?.id, call?.name, call?.namespace], [original?.id, original?.name, original?.namespace]);
		}
	}
	if (entry.type === "compaction" && source.type === "compaction") {
		assert.equal(entry.summary, source.summary);
		assert.equal(entry.firstKeptEntryId, source.firstKeptEntryId);
		assert.deepEqual(entry.details, source.details);
	}
	if (entry.type === "custom_message" && source.type === "custom_message") assert.deepEqual(entry.details, source.details);
	if (entry.type === "context_edit" && source.type === "context_edit") assert.equal(entry.targetId, source.targetId);
}

test("inspection projects only declared native content containers and preserves evidence and omission counts", async () => {
	const manager = SessionManager.inMemory();
	const ids = populateInspection(manager);
	const before = JSON.stringify(manager.getEntries());
	const inspect: Inspect = (options) => projectInspection(manager, manager.getSessionId(), options);
	const expected = new Map<string, [number, number, number]>([
		[ids.system, [1, 0, 0]], [ids.user, [1, 1, 0]], [ids.assistant, [4, 0, 1]],
		[ids.result, [1, 1, 0]], [ids.customRole, [1, 1, 0]], [ids.customMessage, [1, 1, 0]],
		[ids.editAssistant, [4, 0, 1]], [ids.editImage, [1, 1, 0]],
	]);
	for (const source of manager.getEntries()) {
		const detail = await readInspection(inspect, source.id);
		assert.ok(!/OPAQUE-|BINARY-IMAGE-|HIDDEN-REDACTED-/.test(detail.text), source.type);
		assertEvidence(detail.entry, source, detail.text);
		const counts = expected.get(source.id);
		assert.deepEqual(detail.omissions, counts ? { providerSignatures: counts[0], imagePayloads: counts[1], redactedThinking: counts[2] } : undefined, source.id);
		if (!counts) assert.equal(detail.text, JSON.stringify(source));
	}
	const page = await inspect({ limit: 12 });
	assert.ok("entries" in page);
	for (const entry of page.entries) {
		assert.ok(!/OPAQUE-|BINARY-IMAGE-|HIDDEN-REDACTED-/.test(JSON.stringify(entry)));
		const detail = await readInspection(inspect, entry.id);
		assert.deepEqual(entry.omissions, detail.omissions);
	}
	assert.equal(JSON.stringify(manager.getEntries()), before, "projection never mutates shared native entries");
});

test("inspection covers a typed system checkpoint without filtering its sections or tool schemas", async () => {
	const manager = SessionManager.inMemory();
	const header = manager.getHeader();
	assert.ok(header);
	const source: SessionEntry = {
		type: "compaction", id: "checkpoint", parentId: null, timestamp: new Date(1).toISOString(), summary: "Retained summary", firstKeptEntryId: "checkpoint", tokensBefore: 50,
		systemMessage: { role: "system", content: [{ type: "text", text: "System content", textSignature: "OPAQUE-SYSTEM-PAYLOAD" }], sections: { textSignature: "A section named textSignature" }, toolsAdded: [{ name: "fixture", description: "Tool evidence", parameters: { thinkingSignature: "A schema field" } }], toolsRemoved: [{ name: "retired" }], timestamp: 1 },
	};
	const before = structuredClone(source);
	const seeded = SessionManager.inMemory(undefined, undefined, [header, source]);
	const result = await readInspection((options) => projectInspection(seeded, seeded.getSessionId(), options), source.id);
	assert.equal(result.text.includes("OPAQUE-SYSTEM-PAYLOAD"), false);
	assert.deepEqual(result.omissions, { providerSignatures: 1, imagePayloads: 0, redactedThinking: 0 });
	assert.ok(result.entry.type === "compaction");
	assert.deepEqual(result.entry.systemMessage, { ...source.systemMessage, content: [{ type: "text", text: "System content", textSignature: "[omitted: provider signature]" }] });
	assert.deepEqual(source, before);
});

test("live and read-only inspections share omission and Unicode paging without modifying native storage", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-inspect-paths-"));
	const cwd = join(root, "cwd"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const runtime = await createTestRuntime({ refreshOnCreate: false });
	const worker = await AgentWorkerSession.create({ cwd, agentDir, store, modelRuntime: runtime, model: { provider: "agent-test", modelId: "model" }, rootContext: BACKGROUND_CONTEXT });
	try {
		const native = worker.sessionManager();
		const ids = populateInspection(native);
		const answer = signedAnswer();
		answer.content.push({ type: "text", text: 'Unicode 中文🧪\\"\n'.repeat(5000) });
		const longId = native.appendMessage(answer);
		const metadata = store.metadata(native);
		const bytes = readFileSync(metadata.path);
		const before = JSON.stringify(native.getEntries());
		const claims = readdirSync(join(store.nativeRoot, ".claims"));
		const capture = store.readOnly(metadata);
		assert.equal(capture.unavailable, undefined);
		const captured = JSON.stringify(capture.manager.getEntries());
		const readOnly: Inspect = (options) => projectInspection(capture.manager, metadata.id, options, undefined, { available: true, bytes: capture.bytes, unfinishedTail: capture.unfinishedTail });
		for (const entryId of [...Object.values(ids), longId]) {
			const live = await readInspection((options) => worker.inspect(options), entryId);
			const saved = await readInspection(readOnly, entryId);
			assert.deepEqual(saved, live);
			assert.ok(!/OPAQUE-|BINARY-IMAGE-|HIDDEN-REDACTED-/.test(live.text));
			if (entryId === longId) assert.ok(live.chunks > 2);
		}
		const page = await worker.inspect({ limit: 1 });
		assert.ok("entries" in page && page.entries);
		const preview = page.entries[0];
		assert.equal(preview.id, longId);
		assert.ok(preview.nextOffset);
		const continued = await readInspection(readOnly, longId, preview.nextOffset, preview.text);
		const complete = await readInspection(readOnly, longId);
		assert.deepEqual(continued.entry, complete.entry, "preview offsets address the same projected serialization");
		const older = await readOnly({ cursor: page.nextCursor ?? undefined, limit: 1 });
		assert.ok("entries" in older);
		assert.equal(older.entries[0].id, ids.compaction);
		assert.equal(older.liveOwner, false);
		assert.equal(page.liveOwner, true);
		assert.deepEqual(readFileSync(metadata.path), bytes);
		assert.equal(JSON.stringify(native.getEntries()), before);
		assert.equal(JSON.stringify(capture.manager.getEntries()), captured);
		assert.deepEqual(readdirSync(join(store.nativeRoot, ".claims")), claims);
	} finally { await worker.close(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true }); }
});

test("inspection pages preserve entry identity and bounded UTF-8 detail reconstruction", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-inspect-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const runtime = await createTestRuntime({ refreshOnCreate: false });
	const worker = await AgentWorkerSession.create({ cwd, agentDir, store, modelRuntime: runtime, model: { provider: "agent-test", modelId: "model" }, rootContext: BACKGROUND_CONTEXT });
	try {
		for (let index = 0; index < 15; index++) await worker.appendCustomEntry("inspection.record", { index, content: "中文🧪".repeat(4000) });
		const ids = new Set<string>();
		let cursor: number | undefined;
		do {
			const page = await worker.inspect({ limit: 12, cursor });
			assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") < 32000);
			assert.ok("entries" in page && page.entries);
			for (const entry of page.entries) { assert.ok(!ids.has(entry.id)); ids.add(entry.id); }
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		assert.deepEqual(ids, new Set(worker.sessionManager().getEntries().map((entry) => entry.id)));
		const target = worker.sessionManager().getEntries().find((entry) => entry.type === "custom" && entry.customType === "inspection.record");
		assert.ok(target);
		let offset: number | undefined = 0;
		let text = "";
		do {
			const page = await worker.inspect({ entryId: target.id, offset });
			assert.ok("text" in page && typeof page.text === "string");
			assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") < 32000);
			text += page.text;
			offset = page.nextOffset ?? undefined;
		} while (offset !== undefined);
		const record = JSON.parse(text);
		assert.equal(record.id, target.id);
		assert.deepEqual(record.data, target.type === "custom" ? target.data : undefined);
		await worker.close();
		await worker.close();
	} finally { await worker.close(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true }); }
});
