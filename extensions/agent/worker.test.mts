import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { AgentWorkerSession, type WorkerUpdate } from "./worker.ts";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { defined } from "./test-assertions.mts";

 test("idle native sessions persist without fabricated assistant messages and reopen before a request", async () => {
	const f = await fixture();
	try {
		const metadata = f.worker.sessionMetadata();
		assert.ok(f.worker.sessionManager() instanceof SessionManager);
		assert.ok(existsSync(metadata.path));
		assert.equal(f.requests.length, 0);
		assert.equal(f.worker.sessionManager().getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant"), false);
		assert.equal(JSON.parse(readFileSync(metadata.path, "utf8").split("\n")[0]).version, 3);
		await f.worker.appendCustomEntry("retained", { value: 1 });
		await f.worker.close();
		const reopened = await AgentWorkerSession.open(metadata, { ...f.options, model: undefined });
		assert.ok(reopened.sessionManager().getEntries().some((entry) => entry.type === "custom" && entry.customType === "retained"));
		await reopened.close();
	} finally { await f.close(); }
});

test("native turn and pre-settle boundaries commit drafts and continue before final settlement", async () => {
	const f = await fixture(`export default function(pi) {
		let turn = false, settle = false;
		pi.on("turn_end", (event, ctx) => {
			if (!ctx.sessionManager.getEntry(event.messageEntryId)) throw new Error("missing message identity");
			if (!turn) { turn = true; return { entries: [{ type: "custom_message", customType: "boundary.turn", content: "TURN_CONTINUE", display: true }], continue: true }; }
		});
		pi.on("agent_before_settle", () => { if (!settle) { settle = true; return { entries: [{ type: "custom_message", customType: "boundary.settle", content: "SETTLE_CONTINUE", display: true }], continue: true }; } });
	}`);
	try {
		let settled = 0; f.worker.observe((event) => { if (event.type === "agent_settled") settled++; });
		const id = await f.worker.start("Run the boundary contract"); await f.worker.waitForIdle();
		assert.equal(f.worker.lastErrorMessage(), undefined);
		assert.equal(f.requests.length, 3); assert.equal(settled, 1);
		assert.match(JSON.stringify(f.requests[1]), /TURN_CONTINUE/u);
		assert.match(JSON.stringify(f.requests[2]), /SETTLE_CONTINUE/u);
		assert.equal((await f.worker.operationResult(defined(id)))?.status, "completed");
		assert.equal(f.worker.sessionManager().getEntries().filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("boundary.")).length, 2);
	} finally { await f.close(); }
});

test("settlement captures the current native session selection rather than creation arguments or response identity", async () => {
	const updates: WorkerUpdate[] = [];
	const f = await fixture(`export default pi => {
		pi.on("agent_before_settle", async (_event, ctx) => {
			pi.setSessionName("Settled MixedCase");
			if (!ctx.model || !await pi.setModel({ ...ctx.model, id: "Selected-MixedCase" })) throw new Error("selection rejected");
			pi.setThinkingLevel("high");
		});
	}`, { onUpdate: (update) => updates.push(update) });
	try {
		await f.worker.start("Report the result");
		await f.worker.waitForIdle();
		const notices = updates.filter((update) => update.kind === "settled");
		assert.equal(notices.length, 1);
		const notice = notices[0];
		assert.equal(notice.result.status, "completed");
		assert.equal(notice.name, "Settled MixedCase");
		assert.equal(notice.provider, f.options.model?.provider);
		assert.equal(notice.modelId, "Selected-MixedCase");
		assert.notEqual(notice.modelId, f.options.model?.modelId);
		assert.equal(notice.thinkingLevel, "high");
		const response = f.worker.sessionManager().getEntries().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(response?.type === "message" && response.message.role === "assistant");
		assert.notEqual(notice.modelId, response.message.model);
		const before = structuredClone(notice);
		await f.worker.configure({ name: "Later name", thinkingLevel: "low" });
		assert.deepEqual(notice, before, "later configuration does not rewrite captured display metadata");
	} finally { await f.close(); }
});

test("native replacement tears down, rebinds, invalidates old contexts, and accepts another task", async () => {
	const f = await fixture(`export default function(pi) {
		pi.on("session_start", (_event, ctx) => { pi.appendEntry("startup", { id: ctx.sessionManager.getSessionId(), projection: !!ctx.sessionManager.buildSessionProjection() }); });
		pi.on("session_shutdown", () => { pi.appendEntry("shutdown", {}); });
		pi.registerCommand("replace", { handler: async (_args, ctx) => {
			await ctx.newSession({ setup: async manager => { manager.appendCustomEntry("setup", {}); }, withSession: async fresh => { await fresh.sendMessage({ customType: "fresh", content: "replacement", display: true }); } });
			try { ctx.getSystemPrompt(); throw new Error("old context survived"); } catch(error) { if (error.message === "old context survived") throw error; }
		} });
	}`);
	try {
		const old = f.worker.sessionMetadata();
		const result = await f.worker.runCommand("replace", "");
		assert.notEqual(result.sessionId, old.id);
		const entries = f.worker.sessionManager().getEntries();
		assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "startup"));
		assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "setup"));
		assert.ok(entries.some((entry) => entry.type === "custom_message" && entry.customType === "fresh"));
		assert.equal(SessionManager.open(old.path).getEntries().filter((entry) => entry.type === "custom" && entry.customType === "shutdown").length, 1);
		await f.worker.start("next task"); await f.worker.waitForIdle();
		assert.equal(f.requests.length, 1);
	} finally { await f.close(); }
});

test("headless trust denies gated project settings and extensions until an explicit decision", async () => {
	const f = await fixture();
	try {
		await f.worker.close();
		mkdirSync(join(f.cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(f.cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
		writeFileSync(join(f.cwd, ".pi", "extensions", "local.ts"), 'export default pi => { pi.on("session_start", () => pi.appendEntry("project.loaded", {})); };');
		const denied = await AgentWorkerSession.create(f.options);
		assert.equal(denied.isProjectTrusted(), false);
		assert.equal(denied.sessionManager().getEntries().some((entry) => entry.type === "custom" && entry.customType === "project.loaded"), false);
		await denied.close();
		const allowed = await AgentWorkerSession.create({ ...f.options, trusted: true });
		assert.equal(allowed.isProjectTrusted(), true);
		assert.ok(allowed.sessionManager().getEntries().some((entry) => entry.type === "custom" && entry.customType === "project.loaded"));
		assert.deepEqual((await allowed.status()).activeTools, ["read"]);
		await allowed.close();
	} finally { await f.close(); }
});

test("native compaction uses the ordinary hook and persists a real compaction entry", async () => {
	const f = await fixture(`export default pi => { pi.on("session_before_compact", event => ({ compaction: { summary: "NATIVE_SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } })); };`, {}, { compaction: { keepRecentTokens: 1 } });
	try {
		await f.worker.start("first"); await f.worker.waitForIdle();
		await f.worker.start("second"); await f.worker.waitForIdle();
		const result = await f.worker.compact();
		assert.equal(result.summary, "NATIVE_SUMMARY");
		assert.ok(f.worker.sessionManager().getEntries().some((entry) => entry.type === "compaction"));
		await f.worker.start("next"); await f.worker.waitForIdle();
		assert.match(JSON.stringify(f.requests.at(-1)), /NATIVE_SUMMARY/u);
	} finally { await f.close(); }
});

test("a failed native compaction stays observable until a later compaction succeeds", { timeout: 15000 }, async () => {
	const key = `compaction${randomUUID().replaceAll("-", "")}`;
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = 0;
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const summarizerFailure: AssistantMessage = { role: "assistant", content: [], api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: "error", errorMessage: "summarizer unavailable", timestamp: Date.now(), usage };
	const reply: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "DONE" }], api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: "stop", timestamp: Date.now(), usage };
	let phase: "ok" | "fail" = "ok";
	const stream = () => {
		const events = createAssistantMessageEventStream();
		if (phase === "fail") { events.push({ type: "error", reason: "error", error: summarizerFailure }); events.end(summarizerFailure); return events; }
		events.push({ type: "start", partial: reply }); events.push({ type: "done", reason: "stop", message: reply }); events.end(reply); return events;
	};
	const f = await fixture(`export default pi => pi.on("session_before_compact", () => {
		const attempt = globalThis[${JSON.stringify(key)}];
		globalThis[${JSON.stringify(key)}] = attempt + 1;
		if (attempt % 2 === 0) return { cancel: true };
	});`, {}, { compaction: { keepRecentTokens: 1 } });
	let worker = f.worker;
	try {
		const provider = f.runtime.getRegisteredNativeProvider(testModel.provider); assert.ok(provider);
		f.runtime.registerNativeProvider({ ...provider, stream, streamSimple: stream });
		await f.worker.close();
		worker = await AgentWorkerSession.create(f.options);
		await worker.start("first"); await worker.waitForIdle();
		await worker.start("second"); await worker.waitForIdle();
		await assert.rejects(worker.compact(), /Compaction cancelled/u);
		assert.equal((await worker.status()).compactionFailure, undefined, "an aborted compaction is not recorded as a failure");
		phase = "fail";
		await assert.rejects(worker.compact(), /Summarization failed: summarizer unavailable/u);
		const failed = await worker.status();
		assert.equal(failed.compactionFailure?.reason, "manual");
		assert.match(failed.compactionFailure?.errorMessage ?? "", /Compaction failed: Summarization failed: summarizer unavailable/u);
		assert.ok(Date.parse(failed.compactionFailure?.at ?? "") > 0);
		const failedInspection = await worker.inspect({ view: "activity" });
		assert.ok("turns" in failedInspection);
		assert.equal(failedInspection.metadata.compactionFailure?.reason, "manual");
		assert.match(failedInspection.text, /last compaction failure \(manual\): Compaction failed: Summarization failed: summarizer unavailable at /u);
		phase = "ok";
		await assert.rejects(worker.compact(), /Compaction cancelled/u);
		const aborted = await worker.status();
		assert.equal(aborted.compactionFailure?.reason, "manual", "an aborted compaction does not clear the retained failure");
		assert.match(aborted.compactionFailure?.errorMessage ?? "", /summarizer unavailable/u);
		const recovered = await worker.compact();
		assert.ok(recovered.summary);
		const cleared = await worker.status();
		assert.equal(cleared.compactionFailure, undefined);
		const clearedInspection = await worker.inspect({ view: "activity" });
		assert.ok("turns" in clearedInspection);
		assert.doesNotMatch(clearedInspection.text, /last compaction failure/u);
		assert.equal(clearedInspection.metadata.compactionFailure, undefined);
	} finally { await worker.close(); delete globals[key]; await f.close(); }
});

test("an in-flight provider retry is observable and clears when the retry ends", { timeout: 15000 }, async () => {
	const f = await fixture("export default function() {}", {}, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 } });
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const failure: AssistantMessage = { role: "assistant", content: [], api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: "error", errorMessage: "rate limit exceeded", timestamp: Date.now(), usage };
	const recovered: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "RECOVERED" }], api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: "stop", timestamp: Date.now(), usage };
	let calls = 0;
	let pending: ReturnType<typeof createAssistantMessageEventStream> | undefined;
	let began!: () => void;
	const started = new Promise<void>((done) => { began = done; });
	const stream = () => {
		calls++;
		const events = createAssistantMessageEventStream();
		if (calls === 1) { events.push({ type: "error", reason: "error", error: failure }); events.end(failure); return events; }
		began(); pending = events;
		return events;
	};
	let worker = f.worker;
	try {
		const provider = f.runtime.getRegisteredNativeProvider(testModel.provider); assert.ok(provider);
		f.runtime.registerNativeProvider({ ...provider, stream, streamSimple: stream });
		await f.worker.close();
		worker = await AgentWorkerSession.create(f.options);
		const operation = await worker.start("trigger the provider failure");
		await started;
		const live = await worker.status();
		assert.deepEqual(live.autoRetry, { attempt: 1, maxAttempts: 1, delayMs: 5, errorMessage: "rate limit exceeded" });
		const inspection = await worker.inspect({ view: "activity" });
		assert.ok("turns" in inspection);
		assert.equal(inspection.metadata.autoRetry?.attempt, 1);
		assert.match(inspection.text, /provider retry 1\/1 after 5ms: rate limit exceeded/u);
		assert.ok(pending);
		pending.push({ type: "start", partial: recovered }); pending.push({ type: "done", reason: "stop", message: recovered }); pending.end(recovered);
		await worker.waitForIdle();
		const settled = await worker.status();
		assert.equal(settled.autoRetry, undefined);
		const settledInspection = await worker.inspect({ view: "activity" });
		assert.ok("turns" in settledInspection);
		assert.doesNotMatch(settledInspection.text, /provider retry/u);
		assert.equal(settledInspection.metadata.autoRetry, undefined);
		assert.equal((await worker.operationResult(defined(operation)))?.status, "completed");
	} finally { await worker.close(); await f.close(); }
});
