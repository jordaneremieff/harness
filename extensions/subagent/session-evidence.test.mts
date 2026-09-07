import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type AgentSession,
	type AgentSessionEvent,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { transcriptFromMessages, WorkerRuntime } from "./runtime.ts";
import { type EntryReader, readSelectedSession, selectedEntries } from "./session-evidence.ts";

const id = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-07T00:00:00.000Z";
const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: process.cwd() };
function withFile(body: string, run: (path: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "session-evidence-test-"));
	const path = join(dir, "session.jsonl");
	try {
		writeFileSync(path, body);
		run(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
function content(...entries: unknown[]) {
	return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
function entry(id: string, parentId: string | null = null): SessionEntry {
	return { type: "custom_message", id, parentId, timestamp, customType: "example", content: "body", display: true };
}

test("selected file uses the public current-format parser and active ancestry without source mutation", () => {
	const first = entry("first");
	const unused = entry("unused", "first");
	const selected = entry("selected", "first");
	withFile(content(first, unused, selected), (path) => {
		const before = readFileSync(path);
		const snapshot = readSelectedSession(path, id);
		assert.deepEqual(
			snapshot.entries.map((entry) => entry.id),
			["first", "selected"],
		);
		assert.deepEqual(snapshot.notices, []);
		assert.deepEqual(readFileSync(path), before);
		assert.equal(snapshot.bytes, before.length);
	});
});

test("size cap rejects before reading bytes or invoking the public parser", (t) => {
	withFile(content(entry("one")), (path) => {
		let reads = 0;
		const original = fs.readSync;
		const mock = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
			reads++;
			return original(...args);
		});
		syncBuiltinESMExports();
		try {
			const snapshot = readSelectedSession(path, id, 1);
			assert.equal(reads, 0);
			assert.equal(snapshot.bytes, 0);
			assert.match(snapshot.notices.join("\n"), /exceeds the 1-byte/);
		} finally {
			mock.mock.restore();
			syncBuiltinESMExports();
		}
	});
});

test("malformed and unterminated input yields explicit notices and never repairs source bytes", () => {
	for (const body of [
		`${content(entry("one"))}{bad}\n`,
		content(entry("one")).trimEnd(),
		"",
		content(null),
		content({ ...entry("one"), parentId: "missing" }),
	]) {
		withFile(body, (path) => {
			const before = readFileSync(path);
			const result = readSelectedSession(path, id);
			assert.equal(result.entries.length, 0);
			assert.equal(result.notices.length, 1);
			assert.deepEqual(readFileSync(path), before);
		});
	}
});

test("old versions, identity mismatch, duplicate IDs, and unknown entry types are rejected", () => {
	const bodies = [
		`${JSON.stringify({ ...header, version: CURRENT_SESSION_VERSION - 1 })}\n`,
		`${JSON.stringify({ ...header, id: "other" })}\n`,
		content(entry("one"), entry("one")),
		content({ ...entry("one"), type: "unknown" }),
	];
	for (const body of bodies) withFile(body, (path) => assert.equal(readSelectedSession(path, id).entries.length, 0));
});

test("missing paths and non-regular files return unavailable notices", () => {
	const dir = mkdtempSync(join(tmpdir(), "session-evidence-test-"));
	try {
		assert.match(readSelectedSession(dir, id).notices.join("\n"), /not a regular file/);
		assert.match(readSelectedSession(join(dir, "absent"), id).notices.join("\n"), /ENOENT/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fixed descriptor snapshot rejects a concurrent truncation", (t) => {
	withFile(content(entry("one")), (path) => {
		const original = fs.readSync;
		let reads = 0;
		const mock = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
			if (reads++ === 0) writeFileSync(path, "");
			return original(...args);
		});
		syncBuiltinESMExports();
		try {
			assert.match(readSelectedSession(path, id).notices.join("\n"), /truncated during the read/);
		} finally {
			mock.mock.restore();
			syncBuiltinESMExports();
		}
	});
});

test("bounded live ancestry reports cycles, missing entries, and visit limits", () => {
	let visits = 0;
	const entries = new Map([
		["one", entry("one", "two")],
		["two", entry("two", "one")],
	]);
	const source: EntryReader = {
		getSessionId: () => id,
		getLeafId: () => "one",
		getEntry: (id) => {
			visits++;
			return entries.get(id);
		},
	};
	assert.match(selectedEntries(source).notices.join("\n"), /cycle/);
	assert.equal(visits, 2);
	entries.delete("two");
	assert.match(selectedEntries(source).notices.join("\n"), /incomplete/);
	entries.set("two", entry("two", "three"));
	visits = 0;
	assert.match(selectedEntries(source, 1).notices.join("\n"), /1-entry limit/);
	assert.equal(visits, 1);
});

test("generic custom messages survive the same transcript conversion for live and retained entries", () => {
	const manager = SessionManager.inMemory(process.cwd(), { id });
	manager.appendCustomMessageEntry("example", "custom body", true, { label: "detail" });
	const snapshot = selectedEntries(manager);
	const messages = snapshot.entries.flatMap(sessionEntryToContextMessages);
	const transcript = transcriptFromMessages(messages);
	assert.equal(transcript[0].role, "custom");
	if (transcript[0].role !== "custom") assert.fail("custom item is absent");
	assert.equal(transcript[0].customType, "example");
	assert.deepEqual(transcript[0].content, [{ type: "text", text: "custom body" }]);
	assert.deepEqual(transcript[0].details, { label: "detail" });
	withFile(content(...snapshot.entries), (path) => {
		const retained = transcriptFromMessages(
			readSelectedSession(path, id).entries.flatMap(sessionEntryToContextMessages),
		);
		assert.deepEqual(retained, transcript);
	});
});

test("custom message completion notifies live transcript observers", () => {
	let emit: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			emit = listener;
			return () => {};
		},
	} as unknown as AgentSession;
	const runtime = new WorkerRuntime({ session, id: "worker", name: "Worker", cwd: process.cwd(), createdAt: 1 });
	let snapshots = 0;
	runtime.watch(() => snapshots++);
	emit?.({
		type: "message_end",
		message: { role: "custom", customType: "example", content: "body", display: true, timestamp: 1 },
	});
	assert.equal(snapshots, 1);
	runtime.shutdown();
});

test("current non-content session message roles remain valid inputs", () => {
	withFile(
		content({
			type: "message",
			id: "one",
			parentId: null,
			timestamp,
			message: { role: "bashExecution", command: "true", output: "", timestamp: 1 },
		}),
		(path) => {
			assert.deepEqual(readSelectedSession(path, id).notices, []);
		},
	);
});
