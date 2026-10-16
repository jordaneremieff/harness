import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PrimaryRetention } from "./primary-retention.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "primary-retention-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const session = SessionManager.create(root, root);
	session.appendMessage({ role: "user", content: "Seed", timestamp: 0 });
	const path = session.getSessionFile(); assert.ok(path);
	return { session, path };
}

it("continues bounded verification after settlement without enqueueing a retained notice again", (t) => {
	const f = fixture(t);
	f.session.appendCustomEntry("large-evidence", { text: "x".repeat(2 * 1024 * 1024) });
	f.session.appendCustomMessageEntry("agent.peer", "Retained notice", true, { sourceId: "retained" });
	let sends = 0;
	const retention = new PrimaryRetention(f.session, () => true, () => { sends++; });
	assert.throws(() => retention.deliver("retained", "Retained notice", {}), /verification/u);
	retention.settled();
	assert.throws(() => retention.deliver("retained", "Retained notice", {}), /verification/u);
	retention.deliver("retained", "Retained notice", {});
	assert.equal(sends, 0);
});

for (const malformed of ["header", "tail"] as const) it(`refuses ${malformed} corruption without sending or confirming a notice`, (t) => {
	const f = fixture(t);
	f.session.appendCustomMessageEntry("agent.peer", "Notice", true, { sourceId: "notice" });
	const original = readFileSync(f.path, "utf8"), lines = original.trimEnd().split("\n");
	if (malformed === "header") lines[0] = JSON.stringify({ type: "session", id: "another-session" });
	writeFileSync(f.path, `${lines.join("\n")}\n${malformed === "tail" ? "{partial" : ""}`);
	const retention = new PrimaryRetention(f.session, () => true, () => assert.fail("malformed files must not admit another attempt"));
	assert.throws(() => retention.deliver("notice", "Notice", {}));
});

it("does not confirm changed target contents from its matching in-memory source identity", (t) => {
	const f = fixture(t);
	f.session.appendCustomMessageEntry("agent.peer", "Original notice", true, { sourceId: "notice" });
	const lines = readFileSync(f.path, "utf8").trimEnd().split("\n");
	const changed = JSON.parse(lines[lines.length - 1]); changed.content = "Changed notice";
	lines[lines.length - 1] = JSON.stringify(changed); writeFileSync(f.path, `${lines.join("\n")}\n`);
	let attempts = 0;
	const retention = new PrimaryRetention(f.session, () => true, () => { attempts++; });
	assert.throws(() => retention.deliver("notice", "Original notice", {}), /awaits a retained/u);
	assert.equal(attempts, 1, "a retry still requires its own exact retained record");
});

it("streams past a valid oversized historical record before confirming a resumed notice", (t) => {
	const f = fixture(t);
	f.session.appendCustomEntry("large-image-evidence", { text: "x".repeat(33 * 1024 * 1024) });
	f.session.appendCustomMessageEntry("agent.peer", "Retained notice", true, { sourceId: "retained" });
	const retention = new PrimaryRetention(f.session, () => true, () => assert.fail("resumed history must not enqueue another notice"));
	let confirmed = false;
	for (let scan = 0; scan < 35 && !confirmed; scan++) {
		try { retention.deliver("retained", "Retained notice", {}); confirmed = true; }
		catch (error) { assert.match(String(error), /awaits retained-entry verification/u); }
	}
	assert.equal(confirmed, true);
});

it("retries an incomplete target tail without committing partial comparison state", (t) => {
	const f = fixture(t);
	f.session.appendCustomMessageEntry("agent.peer", "Notice", true, { sourceId: "notice" });
	const original = readFileSync(f.path, "utf8"), start = original.lastIndexOf("\n", original.length - 2) + 1;
	const cut = start + Math.floor((original.length - start) / 2);
	writeFileSync(f.path, original.slice(0, cut));
	const retention = new PrimaryRetention(f.session, () => true, () => assert.fail("a completed retained target must not enqueue again"));
	assert.throws(() => retention.deliver("notice", "Notice", {}), /tail is incomplete/u);
	appendFileSync(f.path, original.slice(cut));
	retention.deliver("notice", "Notice", {});
});

it("refuses file replacement during a bounded verification", (t) => {
	const f = fixture(t);
	f.session.appendCustomEntry("large-evidence", { text: "x".repeat(2 * 1024 * 1024) });
	f.session.appendCustomMessageEntry("agent.peer", "Notice", true, { sourceId: "notice" });
	const retention = new PrimaryRetention(f.session, () => true, () => assert.fail("a changed file must not admit another attempt"));
	assert.throws(() => retention.deliver("notice", "Notice", {}), /verification/u);
	const original = readFileSync(f.path);
	rmSync(f.path); writeFileSync(f.path, original);
	assert.throws(() => retention.deliver("notice", "Notice", {}), /changed outside append/u);
});
