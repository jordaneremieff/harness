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

it("waits for a deferred waking send, and sends again without waking once a settlement shows it failed", (t) => {
	const f = fixture(t);
	let failed = 0;
	const now = 0;
	const inbox = new PrimaryInbox(f.session, {
		idle: () => true,
		startFailed: () => failed++,
		now: () => now,
		checkMs: 3_600_000,
		deferredMs: 60_000,
	});
	t.after(() => inbox.close());
	inbox.admit("question:a:1", "Ready?", {});
	const sends: Array<[string, boolean]> = [];
	const send = (row: { sourceId: string }, wake: boolean) => sends.push([row.sourceId, wake]);
	// The session stayed idle after the send: Pi deferred it until the settlement hooks finish.
	inbox.flush(send);
	inbox.flush(send);
	assert.deepEqual(sends, [["question:a:1", true]], "a deferred send is not repeated");
	assert.equal(failed, 0);
	inbox.settled();
	inbox.flush(send);
	assert.equal(failed, 1, "a later settlement without the message shows that the send never started");
	inbox.flush(send, false);
	assert.deepEqual(sends.at(-1), ["question:a:1", false]);
});

it("counts a waking send whose run began and left no message as failed", (t) => {
	const f = fixture(t);
	let failed = 0;
	let idle = false;
	const inbox = new PrimaryInbox(f.session, {
		idle: () => idle,
		startFailed: () => failed++,
		checkMs: 3_600_000,
	});
	t.after(() => inbox.close());
	inbox.admit("question:a:2", "Ready?", {});
	inbox.flush(() => {});
	idle = true;
	inbox.flush(() => {});
	assert.equal(failed, 1, "Pi began the run, so an idle session without the message failed to start it");
});

it("keeps a waking send whose message the session retained", (t) => {
	const f = fixture(t);
	let failed = 0;
	let idle = false;
	const inbox = new PrimaryInbox(f.session, { idle: () => idle, startFailed: () => failed++, checkMs: 3_600_000 });
	t.after(() => inbox.close());
	inbox.admit("question:a:3", "Ready?", {});
	inbox.flush((row) => {
		f.session.appendCustomMessageEntry("agent.peer", row.text, true, row.details);
	});
	idle = true;
	inbox.flush(() => assert.fail("a retained row is not sent again"));
	assert.equal(failed, 0);
	assert.equal(inbox.hasRows(), false);
});
