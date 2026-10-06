import assert from "node:assert/strict";
import { it } from "node:test";
import { buildLiveEntries } from "./live-frames.ts";

it("forwards live tool details into the result message even before output arrives", () => {
	const details = { progress: { phase: "working", value: 1 } };
	const entries = buildLiveEntries({ tools: [{ callId: "call", name: "custom", status: "running", details }] }, []);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, "live:tool:call");
	const message = entries[0].model?.[0];
	assert.ok(message?.role === "toolResult");
	assert.equal(message.details, details);
	assert.deepEqual(message.content, []);
});

it("keeps partial output and omits empty or committed live slots", () => {
	const entries = buildLiveEntries({ tools: [
		{ callId: "output", name: "custom", status: "running", output: "partial text" },
		{ callId: "empty", name: "custom", status: "running" },
		{ callId: "done", name: "custom", status: "done", details: { progress: 1 } },
		{ callId: "committed", name: "custom", status: "running", entry: 10, details: { progress: 1 } },
	] }, []);
	assert.equal(entries.length, 1);
	const message = entries[0].model?.[0];
	assert.ok(message?.role === "toolResult");
	assert.deepEqual(message.content, [{ type: "text", text: "partial text" }]);
	assert.equal(message.details, undefined);
});
