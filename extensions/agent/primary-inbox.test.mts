import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PrimaryInbox } from "./primary-inbox.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "agent-primary-inbox-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const session = SessionManager.create(root, root);
	session.appendMessage({ role: "user", content: "Saved start", timestamp: Date.now() });
	const file = session.getSessionFile();
	assert.ok(file);
	return { session, file, inbox: new PrimaryInbox(session), snapshot: `${file}.agent-inbox` };
}

it("refuses a full inbox without evicting any admitted notice", (t) => {
	const f = fixture(t);
	assert.throws(() => f.inbox.admit("oversized", "x".repeat(1024 * 1024), {}), /inbox is full/u);
	assert.equal(existsSync(f.snapshot), false);
	const ids = Array.from({ length: 128 }, (_, i) => `source:${i}`);
	for (const id of ids) f.inbox.admit(id, id, { wake: false });
	const original = readFileSync(f.snapshot, "utf8");
	assert.throws(() => f.inbox.admit("overflow", "overflow", {}), /inbox is full/u);
	f.inbox.admit("source:0", "duplicate", {});
	assert.equal(readFileSync(f.snapshot, "utf8"), original);
	const replay = new PrimaryInbox(SessionManager.open(f.file));
	assert.deepEqual(
		replay.boundary()?.entries.map((entry) => entry.content),
		ids,
	);
	assert.equal(replay.boundary()?.continue, false);
});

it("refuses an unwritable replacement without admitting the new row", (t) => {
	const f = fixture(t);
	f.inbox.admit("prior", "prior", {});
	mkdirSync(`${f.snapshot}.new`);
	assert.throws(() => f.inbox.admit("new", "new", {}), /EISDIR/u);
	assert.deepEqual(
		new PrimaryInbox(SessionManager.open(f.file)).boundary()?.entries.map((entry) => entry.content),
		["prior"],
	);
});

it("refuses another session's snapshot without overwriting it", (t) => {
	const f = fixture(t);
	const foreign = JSON.stringify({ version: 1, sessionId: "different", rows: [] });
	writeFileSync(f.snapshot, foreign);
	assert.throws(() => f.inbox.admit("source", "notice", {}), /invalid header/u);
	assert.equal(readFileSync(f.snapshot, "utf8"), foreign);
});
