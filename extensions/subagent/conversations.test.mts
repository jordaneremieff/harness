import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollaborationEvent } from "./collaboration-types.ts";
import { conversationThreads } from "./conversations.ts";

function event(
	id: string,
	actorId: string,
	recipientId: string | null,
	exchange?: CollaborationEvent["exchange"],
): CollaborationEvent {
	return {
		id,
		actorId,
		recipientId,
		exchange,
		text: "raw evidence",
		kind: "source",
		timestamp: 0,
		source: "test",
		sourceSessionId: actorId,
		entryId: id,
		messageId: id,
		replyTo: null,
		workerId: actorId,
		receipt: null,
	};
}

test("conversations group reverse-direction exchanges without inventing delivery or collapsing source order", () => {
	const first = event("a", "worker", "manager", { kind: "report", text: "First fact" });
	const reply = event("b", "manager", "worker", { kind: "steer", text: "Check that fact" });
	const lateral = event("c", "worker", "peer", { kind: "peer", text: "Peer question" });
	const noise = event("d", "manager", "worker");
	const threads = conversationThreads([first, noise, reply, lateral]);
	assert.equal(threads.length, 2);
	assert.deepEqual(threads[0].events, [first, reply]);
	assert.deepEqual(threads[1].events, [lateral]);
	assert.equal(first.receipt, null);
});

test("an unavailable recipient stays explicitly unknown and raw management events do not become conversations", () => {
	assert.deepEqual(conversationThreads([event("status", "manager", "worker")]), []);
	const threads = conversationThreads([event("missing", "worker", null, { kind: "report", text: "Source fact" })]);
	assert.ok(threads[0].participants.includes("unknown recipient"));
});
