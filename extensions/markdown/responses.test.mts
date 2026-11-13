import assert from "node:assert/strict";
import { test } from "node:test";
import { hostname } from "node:os";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { completeness, recentOrdinary, readOrdinary, responseSnapshot, responseText, SOURCE_BYTES, type OrdinarySource } from "./responses.ts";

function fixture() {
	const message = (id: string, parentId: string | null, text: string): SessionEntry => ({ type: "message", id, parentId, timestamp: "2026-01-01", message: fauxAssistantMessage(text, { timestamp: 1760000000000 }) });
	const entries = new Map<string, SessionEntry>([
		["a", message("a", null, "Substantial response")], ["b", message("b", "a", "Sibling response")], ["c", message("c", "a", "Acknowledged")],
		["u", { type: "message", id: "u", parentId: "c", timestamp: "2026-01-01", message: { role: "user", content: "next", timestamp: 1 } }],
		["t", { type: "message", id: "t", parentId: "u", timestamp: "2026-01-01", message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: 1 } }],
	]);
	let leafReads = 0;
	let visits = 0;
	const source: OrdinarySource = { getEntry: (id) => { visits++; return entries.get(id); }, getLeafId: () => { leafReads++; return "t"; }, getSessionId: () => "synthetic", getCwd: () => "/project" };
	return { source, leafReads: () => leafReads, visits: () => visits };
}
test("ordinary ancestry excludes siblings and skips user and tool leaves", () => {
	const f = fixture();
	const recent = recentOrdinary(f.source);
	assert.deepEqual(recent.rows.map((row) => row.entryId), ["c", "a"]);
	assert.equal(f.leafReads(), 1);
	assert.equal(recent.rows[0].timestamp, 1760000000000);
	assert.equal(f.visits(), 4);
	assert.equal(readOrdinary(f.source, "a", recent.cutoff).provenance.host, hostname());
	assert.equal(responseText(readOrdinary(f.source, "a", recent.cutoff)), "Substantial response");
	assert.throws(() => readOrdinary(f.source, "b", recent.cutoff), /not visible/u);
	assert.equal(recentOrdinary(f.source, { leaf: "u" }).rows[0].entryId, "c");
});
test("ordinary ancestry lists retained responses before and after compaction, not the compaction summary", () => {
	const before: SessionEntry = { type: "message", id: "before", parentId: null, timestamp: "2026-01-01", message: fauxAssistantMessage("Before compaction") };
	const compaction: SessionEntry = { type: "compaction", id: "compaction", parentId: "before", timestamp: "2026-01-01", summary: "A context summary, not an assistant response", firstKeptEntryId: "before", tokensBefore: 1000 };
	const after: SessionEntry = { type: "message", id: "after", parentId: "compaction", timestamp: "2026-01-01", message: fauxAssistantMessage("After compaction") };
	const entries = new Map([before, compaction, after].map((entry) => [entry.id, entry]));
	const source: OrdinarySource = { getEntry: (id) => entries.get(id), getLeafId: () => "after", getSessionId: () => "synthetic", getCwd: () => "/project" };
	const recent = recentOrdinary(source);
	assert.deepEqual(recent.rows.map((row) => row.entryId), ["after", "before"]);
	assert.equal(recent.visited, 3);
	assert.equal(recent.stop, "end");
	assert.equal(responseText(readOrdinary(source, "before", recent.cutoff)), "Before compaction");
	assert.equal(responseText(readOrdinary(source, "after", recent.cutoff)), "After compaction");
});
test("an ordinary response after list capture is not readable through that captured cutoff", () => {
	const first: SessionEntry = { type: "message", id: "first", parentId: null, timestamp: "2026-01-01", message: fauxAssistantMessage("Listed response") };
	const entries = new Map([[first.id, first]]);
	let leaf = first.id;
	const source: OrdinarySource = { getEntry: (id) => entries.get(id), getLeafId: () => leaf, getSessionId: () => "synthetic", getCwd: () => "/project" };
	const recent = recentOrdinary(source);
	const later: SessionEntry = { type: "message", id: "later", parentId: leaf, timestamp: "2026-01-01", message: fauxAssistantMessage("Arrived after capture") };
	entries.set(later.id, later);
	leaf = later.id;
	assert.deepEqual(recent.rows.map((row) => row.entryId), ["first"]);
	assert.throws(() => readOrdinary(source, later.id, recent.cutoff), /not visible/u);
	assert.equal(responseText(readOrdinary(source, later.id, leaf)), "Arrived after capture");
});
test("ordinary visit and result stops report their coverage", () => {
	const f = fixture();
	assert.equal(recentOrdinary(f.source, { visits: 2 }).stop, "visits");
	assert.equal(recentOrdinary(f.source, { results: 1 }).stop, "results");
	assert.equal(recentOrdinary(f.source, { leaf: "missing" }).stop, "missing");
});
test("text parts retain order and whitespace without reasoning or tool calls", () => {
	const message = fauxAssistantMessage("unused");
	message.content = [{ type: "text", text: "  first\n" }, { type: "thinking", thinking: "private" }, { type: "text", text: " \n" }, { type: "toolCall", id: "call", name: "tool", arguments: {} }, { type: "text", text: "second 😀" }];
	const response = responseSnapshot(message, "entry", { kind: "ordinary-response", session: "s" });
	assert.ok(response);
	assert.deepEqual(response.parts, ["  first\n", "second 😀"]);
	assert.equal(responseText(response), "  first\n\n\nsecond 😀");
	assert.deepEqual(response.provenance.parts, [{ chars: 8 }, { chars: 9 }]);
	message.content = [{ type: "text", text: " \t" }];
	assert.equal(responseSnapshot(message, "entry", { kind: "ordinary-response" }), undefined);
});
test("every public stop reason states completeness without task acceptance", () => {
	for (const stop of ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]) {
		assert.equal(completeness(stop).state, stop === "stop" || stop === "toolUse" ? "complete" : "partial");
	}
	assert.equal(completeness("toolUse").reason, "tool-use");
	assert.match(completeness("future").note ?? "", /future/u);
});
test("over-limit source is refused, never silently cut", () => {
	const response = responseSnapshot(fauxAssistantMessage("x".repeat(SOURCE_BYTES + 1)), "e", { kind: "ordinary-response" });
	assert.ok(response);
	assert.throws(() => responseText(response), /exceeds/u);
});
