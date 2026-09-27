import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { queryEvidence, validateInspect, EVIDENCE_LIMITS, type InspectOptions } from "./evidence.ts";
import { projectInspection } from "./worker.ts";
import { AgentManager } from "./index.ts";
import { createDetachedControlServer, withDetachedControl } from "./detached-control.ts";
import { DetachedRuns, type DetachedRunRequest } from "./detached.ts";
import { randomUUID } from "node:crypto";
import { fixture } from "./native-fixture.mts";
import { defined } from "./test-assertions.mts";

const user = (manager: SessionManager, text: string) => manager.appendMessage({ role: "user", content: text, timestamp: 1 });

test("ancestry search identifies raw text and never mixes abandoned branches", () => {
	const native = SessionManager.inMemory();
	const root = user(native, "shared root");
	const abandoned = user(native, "target abandoned");
	native.branch(root);
	const current = user(native, "target current");
	const before = JSON.stringify(native.getEntries());
	const active = queryEvidence(native, native.getSessionId(), { view: "search", query: "target" });
	assert.deepEqual(active.evidence.map((entry) => entry.id), [current]);
	const other = queryEvidence(native, native.getSessionId(), { view: "search", query: "target", fromId: abandoned });
	assert.deepEqual(other.evidence.map((entry) => entry.id), [abandoned]);
	assert.equal(other.evidence[0].path, "/message/content");
	assert.equal(other.evidence[0].matchOffset, 0);
	assert.equal(native.getLeafId(), current);
	assert.equal(JSON.stringify(native.getEntries()), before);
});

test("empty pages carry a pinned, authenticated continuation and bounded native lookups", () => {
	const native = SessionManager.inMemory();
	const first = user(native, "needle");
	for (let i = 0; i < EVIDENCE_LIMITS.visits + 5; i++) native.appendCustomEntry("irrelevant", { text: "needle" });
	let reads = 0;
	const access = { getLeafId: () => native.getLeafId(), getEntry: (id: string) => { reads++; return native.getEntry(id); } };
	const page = queryEvidence(access, native.getSessionId(), { view: "search", query: "needle", source: "user" });
	assert.equal(page.evidence.length, 0);
	assert.equal(page.coverage.visits, EVIDENCE_LIMITS.visits);
	assert.equal(reads, EVIDENCE_LIMITS.visits + 1);
	assert.ok(page.continuation);
	user(native, "needle after cursor");
	const next = queryEvidence(access, native.getSessionId(), { view: "search", query: "needle", source: "user", continuation: page.continuation });
	assert.deepEqual(next.evidence.map((entry) => entry.id), [first]);
	assert.equal(next.fromId, page.fromId);
	assert.equal(next.coverage.complete, true);
	assert.throws(() => queryEvidence(native, "different-session", { view: "search", query: "needle", source: "user", continuation: defined(page.continuation) }), /does not match/);
	assert.throws(() => queryEvidence(native, native.getSessionId(), { view: "search", query: "other", source: "user", continuation: defined(page.continuation) }), /does not match/);
	const [payload, signature] = page.continuation.split(".");
	const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
	forged.entryId = first;
	assert.throws(() => queryEvidence(native, native.getSessionId(), { view: "search", query: "needle", source: "user", continuation: `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}` }), /Invalid inspect continuation/);
});

test("search crosses scan boundaries, advances Unicode offsets, and bounds native content slots", () => {
	const native = SessionManager.inMemory();
	const id = user(native, `${"a".repeat(EVIDENCE_LIMITS.scanBytes - 3)}needle🧪`);
	const first = queryEvidence(native, native.getSessionId(), { view: "search", query: "needle🧪" });
	assert.equal(first.evidence.length, 0);
	assert.ok(first.continuation);
	assert.ok(first.coverage.scannedBytes <= EVIDENCE_LIMITS.scanBytes);
	const second = queryEvidence(native, native.getSessionId(), { view: "search", query: "needle🧪", continuation: first.continuation });
	assert.equal(second.evidence[0].id, id);
	assert.equal(second.evidence[0].matchOffset, EVIDENCE_LIMITS.scanBytes - 3);
	const unicode = SessionManager.inMemory();
	user(unicode, `${"🧪".repeat(17000)}goal`);
	let continuation: string | undefined;
	let found = false;
	for (let attempts = 0; attempts < 4; attempts++) {
		const page = queryEvidence(unicode, unicode.getSessionId(), { view: "search", query: "goal", continuation });
		assert.ok(page.coverage.scannedBytes <= EVIDENCE_LIMITS.scanBytes);
		if (page.evidence.length) { found = true; break; }
		assert.ok(page.continuation); continuation = page.continuation;
	}
	assert.ok(found);
	const many = SessionManager.inMemory();
	many.appendMessage({ role: "user", timestamp: 1, content: [...Array.from({ length: EVIDENCE_LIMITS.slots + 2 }, () => ({ type: "image" as const, data: "needle", mimeType: "image/png" })), { type: "text", text: "needle visible" }] });
	const omitted = queryEvidence(many, many.getSessionId(), { view: "search", query: "needle" });
	assert.equal(omitted.evidence.length, 0); assert.equal(omitted.coverage.slots, EVIDENCE_LIMITS.slots);
	assert.ok(omitted.continuation);
	const shown = queryEvidence(many, many.getSessionId(), { view: "search", query: "needle", continuation: omitted.continuation });
	assert.equal(shown.evidence.length, 1);
	assert.match(defined(shown.evidence[0].path), /text$/);
});

test("search previews and continuation overlap preserve Unicode boundaries", () => {
	const native = SessionManager.inMemory();
	user(native, `🧪${"a".repeat(79)}needle`);
	const match = queryEvidence(native, native.getSessionId(), { view: "search", query: "needle" });
	assert.equal(/[\uD800-\uDFFF]/u.test(defined(match.evidence[0].preview)), false);
	const text = `${"🧪".repeat(17000)}goal`;
	user(native, text);
	const page = queryEvidence(native, native.getSessionId(), { view: "search", query: "goal" });
	const payload = JSON.parse(Buffer.from(defined(page.continuation).split(".")[0], "base64url").toString());
	assert.equal(/[\uDC00-\uDFFF]/u.test(text[payload.offset]), false);
});

test("search output stays bounded and every continuation advances", () => {
	const native = SessionManager.inMemory();
	for (let i = 0; i < 20; i++) user(native, `needle${"\u0001".repeat(600)}`);
	const ids = new Set<string>();
	let continuation: string | undefined;
	for (let pages = 0; pages < 20; pages++) {
		const page = queryEvidence(native, native.getSessionId(), { view: "search", query: "needle", limit: 12, continuation });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= EVIDENCE_LIMITS.outputBytes);
		assert.ok(page.evidence.length > 0);
		for (const item of page.evidence) { assert.ok(!ids.has(item.id)); ids.add(item.id); }
		if (!page.continuation) break;
		assert.notEqual(page.continuation, continuation);
		continuation = page.continuation;
	}
	assert.equal(ids.size, 20);
});

test("search excludes opaque fields and keeps raw history separate from context edits", () => {
	const native = SessionManager.inMemory();
	const id = user(native, "original evidence");
	native.appendContextEdit(id, { content: "replacement content" });
	native.appendMessage({ role: "assistant", api: "openai-responses", provider: "test", model: "model", stopReason: "stop", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "thinking", thinking: "hidden-evidence", redacted: true, thinkingSignature: "signature-evidence" }, { type: "text", text: "visible text", textSignature: "signature-evidence" }, { type: "toolCall", id: "call", name: "read", arguments: { text: "argument-evidence" }, thoughtSignature: "signature-evidence" }] });
	for (const query of ["hidden-evidence", "signature-evidence", "argument-evidence", "replacement content"]) assert.equal(queryEvidence(native, native.getSessionId(), { view: "search", query }).evidence.length, 0);
	assert.equal(queryEvidence(native, native.getSessionId(), { view: "search", query: "original evidence" }).evidence[0].id, id);
});

test("result selection returns an exact native entry and preserves full Unicode continuation", () => {
	const native = SessionManager.inMemory();
	const text = "Complete result 中文🧪\n".repeat(3000);
	native.appendCustomEntry("agent.operation", { operationId: "operation-a" });
	const id = native.appendCustomEntry("agent.result", { operationId: "operation-a", status: "completed", text });
	const result = projectInspection(native, native.getSessionId(), { view: "result" });
	assert.ok("entryId" in result && "text" in result);
	assert.equal(result.entryId, id);
	let full = result.text;
	let offset = result.nextOffset;
	while (offset !== null) {
		const page = projectInspection(native, native.getSessionId(), { view: "result", entryId: id, offset });
		assert.ok("text" in page); full += page.text; offset = page.nextOffset;
	}
	assert.equal(JSON.parse(full).data.text, text);
	const history = projectInspection(native, native.getSessionId(), { limit: 1 });
	assert.ok("result" in history); assert.equal(history.result?.entryId, id);
	native.appendCustomEntry("agent.operation", { operationId: "operation-b" });
	const pending = projectInspection(native, native.getSessionId(), { view: "result" });
	assert.ok("coverage" in pending); assert.match(defined(pending.coverage?.reason), /no result/);
	assert.ok(!("text" in pending));
	const prior = projectInspection(native, native.getSessionId(), { view: "result", operationId: "operation-a" });
	assert.ok("entryId" in prior); assert.equal(prior.entryId, id);
	assert.throws(() => projectInspection(native, native.getSessionId(), { view: "result", entryId: id, operationId: "other" }), /does not match/);
	const malformed = native.appendCustomEntry("agent.result", { operationId: "", status: "completed", text: "invalid" });
	assert.throws(() => projectInspection(native, native.getSessionId(), { view: "result", entryId: malformed }), /Malformed/);
});

test("branch summaries expose alternate tips, while missing ancestry remains incomplete", () => {
	const native = SessionManager.inMemory();
	const old = user(native, "old alternative");
	native.branchWithSummary(null, "summary", undefined);
	const branch = queryEvidence(native, native.getSessionId(), { view: "branch", source: "summary" });
	assert.equal(branch.evidence[0].fromId, old);
	const header = defined(native.getHeader());
	const orphan = SessionManager.inMemory(undefined, undefined, [header, { type: "session_info", id: "orphan", parentId: "missing", timestamp: new Date().toISOString(), name: "Partial" }]);
	const partial = queryEvidence(orphan, orphan.getSessionId(), { view: "branch" });
	assert.equal(partial.coverage.complete, false);
	assert.match(partial.coverage.reason, /missing/);
	assert.equal(partial.continuation, null);
});

test("invalid selectors refuse rather than silently change source scope", () => {
	for (const options of [ { view: "search" }, { view: "search", query: "  " }, { view: "branch", query: "x" }, { view: "history", fromId: "id" }, { view: "result", offset: 1 }, { view: "search", query: "x", cursor: 2 }, { view: "result", source: "user" }, { view: "history", entryId: "id", limit: 1 }, { view: "invented" }, { continuation: "x" }, { limit: 13 } ]) assert.throws(() => validateInspect(options));
});

test("ordinary native-host results and closed-session queries share read-only evidence", { timeout: 20000 }, async () => {
	const f = await fixture();
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const operationId = await f.worker.start("retrieve this evidence");
		await f.worker.waitForIdle();
		const sessionId = f.worker.sessionId();
		const file = f.worker.sessionMetadata().path;
		const before = readFileSync(file);
		const claims = readdirSync(join(f.store.nativeRoot, ".claims"));
		const result = await f.worker.inspect({ view: "result", operationId });
		assert.ok("entryId" in result && "text" in result);
		assert.equal(JSON.parse(result.text).data.text, "DONE");
		const direct = await manager.inspect(sessionId, { view: "result", operationId });
		assert.ok("text" in direct); assert.equal(direct.text, result.text);
		assert.equal(direct.liveOwner, false);
		const options: InspectOptions = { view: "search", query: "retrieve this evidence", source: "user" };
		const live = await f.worker.inspect(options);
		const saved = await manager.inspect(sessionId, options);
		assert.ok("evidence" in live && "evidence" in saved);
		assert.deepEqual(saved.evidence, live.evidence);
		assert.deepEqual(readFileSync(file), before);
		assert.deepEqual(readdirSync(join(f.store.nativeRoot, ".claims")), claims);
		await f.worker.close();
		const reopened = await manager.inspect(sessionId, { view: "result", entryId: result.entryId });
		assert.ok("text" in reopened); assert.equal(reopened.text, result.text);
	} finally { await manager.closeAll(); await f.close(); }
});

test("unsaved live results stay in history and do not replace selected ancestry results", { timeout: 20000 }, async () => {
	let failure: Error | undefined;
	const f = await fixture(undefined, { associationFailure: () => failure });
	try {
		const native = f.worker.sessionManager();
		const root = defined(native.getLeafId());
		const savedOperation = defined(await f.worker.start("saved alternate result"));
		await f.worker.waitForIdle();
		const saved = await f.worker.inspect({ view: "result" });
		assert.ok("entryId" in saved && "text" in saved);
		for (let i = 0; i <= EVIDENCE_LIMITS.visits; i++) native.appendSessionInfo(`alternate note ${i}`);
		const alternateTip = defined(native.getLeafId());
		native.branch(root);
		const unsubscribe = f.worker.observe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") failure = new Error("association persistence refused ".repeat(1000));
		});
		const unsavedOperation = defined(await f.worker.start("live result without persistence"));
		await f.worker.waitForIdle();
		unsubscribe();
		assert.equal(f.worker.hasUnsavedResult(), true);
		assert.notEqual(savedOperation, unsavedOperation);
		const before = readFileSync(f.worker.sessionMetadata().path);

		const selected = await f.worker.inspect({ view: "result", fromId: saved.entryId });
		assert.ok("text" in selected && "operationId" in selected && "status" in selected && "resultPersistence" in selected);
		assert.equal(selected.operationId, savedOperation);
		assert.equal(selected.status, "completed");
		assert.equal(selected.text, saved.text);
		assert.equal(selected.resultPersistence, "saved native entry");
		assert.equal("result" in selected, false);

		const first = await f.worker.inspect({ view: "result", fromId: alternateTip });
		assert.ok("continuation" in first && first.continuation);
		assert.equal("result" in first, false);
		const continued = await f.worker.inspect({ view: "result", continuation: first.continuation });
		assert.ok("text" in continued && "operationId" in continued && "resultPersistence" in continued);
		assert.equal(continued.operationId, savedOperation);
		assert.equal(continued.text, saved.text);
		assert.equal(continued.resultPersistence, "saved native entry");
		assert.equal("result" in continued, false);
		const current = await f.worker.inspect({ view: "result" });
		assert.ok("operationId" in current); assert.equal(current.operationId, unsavedOperation);
		assert.equal("result" in current, false);
		assert.equal("resultPersistence" in current, false);

		const history = await f.worker.inspect();
		assert.ok("result" in history && history.result && "resultPersistence" in history);
		assert.equal(history.resultPersistence, "not saved; retained only by the live owner");
		let text = history.result.text;
		let offset = history.result.nextOffset;
		assert.ok(offset !== null);
		while (offset !== null) {
			const next = await f.worker.inspect({ view: "history", offset });
			assert.ok("result" in next && next.result);
			text += next.result.text; offset = next.result.nextOffset;
		}
		assert.equal(JSON.parse(text).operationId, unsavedOperation);
		assert.equal(JSON.parse(text).status, "failed");
		assert.deepEqual(readFileSync(f.worker.sessionMetadata().path), before);
	} finally { await f.close(); }
});

test("Unix control serves native result chunks and ancestry queries without source writes", { timeout: 20000 }, async () => {
	const f = await fixture();
	try {
		const operationId = await f.worker.start("evidence through the detached route");
		await f.worker.waitForIdle();
		const sessionId = f.worker.sessionId();
		const file = f.worker.sessionMetadata().path;
		const before = readFileSync(file);
		const runs = new DetachedRuns(f.store.root);
		const request: DetachedRunRequest = { runId: randomUUID(), sessionId, sessionsRoot: f.store.root, agentDir: f.agentDir, cwd: f.worker.sessionMetadata().cwd, prompt: "isolated transport", logFile: join(f.store.root, "run.log"), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" };
		runs.writeRequest(request);
		const server = await createDetachedControlServer({ request, metadata: f.worker.sessionMetadata(), worker: f.worker, requestAbort: () => false, canSteer: () => false });
		try {
			await withDetachedControl(request, async (control) => {
				const result = await control.inspect({ view: "result", operationId });
				assert.ok("text" in result && "entryId" in result);
				assert.equal(JSON.parse(result.text).data.text, "DONE");
				const exact = await control.inspect({ view: "result", entryId: result.entryId });
				assert.ok("text" in exact); assert.equal(exact.text, result.text);
				const page = await control.inspect({ view: "search", query: "evidence through", source: "user" });
				assert.ok("evidence" in page); assert.equal(page.evidence.length, 1);
				assert.equal(page.evidence[0].path, "/message/content/0/text");
			});
			assert.deepEqual(readFileSync(file), before);
		} finally { await server.close(); }
	} finally { await f.close(); }
});
