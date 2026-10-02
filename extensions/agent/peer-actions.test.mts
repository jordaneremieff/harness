import assert from "node:assert/strict";
import { it } from "node:test";
import { classifySubmit, committedEntryChoices, otherSide, parseLocalCommand, placeBeside, placementForNew, slotOf } from "./peer-actions.ts";
import { createPeerWindowState, paneState, peerKey } from "./peer-contract.ts";

it("keeps local commands in the window and hands other slash text to native Pi", () => {
	assert.deepEqual(classifySubmit(""), { kind: "empty" });
	assert.deepEqual(classifySubmit("  "), { kind: "empty" });
	assert.deepEqual(classifySubmit("plain text"), { kind: "plain", text: "plain text" });
	assert.deepEqual(classifySubmit("/focus agent"), { kind: "local", command: { name: "focus", args: ["agent"] } });
	assert.deepEqual(classifySubmit("/Model"), { kind: "handoff", text: "/Model" });
	assert.deepEqual(classifySubmit("/model"), { kind: "handoff", text: "/model" });
	assert.deepEqual(classifySubmit("/template-one arg"), { kind: "handoff", text: "/template-one arg" });
	assert.deepEqual(classifySubmit("/unknown"), { kind: "handoff", text: "/unknown" });
	assert.deepEqual(classifySubmit("/refresh"), { kind: "local", command: { name: "refresh", args: [] } });
	assert.deepEqual(classifySubmit("/tasks"), { kind: "local", command: { name: "tasks", args: [] } });
	assert.equal(parseLocalCommand("hello"), undefined);
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

it("lists committed decisions newest first and skips blocks without visible text", () => {
	const entries = [
		{ id: "e1", kind: "pi.user", model: [{ role: "user" as const, content: "first task", timestamp: 1 }] },
		{ id: "e2", kind: "pi.assistant", model: [{ role: "assistant" as const, api: "openai-completions" as const, provider: "p", model: "m", content: [{ type: "toolCall" as const, id: "c1", name: "bash", arguments: {} }], stopReason: "toolUse" as const, timestamp: 2, usage }] },
		{ id: "e3", kind: "pi.assistant", model: [{ role: "assistant" as const, api: "openai-completions" as const, provider: "p", model: "m", content: [{ type: "text" as const, text: "the answer" }], stopReason: "stop" as const, timestamp: 3, usage }] },
	];
	const choices = committedEntryChoices(entries);
	assert.deepEqual(choices.map((choice) => choice.value), ["e3", "e1"]);
	assert.match(choices[0].label, /^Agent: the answer/);
	assert.match(choices[1].label, /^You: first task/);
});

it("places a peer beside its source and reuses an already visible pane", () => {
	const state = createPeerWindowState();
	assert.equal(slotOf(state, "primary"), "left");
	assert.equal(slotOf(state, "agent:a"), undefined);
	const target = { kind: "agent" as const, id: "a" };
	assert.equal(placeBeside(state, "left", target), "right");
	assert.deepEqual(state.right, target);
	assert.equal(placementForNew(state), "right", "a full window places a new peer opposite the focused side");
	assert.equal(otherSide("left"), "right");
	const reopened = createPeerWindowState();
	reopened.left = undefined;
	reopened.right = target;
	reopened.focus = "right";
	assert.equal(placementForNew(reopened), "left");
	assert.equal(peerKey(target), "agent:a");
	assert.equal(peerKey({ kind: "primary" }), "primary");
	const defaults = paneState(createPeerWindowState(), "agent:a");
	assert.equal(defaults.view.follow, true);
	assert.equal(defaults.draft, "");
	assert.equal(defaults.mode, "auto");
});
