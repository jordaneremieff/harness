import assert from "node:assert/strict";
import { it } from "node:test";
import { buildLiveEntries } from "./live-frames.ts";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { AgentConversation, renderableEntries } from "./dashboard-conversation.ts";

initTheme("dark");

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

it("projects native nested slots without a synthetic assistant message or codemode call details", () => {
	const slots = [
		{ callId: "outer/c1", parentCallId: "outer", parentTaskId: 10, taskId: 11, name: "lookup", arguments: { topic: "example" }, status: "pending" },
		{ callId: "outer/c1/child", parentCallId: "outer/c1", parentTaskId: 11, taskId: 12, name: "child", arguments: {}, status: "done", summary: { isError: false, durationMs: 0 } },
	];
	const entries = buildLiveEntries({ nestedTools: slots }, []);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries.map((entry) => entry.id), ["live:tool:outer/c1", "live:tool:outer/c1/child"]);
	assert.equal(entries[0].model, undefined);
	assert.equal((entries[0].data as { nestedTool: unknown }).nestedTool, slots[0]);
	assert.deepEqual(renderableEntries(entries), entries);
	assert.deepEqual(buildLiveEntries({}, []), []);
});

for (const width of [40, 80, 120]) for (const expanded of [false, true]) it(
	`renders native nested progress at width=${width}, expanded=${expanded}`,
	(t) => {
		const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
		const starts = t.mock.method(ToolExecutionComponent.prototype, "markExecutionStarted");
		const base = { callId: "script/c1", parentCallId: "script", parentTaskId: 1, taskId: 2, name: "lookup", arguments: { topic: "example" } };
		const phases = [
			{ slot: { ...base, status: "pending" }, partial: true, starts: 0, status: /pending/u, topic: /example/u, output: "" },
			{ slot: { ...base, status: "running", arguments: { topic: "repaired" }, output: "partial output", details: { progress: 1 } }, partial: true, starts: 1, status: /running/u, topic: /repaired/u, output: "partial output" },
			{ slot: { ...base, status: "done", summary: { isError: true, durationMs: 4, error: "rejected" } }, partial: false, starts: 1, status: /error 4ms/u, topic: /example/u, output: "rejected" },
		];
		const conversation = new AgentConversation([], "/work", { requestRender() {} } as TUI, expanded, false, undefined, undefined, () => ({
			renderCall: (args) => new Text(`lookup ${JSON.stringify(args)}`),
			renderResult: (result) => new Text(result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")),
		}));
		let instance: unknown;
		for (const phase of phases) {
			const before = starts.mock.calls.length;
			conversation.update(buildLiveEntries({ nestedTools: [phase.slot] }, []));
			const update = updates.mock.calls.at(-1); assert.ok(update);
			instance ??= update.this;
			assert.equal(update.this, instance);
			assert.equal(update.arguments[1], phase.partial);
			assert.equal(starts.mock.calls.length - before, phase.starts);
			assert.deepEqual((update.arguments[0] as { details?: unknown }).details, "details" in phase.slot ? phase.slot.details : undefined);
			const text = stripVTControlCharacters(conversation.render(width).lines.join("\n"));
			assert.match(text, /Nested tool script\/c1 under script:/u);
			assert.match(text, phase.status);
			assert.match(text, phase.topic);
			assert.ok(text.includes(phase.output));
			assert.doesNotMatch(text, /\$/u);
		}
		conversation.update([]);
		assert.deepEqual(conversation.render(width).lines, []);
		assert.equal(updates.mock.calls.at(-1)?.this, instance);
	},
);

it("releases native nested renderer timers when a running slot disappears", (t) => {
	const intervals = t.mock.method(globalThis, "setInterval");
	const clears = t.mock.method(globalThis, "clearInterval");
	const slot = { callId: "parent/key", parentCallId: "parent", parentTaskId: 1, taskId: 2, name: "bash", arguments: { command: "echo synthetic" }, status: "running", output: "partial" };
	const conversation = new AgentConversation(buildLiveEntries({ nestedTools: [slot] }, []), "/work", { requestRender() {} } as TUI, false, false);
	try {
		conversation.render(80);
		assert.equal(intervals.mock.calls.length, 1);
		conversation.update([]);
		assert.equal(clears.mock.calls.length, 1);
		assert.equal(clears.mock.calls[0].arguments[0], intervals.mock.calls[0].result);
		assert.deepEqual(conversation.render(80).lines, []);
	} finally {
		conversation.update([]);
		for (const call of intervals.mock.calls) clearInterval(call.result);
	}
});

it("shows a nested completion without a summary as unavailable, not success", () => {
	const conversation = new AgentConversation(buildLiveEntries({ nestedTools: [{ callId: "parent/key", parentCallId: "parent", name: "lookup", arguments: {}, parentTaskId: 1, taskId: 2, status: "done" }] }, []), "/work", { requestRender() {} } as TUI, false, false);
	assert.match(stripVTControlCharacters(conversation.render(80).lines.join("\n")), /done \(result unavailable\)/u);
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
