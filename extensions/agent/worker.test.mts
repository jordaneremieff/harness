import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentWorkerSession } from "./worker.ts";
import { fixture } from "./native-fixture.mts";
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
