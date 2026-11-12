import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { projectNativeContinuity, projectOrdinaryContinuity } from "./continuity-projection.ts";

const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const system: Message = { role: "system", content: "baseline", timestamp: 0 };
const head = (id: number, model: readonly Message[] = [user("summary")]): Pick<EntryRecord, "id" | "model"> => ({ id: id as EntryId, model });
function afterAnchor(messages: readonly Message[], anchor: Message, text: string): Message[] {
	const index = messages.indexOf(anchor);
	assert.ok(index >= 0);
	return [...messages.slice(0, index + 1), user(text), ...messages.slice(index + 1)];
}

it("projects at s+k for a summary and for an empty reset with or without a system baseline", () => {
	for (const baseline of [[], [system]]) for (const model of [[], [user("summary")]]) {
		const messages = [...baseline, ...model, user("tail")];
		const projected = projectNativeContinuity(messages, head(2, model), "facts");
		assert.equal(projected.mismatch, undefined);
		assert.equal(projected.messages[baseline.length + model.length].content, "facts");
		assert.deepEqual(messages, [...baseline, ...model, user("tail")]);
	}
});

it("uses supplied entry identity even when two reset heads have identical text", () => {
	const first = projectNativeContinuity([system, user("same")], head(1, [user("same")]), "head 1");
	const second = projectNativeContinuity([system, user("same")], head(2, [user("same")]), "head 2");
	assert.equal(first.messages[2].content, "head 1");
	assert.equal(second.messages[2].content, "head 2");
	const empty = projectNativeContinuity([system, user("tail")], head(3, []), "head 3");
	assert.equal(empty.messages[1].content, "head 3");
});

it("reports a consistency mismatch at messages[s], without a fake dispatch-stop guarantee", () => {
	assert.equal(projectNativeContinuity([system, user("other")], head(1), "facts").mismatch, "head-message");
	assert.equal(projectNativeContinuity([user("summary"), user("tail")], head(1), "facts").mismatch, undefined);
	assert.equal(projectNativeContinuity([system], head(1, [user("a"), user("b")]), "facts").mismatch, "head-shape");
});

it("keeps exact prefixes after independent hooks at the same anchor in either order", () => {
	const summary = user("summary"), next = user("next"), earlier = user("earlier");
	const project = (messages: readonly Message[], continuityFirst: boolean) => {
		let value = [...messages];
		if (continuityFirst) value = projectNativeContinuity(value, head(7, [summary]), "frozen facts").messages;
		value = afterAnchor(value, summary, "independent note");
		if (!continuityFirst) value = projectNativeContinuity(value, head(7, [summary]), "frozen facts").messages;
		return value;
	};
	for (const continuityFirst of [true, false]) {
		const first = project([system, summary, earlier], continuityFirst);
		const second = project([system, summary, earlier, next], continuityFirst);
		assert.deepEqual(second.slice(0, first.length), first);
		assert.equal(first[continuityFirst ? 3 : 2].content, "frozen facts");
	}
});

it("keeps the first empty-reset final-answer request and its next request prefix identical", () => {
	const first = projectNativeContinuity([system], head(8, []), "head 8 facts").messages;
	const second = projectNativeContinuity([system, user("later")], head(8, []), "head 8 facts").messages;
	assert.deepEqual(second.slice(0, first.length), first);
	assert.equal(first.at(-1)?.content, "head 8 facts");
});

it("projects ordinary summaries without deriving head identity from duplicate summary text", () => {
	const summary: AgentMessage = { role: "compactionSummary", summary: "same", tokensBefore: 5, timestamp: 1 };
	const first = projectOrdinaryContinuity([summary, user("input")], { id: "a", summary: "same" }, "head a");
	const second = projectOrdinaryContinuity([summary, user("input"), user("later")], { id: "a", summary: "same" }, "head a");
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.deepEqual(projectOrdinaryContinuity([summary], { id: "b", summary: "same" }, "head b").messages[1], { role: "user", content: "head b", timestamp: 0 });
	assert.equal(projectOrdinaryContinuity([summary], { id: "c", summary: "different" }, "facts").mismatch, "head-message");
	assert.equal(projectOrdinaryContinuity([], { id: "c", summary: "same" }, "facts").mismatch, "missing-summary");
});
