import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EFFORT_PURPOSE_ENTRY, purposeExcerpt, retainedPurpose } from "./effort-purpose.ts";

it("keeps only bounded plain input text, without interpreting kickoff formats", () => {
	assert.equal(purposeExcerpt("  Review\n the\tparser "), "Review the parser");
	assert.equal(Array.from(purposeExcerpt("😀".repeat(300))).length, 256);
	assert.equal(purposeExcerpt("/some-command shared work"), "/some-command shared work");
});

it("restores only its own attributed interactive input record through public entry access", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Review the parser" });
	session.appendCustomEntry("other", { source: "interactive", text: "Not ours" });
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "extension", text: "Generated text" });
	session.appendMessage({ role: "user", content: "Unattributed input", timestamp: Date.now() });
	assert.deepEqual(retainedPurpose(session), { text: "Review the parser", complete: true });
	assert.deepEqual(retainedPurpose(SessionManager.inMemory()), { complete: true });
});

it("bounds the source ancestry walk rather than a materialized branch", (t) => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Original task" });
	for (let i = 0; i < 10_000; i++) session.appendCustomEntry("other", { text: "Later entry" });
	for (const name of ["getBranch", "getEntries", "getTree"] as const) t.mock.method(session, name, () => { throw new Error("Unbounded materialization is forbidden"); });
	const lookup = session.getEntry.bind(session);
	let visits = 0;
	t.mock.method(session, "getEntry", (id: string) => { visits++; return lookup(id); });
	assert.deepEqual(retainedPurpose(session), { complete: false });
	assert.equal(visits, 256);
});

it("completes an absent scan only when the visit bound reaches the root", () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 256; i++) session.appendCustomEntry("other");
	assert.deepEqual(retainedPurpose(session), { complete: true });
	session.appendCustomEntry("other");
	assert.deepEqual(retainedPurpose(session), { complete: false });
});

it("stops at a found projection or missing entry without claiming complete absence", () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 300; i++) session.appendCustomEntry("other");
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Known first input" });
	assert.deepEqual(retainedPurpose(session), { text: "Known first input", complete: true });
	assert.deepEqual(retainedPurpose({ getLeafId: () => "missing", getEntry: () => undefined }), { complete: false });
});
