import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentDashboardData, type DashboardOverlay } from "./dashboard-data.ts";
import type { DetachedRunView } from "./detached.ts";
import { MAX_CAPTURE_BYTES } from "./store.ts";

const time = Date.parse("2026-01-02T10:00:00.000Z");
const stamp = (offset = 0) => new Date(time + offset).toISOString();
const usage = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const entry = <T extends object>(id: string, parentId: string | null, fields: T, offset = 0) => ({ id, parentId, timestamp: stamp(offset), ...fields });
const user = (id = "u", parentId: string | null = null, content = "Inspect the files", offset = 0) => entry(id, parentId, { type: "message", message: { role: "user", content, timestamp: time + offset } }, offset);
const assistant = (id = "a", parentId: string | null = "u", reply = "Work complete", stopReason = "stop", cost = 1, offset = 1000, blocks: object[] = []) => entry(id, parentId, {
	type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }, ...blocks], api: "test", provider: "test", model: "small", stopReason, usage: usage(cost), timestamp: time + offset },
}, offset);
const toolCall = (id = "call", name = "read", args: object = { path: "src/module.ts" }) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id = "t", parentId = "a", call = "call", cost?: number) => entry(id, parentId, {
	type: "message", message: { role: "toolResult", toolCallId: call, toolName: "read", content: [{ type: "text", text: "Tool output" }], isError: false, timestamp: time + 2000, ...(cost === undefined ? {} : { usage: usage(cost) }) },
}, 2000);

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-dashboard-data-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const native = join(root, "native");
	mkdirSync(native);
	const cwd = join(root, "project");
	const header = (id: string) => ({ type: "session", version: CURRENT_SESSION_VERSION, id, cwd, timestamp: stamp() });
	const put = (id: string, entries: object[] = [], name = id) => {
		const path = join(native, `${name}.jsonl`);
		writeFileSync(path, `${[header(id), ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`);
		return path;
	};
	const claim = (id: string, fields: object = {}) => {
		const dir = join(native, ".claims"); mkdirSync(dir, { recursive: true });
		const key = createHash("sha256").update(JSON.stringify([resolve(cwd), id])).digest("hex");
		const path = join(dir, `${key}.lock`);
		writeFileSync(path, JSON.stringify({ token: "test-token", sessionId: id, cwd: resolve(cwd), host: hostname(), pid: process.pid, createdAt: stamp(), ...fields }));
		return path;
	};
	return { root, native, cwd, header, put, claim, data: new AgentDashboardData(native) };
}
function run(cwd: string, fields: Partial<DetachedRunView> = {}): DetachedRunView {
	return { runId: "run", sessionId: "s", cwd, sessionsRoot: "unused", agentDir: "unused", prompt: "Work", logFile: "unused", startedAt: stamp(), pid: process.pid, launchState: "started", state: "running", ...fields };
}
const overlay = (fields: Partial<DashboardOverlay> = {}): DashboardOverlay => ({ held: [], active: [], runs: [], ...fields });

function watchReads(t: { after(fn: () => void): void }) {
	let bytes = 0;
	let calls = 0;
	const spy = mock.method(fs, "readSync", new Proxy(fs.readSync, { apply(target, self, args) {
		calls += 1;
		const count = Reflect.apply(target, self, args) as number;
		bytes += count;
		return count;
	} }));
	syncBuiltinESMExports();
	t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
	return { get bytes() { return bytes; }, get calls() { return calls; } };
}

test("native parsing follows the active branch and counts all recorded usage", async (t) => {
	const f = fixture(t);
	const path = f.put("s", [
		entry("m", null, { type: "model_change", provider: "configured", modelId: "chosen" }),
		entry("h", "m", { type: "thinking_level_change", thinkingLevel: "high" }),
		user("u", "h"), assistant("old", "u", "Abandoned branch", "stop", 2),
		entry("n", "old", { type: "session_info", name: "Stored name" }),
		assistant("a", "u", "Current branch", "toolUse", 3, 1000, [toolCall()]), toolResult("t", "a", "call", 4),
		entry("c", "t", { type: "compaction", summary: "Retained summary", firstKeptEntryId: "u", tokensBefore: 100, usage: usage(5) }),
		entry("b", "c", { type: "branch_summary", summary: "Branch summary", fromId: "old", usage: usage(6) }),
		entry("w", "b", { type: "usage", kind: "arbitrary", provider: "test", model: "small", usage: usage(7) }),
		assistant("done", "w", "Final outcome", "stop", 8, 5000),
		entry("edit", "done", { type: "context_edit", targetId: "done", replacement: { content: "Context-only replacement" } }),
	]);
	const before = readFileSync(path, "utf8");
	const [row] = await f.data.read();
	assert.equal(row.state, "done"); assert.equal(row.latestReply, "Final outcome");
	assert.equal(row.cost, 35); assert.equal(row.toolCalls, 1); assert.equal(row.partial, false);
	assert.equal(row.firstMessage, "Inspect the files"); assert.equal(row.name, "Stored name");
	assert.deepEqual(row.model, { provider: "configured", modelId: "chosen", thinkingLevel: "high" });
	assert.equal(row.durationMs, 5000);
	const conversation = await f.data.conversation("s");
	const native = SessionManager.inMemory(f.cwd, undefined, parseSessionEntries(before));
	assert.deepEqual(conversation.entries, native.getBranch());
	assert.equal(conversation.partial, false);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.deepEqual(readdirSync(f.native), ["s.jsonl"]);
});

test("terminal outcomes survive metadata and cancelled tool results", async (t) => {
	const f = fixture(t);
	for (const [id, stop, state] of [["done", "stop", "done"], ["length", "length", "done"], ["failed", "error", "failed"], ["stopped", "aborted", "stopped"]]) {
		const reply = assistant("a", "u", "Reply", stop);
		if (stop === "error") Object.assign(reply.message, { errorMessage: "Provider refused the request" });
		f.put(id, [user(), reply, ...(stop === "error" || stop === "aborted" ? [toolResult()] : []), entry("meta", stop === "error" || stop === "aborted" ? "t" : "a", { type: "custom", customType: "state", data: {} })]);
		const row = (await f.data.read()).find((item) => item.sessionId === id);
		assert.equal(row?.state, state);
		if (stop === "error") assert.equal(row.error, "Provider refused the request");
	}
});

test("pending tools, completed tool batches, and new user turns remain mid-turn", async (t) => {
	const f = fixture(t);
	f.put("pending", [user(), assistant("a", "u", "Inspect files", "toolUse", 1, 1000, [toolCall("one"), toolCall("two", "bash", { command: "echo\nhello" })]), toolResult("t", "a", "one")]);
	f.put("batch", [user(), assistant("a", "u", "", "toolUse", 1, 1000, [toolCall()]), toolResult()]);
	f.put("prompt", [user(), assistant(), user("next", "a", "Continue", 5000)]);
	f.put("deferred", [user(), assistant("a", "u", "", "deferred")]);
	const rows = await f.data.read();
	assert.ok(rows.every((row) => row.state === "interrupted"));
	assert.deepEqual(rows.find((row) => row.sessionId === "pending")?.currentTool, { name: "bash", argument: "echo hello" });
	assert.equal(rows.find((row) => row.sessionId === "batch")?.currentTool, undefined);
	assert.equal(rows.find((row) => row.sessionId === "prompt")?.latestReply, "Work complete");
});

test("empty sessions and generic custom messages do not imply active execution", async (t) => {
	const f = fixture(t);
	f.put("empty");
	f.put("custom", [entry("c", null, { type: "custom_message", customType: "notice", content: "A notification", display: true })]);
	f.put("done", [user(), assistant(), entry("c", "a", { type: "custom_message", customType: "notice", content: "A notification", display: true })]);
	const rows = await f.data.read();
	assert.equal(rows.find((row) => row.sessionId === "empty")?.state, "new");
	assert.equal(rows.find((row) => row.sessionId === "custom")?.state, "new");
	assert.equal(rows.find((row) => row.sessionId === "done")?.state, "done");
});

test("local overlays distinguish active work, busy hosts, idle hosts, and terminal failures", async (t) => {
	const f = fixture(t);
	for (const id of ["working", "busy", "idle", "failed"]) {
		f.put(id, [user(), assistant("a", "u", "Reply", id === "failed" ? "error" : "stop")]);
		f.claim(id, { host: "foreign.example" });
	}
	const rows = await f.data.read(overlay({ held: ["working", "busy", "idle", "failed"], active: ["working"], busy: ["working", "busy"] }));
	assert.ok(rows.every((row) => row.owner === "here" && row.live));
	assert.equal(rows.find((row) => row.sessionId === "working")?.state, "working");
	assert.equal(rows.find((row) => row.sessionId === "busy")?.state, "unavailable");
	assert.equal(rows.find((row) => row.sessionId === "idle")?.state, "idle");
	assert.equal(rows.find((row) => row.sessionId === "failed")?.state, "failed");
});

test("same-host claims distinguish live windows, dead owners, and permission-limited live processes", async (t) => {
	const f = fixture(t);
	f.put("active", [user()]); f.claim("active");
	f.put("done", [user(), assistant()]); f.claim("done");
	f.put("dead", [user()]); const path = f.claim("dead", { pid: 2147483647 });
	const original = readFileSync(path, "utf8");
	const nativeKill = process.kill;
	const spy = mock.method(process, "kill", (pid: number, signal?: string | number) => {
		if (pid === 2147483647) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		return nativeKill(pid, signal);
	});
	t.after(() => spy.mock.restore());
	let rows = await f.data.read();
	assert.equal(rows.find((row) => row.sessionId === "active")?.state, "working");
	assert.equal(rows.find((row) => row.sessionId === "active")?.owner, "window");
	assert.equal(rows.find((row) => row.sessionId === "done")?.state, "done");
	assert.equal(rows.find((row) => row.sessionId === "dead")?.state, "orphaned");
	assert.equal(readFileSync(path, "utf8"), original);
	spy.mock.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
	rows = await f.data.read();
	assert.equal(rows.find((row) => row.sessionId === "dead")?.state, "working");
});

test("claim content, host, identity, PID, size, and filesystem type fail conservatively", async (t) => {
	const f = fixture(t);
	for (const id of ["foreign", "identity", "cwd", "pid", "timestamp", "oversize", "broken", "link"]) f.put(id, [user()]);
	f.claim("foreign", { host: "foreign.example" }); f.claim("identity", { sessionId: "different" });
	f.claim("cwd", { cwd: `${f.cwd}/other` }); f.claim("pid", { pid: -1 }); f.claim("timestamp", { createdAt: "not a date" });
	writeFileSync(f.claim("oversize"), " ".repeat(17000)); writeFileSync(f.claim("broken"), "{");
	const target = f.claim("link"); unlinkSync(target); symlinkSync(join(f.native, "foreign.jsonl"), target);
	const rows = await f.data.read();
	assert.equal(rows.length, 8);
	assert.ok(rows.every((row) => row.state === "unavailable" && row.owner === "unknown" && row.error));
	assert.equal((await f.data.conversation("foreign")).entries.length, 1);
});

test("only the exact claim filename affects ownership, and claims refresh independently of transcripts", async (t) => {
	const f = fixture(t); f.put("s", [user()]);
	const path = f.claim("different");
	assert.equal((await f.data.read())[0].state, "interrupted");
	const own = f.claim("s");
	assert.equal((await f.data.read())[0].state, "working");
	unlinkSync(own);
	assert.equal((await f.data.read())[0].state, "interrupted");
	assert.ok(statSync(path).isFile());
});

test("detached ownership uses the effective session and directory, with local ownership first", async (t) => {
	const f = fixture(t); f.put("s", [user()]); f.put("replacement", [user()]);
	const detached = run(f.cwd, { currentSessionId: "replacement", progress: { runId: "run", updatedAt: stamp(), entryCount: 1, currentTool: "write", lastText: "A tool output, not an assistant reply" } });
	let rows = await f.data.read(overlay({ runs: [detached] }));
	assert.equal(rows.find((row) => row.sessionId === "s")?.owner, undefined);
	const current = rows.find((row) => row.sessionId === "replacement");
	assert.equal(current?.owner, "detached"); assert.equal(current?.state, "working");
	assert.equal(current?.latestReply, ""); assert.deepEqual(current?.currentTool, { name: "write", argument: "" });
	rows = await f.data.read(overlay({ held: ["replacement"], runs: [detached] }));
	assert.equal(rows.find((row) => row.sessionId === "replacement")?.owner, "here");
	rows = await f.data.read(overlay({ runs: [{ ...detached, cwd: `${f.cwd}/other` }] }));
	assert.equal(rows.find((row) => row.sessionId === "replacement")?.owner, undefined);
});

test("detached terminal outcomes do not overwrite newer native work or live claims", async (t) => {
	const f = fixture(t); const path = f.put("s", [user(), assistant()]);
	utimesSync(path, new Date(time), new Date(time + 1000));
	const failed = run(f.cwd, { state: "failed", finishedAt: stamp(2000), error: "Detached owner failed", summary: "Retained run reply" });
	let [row] = await f.data.read(overlay({ runs: [failed] }));
	assert.equal(row.state, "failed"); assert.equal(row.error, failed.error); assert.equal(row.latestReply, "Work complete");
	f.claim("s");
	[row] = await f.data.read(overlay({ runs: [failed] }));
	assert.equal(row.state, "done"); assert.equal(row.owner, "window");
	appendFileSync(path, `${JSON.stringify(user("later", "a", "More work", 3000))}\n`);
	[row] = await f.data.read(overlay({ runs: [failed] }));
	assert.equal(row.state, "working"); assert.equal(row.latestReply, "Work complete");
});

test("detached summaries fill absent replies without hiding native stopped outcomes", async (t) => {
	const f = fixture(t); const path = f.put("s", [user(), assistant("a", "u", "", "aborted")]);
	utimesSync(path, new Date(time), new Date(time + 1000));
	const finished = run(f.cwd, { state: "finished", finishedAt: stamp(2000), summary: "No retained assistant text" });
	const [row] = await f.data.read(overlay({ runs: [finished] }));
	assert.equal(row.state, "stopped"); assert.equal(row.latestReply, finished.summary);
});

test("digest and selected-conversation caches invalidate on updates and deletion", async (t) => {
	const f = fixture(t); const path = f.put("s", [user(), assistant()]);
	const reads = watchReads(t);
	const [first] = await f.data.read();
	const afterFirst = reads.calls;
	assert.ok(afterFirst > 0);
	await f.data.read(); assert.equal(reads.calls, afterFirst);
	const conversation = await f.data.conversation("s");
	const afterConversation = reads.calls;
	assert.ok(afterConversation > afterFirst);
	conversation.entries.length = 0;
	assert.equal((await f.data.conversation("s")).entries.length, 2);
	assert.equal(reads.calls, afterConversation);
	assert.ok(first.model);
	first.model.modelId = "mutated";
	assert.equal((await f.data.read())[0].model?.modelId, "small");
	appendFileSync(path, `${JSON.stringify(user("next", "a", "Next task", 2000))}\n`);
	assert.equal((await f.data.read())[0].state, "interrupted");
	const updated = await f.data.conversation("s");
	assert.notEqual(updated.revision, conversation.revision); assert.equal(updated.entries.length, 3);
	unlinkSync(path);
	assert.deepEqual(await f.data.read(), []);
	await assert.rejects(f.data.conversation("s"), /not available/);
});

test("conversation selection retains only one transcript cache", async (t) => {
	const f = fixture(t); f.put("one", [user(), assistant()]); f.put("two", [user(), assistant()]);
	await f.data.read();
	const reads = watchReads(t);
	await f.data.conversation("one"); const first = reads.calls;
	await f.data.conversation("one"); assert.equal(reads.calls, first);
	await f.data.conversation("two"); const second = reads.calls; assert.ok(second > first);
	await f.data.conversation("one"); assert.ok(reads.calls > second);
});

test("same-size rewrites, cleared names, and replacement identities refresh the digest", async (t) => {
	const f = fixture(t);
	const path = f.put("s", [user(), assistant("a", "u", "First reply"), entry("n", "a", { type: "session_info", name: "Named" })]);
	await f.data.read();
	const before = readFileSync(path, "utf8");
	writeFileSync(path, before.replace("First reply", "Other reply"));
	utimesSync(path, new Date(time), new Date(time + 10000));
	assert.equal((await f.data.read())[0].latestReply, "Other reply");
	appendFileSync(path, `${JSON.stringify(entry("clear", "n", { type: "session_info", name: "" }))}\n`);
	assert.equal((await f.data.read())[0].name, undefined);
	f.put("replacement", [], "s");
	assert.equal((await f.data.read())[0].sessionId, "replacement");
	await assert.rejects(f.data.conversation("s"), /not available/);
});

test("oversized sessions keep a bounded tail, partial totals, and no invented ancestry", async (t) => {
	const f = fixture(t);
	const path = f.put("s", [user(), assistant("old", "u", "Old answer", "stop", 5)]);
	appendFileSync(path, `${JSON.stringify(entry("large", "old", { type: "custom", customType: "large", data: "x".repeat(MAX_CAPTURE_BYTES + 1000) }))}\n`);
	appendFileSync(path, `${JSON.stringify(assistant("new", "large", "Retained answer", "stop", 2))}\n`);
	const reads = watchReads(t);
	const [row] = await f.data.read();
	assert.ok(reads.bytes <= MAX_CAPTURE_BYTES);
	assert.equal(row.partial, true); assert.equal(row.cost, 2); assert.equal(row.latestReply, "Retained answer");
	assert.equal(row.firstMessage, undefined); assert.equal(row.state, "done");
	const conversation = await f.data.conversation("s");
	assert.deepEqual(conversation.entries.map((item) => item.id), ["new"]); assert.equal(conversation.partial, true);
});

test("malformed JSON, truncated tails, invalid entries, and invalid usage remain partial and untouched", async (t) => {
	const f = fixture(t); const path = f.put("s", [user(), assistant()]);
	appendFileSync(path, 'null\n42\n{"type":"message"}\nnot json\n{"unfinished":');
	const before = readFileSync(path, "utf8");
	let [row] = await f.data.read();
	assert.equal(row.partial, true); assert.equal(row.latestReply, "Work complete");
	assert.equal((await f.data.conversation("s")).partial, true);
	assert.equal(readFileSync(path, "utf8"), before);
	const bad = assistant(); Object.assign(bad.message, { usage: { cost: { total: "unknown" } } });
	f.put("s", [user(), bad]);
	[row] = await f.data.read(); assert.equal(row.cost, 0); assert.equal(row.partial, true);
});

test("missing parents, cycles, duplicate entry IDs, and independent roots never join unrelated history", async (t) => {
	const f = fixture(t);
	f.put("missing", [user(), assistant("a", "absent")]);
	f.put("cycle", [user("u", "a"), assistant("a", "u")]);
	f.put("duplicate", [user(), assistant("a", "u"), assistant("a", "u", "Ambiguous reply")]);
	f.put("roots", [user(), assistant(), user("new", null, "Separate root")]);
	const rows = await f.data.read();
	assert.equal(rows.find((row) => row.sessionId === "duplicate")?.state, "unavailable");
	assert.deepEqual((await f.data.conversation("missing")).entries.map((value) => value.id), ["a"]);
	assert.equal((await f.data.conversation("cycle")).partial, true);
	assert.deepEqual((await f.data.conversation("duplicate")).entries, []);
	const roots = await f.data.conversation("roots");
	assert.deepEqual(roots.entries.map((value) => value.id), ["new"]); assert.equal(roots.partial, false);
});

test("duplicate session IDs refuse conversation selection and never gain overlay ownership", async (t) => {
	const f = fixture(t); f.put("s", [user(), assistant()], "one"); const second = f.put("s", [user()], "two");
	const [row] = await f.data.read(overlay({ held: ["s"], active: ["s"] }));
	assert.equal(row.state, "unavailable"); assert.equal(row.owner, "unknown"); assert.equal(row.live, false); assert.equal(row.partial, true);
	assert.equal(row.cost, 0); assert.match(row.error ?? "", /2 native files/);
	await assert.rejects(f.data.conversation("s"), /multiple native files/);
	unlinkSync(second);
	assert.equal((await f.data.read())[0].state, "done");
	assert.equal((await f.data.conversation("s")).entries.length, 2);
});

test("symlink sessions, directories, and invalid headers do not become sessions", async (t) => {
	const f = fixture(t); const path = f.put("valid", [user(), assistant()]);
	symlinkSync(path, join(f.native, "alias.jsonl")); mkdirSync(join(f.native, "directory.jsonl"));
	writeFileSync(join(f.native, "old.jsonl"), `${JSON.stringify({ ...f.header("old"), version: 2 })}\n`);
	writeFileSync(join(f.native, "broken.jsonl"), "{}\n");
	writeFileSync(join(f.native, "large-header.jsonl"), "x".repeat(17000));
	assert.deepEqual((await f.data.read()).map((row) => row.sessionId), ["valid"]);
	const alias = join(f.root, "alias"); symlinkSync(f.native, alias);
	await assert.rejects(new AgentDashboardData(alias).read(), /regular directory/);
});

test("an unreadable changed header invalidates a cached session instead of showing stale results", async (t) => {
	const f = fixture(t); const path = f.put("s", [user(), assistant()]);
	await f.data.conversation("s");
	writeFileSync(path, "broken\n");
	const [row] = await f.data.read(overlay({ held: ["s"], active: ["s"] }));
	assert.equal(row.state, "unavailable"); assert.equal(row.latestReply, ""); assert.equal(row.partial, true);
	await assert.rejects(f.data.conversation("s"));
});

test("a claim-directory symlink and unexpected PID errors remain unavailable", async (t) => {
	const f = fixture(t); f.put("s", [user()]);
	const external = join(f.root, "other-claims"); mkdirSync(external);
	symlinkSync(external, join(f.native, ".claims"));
	assert.equal((await f.data.read())[0].state, "unavailable");
	unlinkSync(join(f.native, ".claims")); f.claim("s");
	const spy = mock.method(process, "kill", () => { throw Object.assign(new Error("unknown"), { code: "EINVAL" }); });
	t.after(() => spy.mock.restore());
	const [row] = await f.data.read();
	assert.equal(row.state, "unavailable"); assert.match(row.error ?? "", /EINVAL/);
});

test("missing roots are empty and non-ASCII headers retain complete entry text", async (t) => {
	const f = fixture(t);
	assert.deepEqual(await new AgentDashboardData(join(f.root, "missing")).read(), []);
	const path = f.put("s");
	writeFileSync(path, `${[ { ...f.header("s"), cwd: `${f.cwd}/café` }, user(), assistant("a", "u", "Completed café task") ].map((value) => JSON.stringify(value)).join("\n")}\n`);
	assert.equal((await f.data.read())[0].latestReply, "Completed café task");
});

test("the complete inventory is not capped at a display window", async (t) => {
	const f = fixture(t);
	for (let index = 0; index < 75; index += 1) f.put(`session-${index}`);
	assert.equal((await f.data.read()).length, 75);
});
