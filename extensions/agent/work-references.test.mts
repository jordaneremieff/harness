import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRIMARY_WORK_REFERENCE_LIMIT } from "./primary-channel.ts";
import {
	addWorkReference,
	parseWorkReferenceEvent,
	retainedWorkReferences,
	sharedWorkReferences,
	WORK_REFERENCES_ENTRY,
} from "./work-references.ts";

it("accepts version 1 events and refuses malformed ones without throwing", () => {
	assert.deepEqual(
		parseWorkReferenceEvent({ version: 1, sessionId: "s", kind: "document", id: "md-1", title: "  A \n title " }),
		{ sessionId: "s", reference: { kind: "document", id: "md-1", title: "A title" } },
	);
	assert.deepEqual(parseWorkReferenceEvent({ version: 1, sessionId: "s", kind: "handover", id: "h", title: " " }), {
		sessionId: "s",
		reference: { kind: "handover", id: "h" },
	});
	const long = parseWorkReferenceEvent({
		version: 1,
		sessionId: "s",
		kind: "document",
		id: "d",
		title: "x".repeat(300),
	});
	assert.equal(long?.reference.title?.length, 200);
	const pair = parseWorkReferenceEvent({
		version: 1,
		sessionId: "s",
		kind: "document",
		id: "d",
		title: `${"x".repeat(199)}😀`,
	});
	assert.equal(pair?.reference.title, "x".repeat(199));
	for (const value of [
		undefined,
		"document",
		{ version: 2, sessionId: "s", kind: "document", id: "d" },
		{ version: 1, kind: "document", id: "d" },
		{ version: 1, sessionId: "s", kind: "Document", id: "d" },
		{ version: 1, sessionId: "s", kind: "document", id: "" },
		{ version: 1, sessionId: "s", kind: "document", id: "x".repeat(257) },
	])
		assert.equal(parseWorkReferenceEvent(value), undefined, JSON.stringify(value));
});

it("keeps newest distinct references and reports only new members and new titles as changes", () => {
	let state = addWorkReference([], { kind: "document", id: "a", title: "A" });
	assert.equal(state.changed, true);
	state = addWorkReference(state.list, { kind: "handover", id: "a" });
	assert.equal(state.changed, true, "kind is part of the identity");
	state = addWorkReference(state.list, { kind: "document", id: "a" });
	assert.equal(state.changed, false, "a repeat without a title keeps the known title");
	assert.deepEqual(state.list, [
		{ kind: "document", id: "a", title: "A" },
		{ kind: "handover", id: "a" },
	]);
	state = addWorkReference(state.list, { kind: "document", id: "a", title: "Renamed" });
	assert.equal(state.changed, true);
	let list = state.list;
	for (let i = 0; i < PRIMARY_WORK_REFERENCE_LIMIT; i++)
		list = addWorkReference(list, { kind: "document", id: `n${i}` }).list;
	assert.equal(list.length, PRIMARY_WORK_REFERENCE_LIMIT);
	assert.equal(list[0]?.id, `n${PRIMARY_WORK_REFERENCE_LIMIT - 1}`);
	assert.equal(
		list.some((entry) => entry.id === "a"),
		false,
	);
});

it("restores the newest retained copy on the current branch and nothing from a malformed copy", () => {
	const session = SessionManager.inMemory();
	assert.deepEqual(retainedWorkReferences(session), []);
	session.appendCustomEntry(WORK_REFERENCES_ENTRY, { refs: [{ kind: "document", id: "old" }] });
	session.appendMessage({ role: "user", content: "next", timestamp: 1 });
	session.appendCustomEntry(WORK_REFERENCES_ENTRY, {
		refs: [
			{ kind: "handover", id: "h", title: "Plan" },
			{ kind: "document", id: "old" },
		],
	});
	session.appendMessage({ role: "user", content: "later", timestamp: 2 });
	assert.deepEqual(retainedWorkReferences(session), [
		{ kind: "handover", id: "h", title: "Plan" },
		{ kind: "document", id: "old" },
	]);
	session.appendCustomEntry(WORK_REFERENCES_ENTRY, { refs: [{ kind: "BAD", id: "x" }] });
	assert.deepEqual(retainedWorkReferences(session), []);
});

it("restores a copy that lies far behind the leaf of a long branch", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(WORK_REFERENCES_ENTRY, { refs: [{ kind: "document", id: "early" }] });
	for (let index = 0; index < 6000; index++)
		session.appendMessage({ role: "user", content: `step ${index}`, timestamp: index });
	assert.deepEqual(retainedWorkReferences(session), [{ kind: "document", id: "early" }]);
});

it("matches shared items by kind and id in the other session's order", () => {
	const self = [
		{ kind: "document", id: "a" },
		{ kind: "handover", id: "b" },
	];
	assert.deepEqual(
		sharedWorkReferences(self, [
			{ kind: "handover", id: "b", title: "B" },
			{ kind: "document", id: "z" },
			{ kind: "handover", id: "a" },
			{ kind: "document", id: "a", title: "A" },
		]),
		[
			{ kind: "handover", id: "b", title: "B" },
			{ kind: "document", id: "a", title: "A" },
		],
	);
	assert.deepEqual(sharedWorkReferences(undefined, self), []);
	assert.deepEqual(sharedWorkReferences(self, []), []);
});
