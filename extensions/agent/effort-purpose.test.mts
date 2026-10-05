import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EFFORT_PURPOSE_ENTRY, firstInteractivePurpose, purposeExcerpt, retainedPurpose } from "./effort-purpose.ts";

it("keeps only bounded plain input text, without interpreting kickoff formats", () => {
	assert.equal(purposeExcerpt("  Review\n the\tparser "), "Review the parser");
	assert.equal(Array.from(purposeExcerpt("😀".repeat(300))).length, 256);
	assert.equal(purposeExcerpt("/some-command shared work"), "/some-command shared work");
});

it("restores only its own attributed first interactive record through public entry access", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Review the parser" });
	session.appendCustomEntry("other", { source: "interactive", text: "Not ours" });
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "extension", text: "Generated text" });
	session.appendMessage({ role: "user", content: "Later input", timestamp: Date.now() });
	assert.deepEqual(retainedPurpose(session), { text: "Review the parser", complete: true, canCapture: false });
	assert.deepEqual(retainedPurpose(SessionManager.inMemory()), { complete: true, canCapture: true });
});

it("bounds the source ancestry walk rather than a materialized branch", (t) => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Original task" });
	for (let i = 0; i < 10_000; i++) session.appendCustomEntry("other", { text: "Later entry" });
	for (const name of ["getBranch", "getEntries", "getTree"] as const) t.mock.method(session, name, () => { throw new Error("Unbounded materialization is forbidden"); });
	const lookup = session.getEntry.bind(session);
	let visits = 0;
	t.mock.method(session, "getEntry", (id: string) => { visits++; return lookup(id); });
	assert.deepEqual(retainedPurpose(session), { complete: false, canCapture: false });
	assert.equal(visits, 256);
});

it("proves capture eligibility only when the visit bound reaches a root without message history", () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 256; i++) session.appendCustomEntry("other");
	assert.deepEqual(retainedPurpose(session), { complete: true, canCapture: true });
	session.appendCustomEntry("other");
	assert.deepEqual(retainedPurpose(session), { complete: false, canCapture: false });
});

it("does not trust a found projection when its earlier history remains outside the proof bound", () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 300; i++) session.appendCustomEntry("other");
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Unproven first input" });
	assert.deepEqual(retainedPurpose(session), { complete: false, canCapture: false });
	assert.deepEqual(retainedPurpose({ getLeafId: () => "missing", getEntry: () => undefined }), { complete: false, canCapture: false });
});

it("never adopts a continuation or later remark after resume with ambiguous message history", () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "Original task without input attribution", timestamp: Date.now() });
	const state = retainedPurpose(session);
	assert.deepEqual(state, { complete: true, canCapture: false });
	for (const text of ["continue", "this task is taking awhile mate.", "Use a different model budget"]) {
		assert.equal(firstInteractivePurpose(state, { source: "interactive", text }), undefined);
	}
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "continue" });
	assert.deepEqual(retainedPurpose(session), { complete: true, canCapture: false });
});

it("never reopens first-input capture for explicit resume, reload or fork without attributed input", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry("setup", { text: "No input proof" });
	for (const reason of ["resume", "reload", "fork"] as const) {
		const state = retainedPurpose(session, reason);
		assert.deepEqual(state, { complete: true, canCapture: false });
		assert.equal(firstInteractivePurpose(state, { source: "interactive", text: "continue" }), undefined);
	}
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Known first input" });
	assert.deepEqual(retainedPurpose(session, "resume"), { text: "Known first input", complete: true, canCapture: false });
});

it("does not infer an absent first input from compacted history or malformed own attribution", () => {
	const compacted = SessionManager.inMemory();
	compacted.appendCompaction("Prior work", null, 10);
	assert.deepEqual(retainedPurpose(compacted), { complete: true, canCapture: false });
	compacted.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Later remark" });
	assert.deepEqual(retainedPurpose(compacted), { complete: true, canCapture: false });
	const summarized = SessionManager.inMemory();
	summarized.branchWithSummary(null, "Prior branch work");
	assert.deepEqual(retainedPurpose(summarized), { complete: true, canCapture: false });
	const malformed = SessionManager.inMemory();
	malformed.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "  " });
	assert.deepEqual(retainedPurpose(malformed), { complete: true, canCapture: false });
});

it("captures the first interactive input only and does not replace it on later inputs", () => {
	const session = SessionManager.inMemory();
	const state = retainedPurpose(session);
	for (const source of ["rpc", "extension"]) assert.equal(firstInteractivePurpose(state, { source, text: "Generated input" }), undefined);
	assert.equal(firstInteractivePurpose(state, { source: "interactive", text: "  " }), undefined);
	assert.equal(firstInteractivePurpose({ ...state, canCapture: false }, { source: "interactive", text: "After blank first input" }), undefined);
	const text = firstInteractivePurpose(state, { source: "interactive", text: "Review\n the parser" });
	assert.equal(text, "Review the parser");
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text });
	session.appendMessage({ role: "user", content: "Review the parser", timestamp: Date.now() });
	const resumed = retainedPurpose(session);
	assert.equal(firstInteractivePurpose(resumed, { source: "interactive", text: "continue" }), undefined);
	session.appendCustomEntry(EFFORT_PURPOSE_ENTRY, { source: "interactive", text: "Later input" });
	assert.equal(retainedPurpose(session).text, "Review the parser");
	assert.equal(firstInteractivePurpose({ complete: false, canCapture: true }, { source: "interactive", text: "Not proven" }), undefined);
});
