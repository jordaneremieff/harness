import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { discoverSessions, DISCOVERY_LIMITS, validateDiscovery } from "./discovery.ts";
import { AgentStore, MAX_CAPTURE_BYTES } from "./store.ts";
import { defined } from "./test-assertions.mts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "agent-metadata-"));
	return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}
function seed(root: string, name: string, task: UserMessage["content"], id = name) {
	const native = SessionManager.inMemory("/project", undefined, [{ type: "session", version: 3, id, cwd: "/project", timestamp: new Date(0).toISOString() }]);
	native.appendSessionInfo(name);
	native.appendMessage({ role: "user", content: task, timestamp: 1 });
	const path = join(root, `${name}.jsonl`);
	writeFileSync(path, `${[native.getHeader(), ...native.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { path, native };
}

test("metadata discovery uses literal filters, compact rows and no whole-store native scan", async (t) => {
	const f = setup();
	try {
		const target = seed(f.root, "named-session", "Unicode 🧪 [literal] task");
		seed(f.root, "other", "other work");
		const before = readFileSync(target.path);
		t.mock.method(SessionManager, "listAll", () => { throw new Error("whole-store listing is forbidden"); });
		const page = await discoverSessions(f.root, { query: "[LITERAL]", cwd: "/project", limit: 1 });
		assert.equal(page.rows.length, 1);
		assert.equal(page.rows[0].sessionId, "named-session");
		assert.equal(page.rows[0].firstMessage, "Unicode 🧪 [literal] task");
		assert.equal((await discoverSessions(f.root, { query: ".*" })).rows.length, 0);
		assert.equal((await discoverSessions(f.root, { cwd: "/other" })).rows.length, 0);
		assert.deepEqual(readFileSync(target.path), before);
		assert.equal(existsSync(join(f.root, ".claims")), false);
	} finally { f.close(); }
});

for (const [name, content] of [
	["empty string", ""],
	["empty array", []],
	["image only", [{ type: "image", data: "YQ==", mimeType: "image/png" }]],
] satisfies Array<[string, UserMessage["content"]]>) test(`discovery selects first actual user text after ${name}`, async () => {
	const f = setup();
	try {
		const item = seed(f.root, "first-text", content);
		const first = item.native.appendMessage({ role: "user", content: "first actual task", timestamp: 2 });
		const later = item.native.appendMessage({ role: "user", content: "later conversation text", timestamp: 3 });
		appendFileSync(item.path, `${JSON.stringify(item.native.getEntry(first))}\n${JSON.stringify(item.native.getEntry(later))}\n`);
		const before = readFileSync(item.path);
		const page = await discoverSessions(f.root, { query: "first actual task" });
		assert.equal(page.rows.length, 1);
		assert.equal(page.rows[0].firstMessage, "first actual task");
		assert.equal(page.coverage.exhausted, true);
		assert.equal(page.coverage.partialMetadata, 0);
		assert.equal(page.coverage.skipped.length, 0);
		assert.equal((await discoverSessions(f.root, { query: "later conversation text" })).rows.length, 0);
		assert.deepEqual(readFileSync(item.path), before);
	} finally { f.close(); }
});

test("discovery rejects malformed user text without coercion and reports source coverage", async () => {
	const f = setup();
	try {
		const item = seed(f.root, "malformed-text", "placeholder");
		const entries = item.native.getEntries().map((entry) => entry.type === "message" && entry.message.role === "user"
			? { ...entry, message: { ...entry.message, content: [{ type: "text", text: { value: "not text" } }] } } : entry);
		writeFileSync(item.path, `${[item.native.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const before = readFileSync(item.path);
		const page = await discoverSessions(f.root, { query: "[object Object]" });
		assert.equal(page.rows.length, 0);
		assert.equal(page.coverage.exhausted, true);
		assert.equal(page.coverage.filesRead, 1);
		assert.equal(page.coverage.captureBytes, before.length);
		assert.equal(page.coverage.skipped.length, 1);
		assert.match(page.coverage.skipped[0].reason, /malformed/);
		assert.deepEqual(readFileSync(item.path), before);
	} finally { f.close(); }
});

test("discovery rejects non-string names before metadata filtering", async () => {
	const f = setup();
	try {
		const item = seed(f.root, "malformed-name", "retained task");
		const nameId = item.native.appendSessionInfo("placeholder");
		appendFileSync(item.path, `${JSON.stringify({ ...item.native.getEntry(nameId), name: ["not a name"] })}\n`);
		const before = readFileSync(item.path);
		const page = await discoverSessions(f.root, { query: "not a name" });
		assert.equal(page.rows.length, 0);
		assert.equal(page.coverage.skipped.length, 1);
		assert.match(page.coverage.skipped[0].reason, /malformed/);
		assert.equal(page.coverage.captureBytes, before.length);
		assert.deepEqual(readFileSync(item.path), before);
	} finally { f.close(); }
});

for (const timestamp of [undefined, "not-a-date"]) test(`discovery rejects ${timestamp === undefined ? "missing" : "invalid"} header timestamps`, async () => {
	const f = setup();
	try {
		const item = seed(f.root, "invalid-header", "retained task");
		writeFileSync(item.path, `${[{ ...item.native.getHeader(), timestamp }, ...item.native.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const before = readFileSync(item.path);
		const page = await discoverSessions(f.root);
		assert.equal(page.rows.length, 0);
		assert.equal(page.coverage.exhausted, true);
		assert.equal(page.coverage.captureBytes, before.length);
		assert.equal(page.coverage.skipped.length, 1);
		assert.match(page.coverage.skipped[0].reason, /malformed/);
		assert.deepEqual(readFileSync(item.path), before);
	} finally { f.close(); }
});

test("empty discovery pages progress and bind continuation to inventory and filters", async () => {
	const f = setup();
	try {
		seed(f.root, "000-target", "find me");
		for (let i = 0; i < DISCOVERY_LIMITS.files + 2; i++) seed(f.root, `z-${String(i).padStart(3, "0")}`, "unrelated");
		const first = await discoverSessions(f.root, { query: "find me" });
		assert.equal(first.rows.length, 0);
		assert.equal(first.coverage.filesRead, DISCOVERY_LIMITS.files);
		assert.ok(first.nextCursor);
		const second = await discoverSessions(f.root, { query: "find me", cursor: first.nextCursor });
		assert.equal(second.rows[0].sessionId, "000-target");
		assert.equal(second.nextCursor, null);
		await assert.rejects(discoverSessions(f.root, { query: "other", cursor: first.nextCursor }), /does not match/);
		seed(f.root, "new-file", "new work");
		await assert.rejects(discoverSessions(f.root, { query: "find me", cursor: first.nextCursor }), /does not match/);
	} finally { f.close(); }
});

test("file changes do not imply a frozen transcript snapshot", async () => {
	const f = setup();
	try {
		seed(f.root, "z-first", "first");
		const last = seed(f.root, "a-next", "second");
		const first = await discoverSessions(f.root, { limit: 1 });
		assert.ok(first.nextCursor);
		const id = last.native.appendSessionInfo("changed name");
		appendFileSync(last.path, `${JSON.stringify(last.native.getEntry(id))}\n`);
		const second = await discoverSessions(f.root, { limit: 1, cursor: first.nextCursor });
		assert.equal(second.rows[0].name, "changed name");
		assert.match(second.continuation, /not file contents/);
	} finally { f.close(); }
});

test("capture byte bounds include malformed files and expose oversized or partial sources", async () => {
	const f = setup();
	try {
		for (const name of ["z-invalid", "y-invalid", "x-invalid"]) {
			const path = join(f.root, `${name}.jsonl`);
			writeFileSync(path, "not-json\n"); truncateSync(path, MAX_CAPTURE_BYTES);
		}
		const oversize = join(f.root, "a-oversize.jsonl"); writeFileSync(oversize, ""); truncateSync(oversize, MAX_CAPTURE_BYTES + 1);
		const first = await discoverSessions(f.root);
		assert.equal(first.coverage.captureBytes, DISCOVERY_LIMITS.captureBytes);
		assert.equal(first.coverage.filesRead, 2);
		assert.ok(first.nextCursor);
		const second = await discoverSessions(f.root, { cursor: first.nextCursor });
		assert.equal(second.coverage.skipped.length, 2);
		assert.match(second.coverage.skipped[1].reason, /capture bound/);
		const partial = seed(f.root, "partial", "visible");
		appendFileSync(partial.path, '{"unfinished":');
		const page = await discoverSessions(f.root, { query: "visible" });
		assert.ok(page.nextCursor);
		const rest = await discoverSessions(f.root, { query: "visible", cursor: page.nextCursor });
		assert.equal(rest.rows[0].metadataPartial, true);
		assert.deepEqual(readFileSync(partial.path).subarray(-14).toString(), '{"unfinished":');
	} finally { f.close(); }
});

test("discovery caps directory traversal, ignores directories, and honors cancellation", async () => {
	const f = setup();
	try {
		seed(f.root, "real", "work");
		mkdirSync(join(f.root, "not-a-session.jsonl"));
		assert.equal((await discoverSessions(f.root)).rows.length, 1);
		const controller = new AbortController(); controller.abort();
		await assert.rejects(discoverSessions(f.root, {}, controller.signal), /abort/i);
		for (let i = readdirSync(f.root).length; i <= DISCOVERY_LIMITS.directoryEntries; i++) writeFileSync(join(f.root, `unrelated-${i}`), "");
		await assert.rejects(discoverSessions(f.root), /directory exceeds/);
	} finally { f.close(); }
});

test("discovery bounds escaped output and reports metadata search truncation", async () => {
	const f = setup();
	try {
		for (let i = 0; i < 25; i++) seed(f.root, `name-${i}`, `prefix ${"\u0001".repeat(5000)} suffix`);
		let cursor: string | undefined;
		const ids = new Set<string>();
		for (let pages = 0; pages < 10; pages++) {
			const page = await discoverSessions(f.root, { limit: 20, cursor });
			assert.ok(Buffer.byteLength(JSON.stringify(page)) <= DISCOVERY_LIMITS.outputBytes);
			for (const row of page.rows) { assert.ok(!ids.has(row.sessionId)); ids.add(row.sessionId); assert.equal(row.metadataPartial, true); }
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		assert.equal(ids.size, 25);
	} finally { f.close(); }
});

test("discovery progresses after a metadata row exceeds the output budget", async () => {
	const f = setup();
	try {
		const huge = seed(f.root, "z-huge", "\u0001".repeat(512));
		huge.native.appendSessionInfo("\u0001".repeat(512));
		const header = { ...huge.native.getHeader(), cwd: `/${"\u0001".repeat(2550)}` };
		writeFileSync(huge.path, `${[header, ...huge.native.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		seed(f.root, "a-valid", "other");
		const page = await discoverSessions(f.root);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= DISCOVERY_LIMITS.outputBytes);
		assert.equal(page.nextCursor, null);
		assert.equal(page.rows[0].sessionId, "a-valid");
		assert.match(page.coverage.skipped[0].reason, /output bound/);
	} finally { f.close(); }
});

test("metadata previews omit split Unicode pairs", async () => {
	const f = setup();
	try {
		const item = seed(f.root, "unicode", `${"a".repeat(511)}🧪${"b".repeat(4000)}`);
		const id = item.native.appendSessionInfo(`${"a".repeat(4095)}🧪`);
		appendFileSync(item.path, `${JSON.stringify(item.native.getEntry(id))}\n`);
		const page = await discoverSessions(f.root);
		assert.equal(page.rows[0].metadataPartial, true);
		assert.equal(/[\uD800-\uDFFF]/u.test(page.rows[0].name ?? ""), false);
		assert.equal(/[\uD800-\uDFFF]/u.test(page.rows[0].firstMessage ?? ""), false);
	} finally { f.close(); }
});

test("read-only lookup bounds unknown identity searches and refuses changed capture identity", () => {
	const f = setup();
	try {
		const store = new AgentStore({ sessionsRoot: f.root });
		const original = seed(store.nativeRoot, "identity", "native evidence");
		const metadata = defined(store.locateReadOnly("identity"));
		const changed = JSON.stringify({ ...original.native.getHeader(), id: "replaced" });
		writeFileSync(original.path, `${changed}\n`);
		const capture = store.readOnly(metadata);
		assert.match(defined(capture.unavailable), /identity changed/);
		assert.equal(capture.bytes, Buffer.byteLength(`${changed}\n`));
		writeFileSync(original.path, "not-a-header-private-content\n");
		const malformed = store.readOnly(metadata);
		assert.match(defined(malformed.unavailable), /malformed/);
		assert.doesNotMatch(defined(malformed.unavailable), /private-content/);
		const cancellation = new AbortController(); cancellation.abort();
		assert.throws(() => store.locateReadOnly("absent", cancellation.signal), /abort/i);
		for (let i = 0; i < DISCOVERY_LIMITS.directoryEntries; i++) writeFileSync(join(store.nativeRoot, `unrelated-${i}`), "");
		assert.throws(() => store.locateReadOnly("absent"), /directory entries/);
		assert.equal(existsSync(join(store.nativeRoot, ".claims")), false);
	} finally { f.close(); }
});

test("discovery rejects unsupported or ambiguous parameter shapes", () => {
	for (const value of [{ query: " " }, { query: "a\nb" }, { cwd: "relative" }, { limit: 0 }, { limit: 21 }, { cursor: "??" }, { fullText: true }]) assert.throws(() => validateDiscovery(value));
});
