import assert from "node:assert/strict";
import { it } from "node:test";
import { admittedResult } from "./result-reference.ts";

it("retains the exact admitted submission and known request identity", () => {
	assert.deepEqual(admittedResult("store:2", { submissionId: 7, conversationId: 2 }, "request"), { sessionId: "store:2", submissionId: 7, requestId: "request" });
	assert.deepEqual(admittedResult("store:2", { submissionId: 7, requestId: "peer" }), { sessionId: "store:2", submissionId: 7, requestId: "peer" });
	assert.deepEqual(admittedResult("store:2", { submissionId: 7 }), { sessionId: "store:2", submissionId: 7 });
	assert.deepEqual(admittedResult("store", { submissionId: 7, result: { sessionId: "store", submissionId: 7, requestId: "nested" } }), { sessionId: "store", submissionId: 7, requestId: "nested" });
	assert.throws(() => admittedResult("store", { submissionId: 7, conversationId: 2 }), /disagree/u);
});

it("emits the canonical root identity for the current numeric root selector", () => {
	assert.deepEqual(admittedResult("store:1", { submissionId: 7, identity: "store", conversationId: 1 }), { sessionId: "store", submissionId: 7 });
});

it("rejects disagreements across every returned admission identity", () => {
	for (const row of [
		{ submissionId: 7, requestId: "different" },
		{ submissionId: 7, conversationId: 3 },
		{ submissionId: 7, identity: "other:2" },
		{ submissionId: 7, sessionId: "other:2" },
		{ submissionId: 7, result: { sessionId: "store:2", submissionId: 8, requestId: "request" } },
		{ submissionId: 7, result: { sessionId: "store:2", submissionId: 7, requestId: "different" } },
	]) assert.throws(() => admittedResult("store:2", row, "request"), /disagree/u);
});

it("does not turn creation, report, timer or primary receipts into result references", () => {
	for (const row of [undefined, null, "report sent", { sessionId: "store" }, { timerId: 7 }, { admitted: true, sourceId: "message" }, { submissionId: 0 }, { submissionId: 1.5 }, { submissionId: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => admittedResult("store", row));
	assert.throws(() => admittedResult("@handle", { submissionId: 7 }), /canonical/u);
	assert.throws(() => admittedResult("store:wrong", { submissionId: 7 }), /conversation/u);
});
