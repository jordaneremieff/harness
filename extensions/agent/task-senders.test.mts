import assert from "node:assert/strict";
import { it } from "node:test";
import { boundTaskSenders, parseTaskInputSender, parseTaskSenderRecord, taskInputSender, TASK_SENDER_PAGE_BYTES, TASK_SENDER_PAGE_ENTRIES } from "./task-senders.ts";

const identity = "00000000-0000-4000-8000-000000000001";
it("checks requester identities and omits unavailable names without inventing a sender", () => {
	assert.deepEqual(taskInputSender(identity, "Peer"), { identity, name: "Peer" });
	assert.deepEqual(taskInputSender(identity, "bad\nname"), { identity });
	assert.equal(taskInputSender("@peer", "Peer"), undefined);
	assert.equal(parseTaskInputSender({ identity, name: "\ud800" }), undefined);
	assert.equal(parseTaskInputSender({ identity, owner: "not a sender" }), undefined);
});
it("keeps exact native target and capture facts in the immutable sender record", () => {
	const target = { mode: "input", storageId: identity, conversationId: 2, entryId: "41", submissionId: 7, requestId: "task" };
	const value = { format: "agent.task-sender/1", target, sender: { identity }, recordedAt: 17 };
	assert.deepEqual(parseTaskSenderRecord(value), value);
	assert.equal(parseTaskSenderRecord({ ...value, recordedAt: -1 }), undefined);
	assert.equal(parseTaskSenderRecord({ ...value, target: { ...target, mode: "passive" } }), undefined);
});
it("bounds sender hints separately by entry count and serialized bytes", () => {
	const values = Array.from({ length: TASK_SENDER_PAGE_ENTRIES + 1 }, (_, index) => [String(index + 1), { identity }] as const);
	assert.equal(Object.keys(boundTaskSenders(values) ?? {}).length, TASK_SENDER_PAGE_ENTRIES);
	const large = values.map(([entryId]) => [entryId, { identity: `${identity}:${Number.MAX_SAFE_INTEGER}`, name: "x".repeat(160) }] as const);
	const bounded = boundTaskSenders(large);
	assert.ok(bounded);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= TASK_SENDER_PAGE_BYTES);
	assert.ok(Object.keys(bounded).length < TASK_SENDER_PAGE_ENTRIES);
	assert.equal(boundTaskSenders([]), undefined);
});
