import assert from "node:assert/strict";
import test from "node:test";
import { plain, scripts } from "../../test/load.mts";

const { reader } = scripts(["app/core/exact.ts", "app/ui/logic.ts", "app/ui/ask-state.ts"], { reader: {} });
const version = (presentation: string, generation: number) => ({ documentKey: "A", presentation, generation });
function question(draft: string): ReaderThread {
	return { threadId: "question", draft, messages: [] };
}

test("revisions and a round trip through another document preserve the card, private batch and late answer", () => {
	const sessions = reader.createAskSessions();
	const a = sessions.show("A", "Alpha", "digest-a");
	const thread = question("Can you clarify this?");
	a.threads.push(thread);
	a.current = thread;
	a.visible = true;
	a.heldThread = thread;
	a.comments.push({ text: "First comment", authoredRevision: 1 });
	a.overall = "Keep both points in view.";
	a.overallRevision = 1;
	const message: ReaderAskMessage = { requestId: "one", state: "sending", text: "Prior question", authoredRevision: 1 };
	thread.messages.push(message);
	sessions.register(a, thread, message);
	const b = sessions.show("B", "Beta", "digest-b");
	assert.equal(b.current, null);
	assert.deepEqual(plain(b.comments), []);
	assert.equal(b.overall, "");
	b.threads.push(question("B only"));
	const delivery = sessions.delivery("one", "question");
	assert.equal(delivery?.owner, a);
	assert.equal(sessions.delivery("one", "unrelated"), undefined);
	assert.ok(delivery);
	delivery.message.state = "answered";
	delivery.message.detail = "A's answer";
	assert.equal(sessions.show("A", "Revised Alpha", "digest-new"), a);
	assert.equal(a.current, thread);
	assert.equal(a.current.draft, "Can you clarify this?");
	assert.equal(a.current.messages[0].detail, "A's answer");
	assert.equal(a.visible, true);
	assert.equal(a.heldThread, thread);
	assert.equal(a.comments[0].text, "First comment");
	assert.equal(a.overall, "Keep both points in view.");
	assert.equal(a.overallRevision, 1);
	assert.equal(sessions.show("B", "Beta", "digest-b").threads[0].draft, "B only");
});

test("uncertain sends replay the identical packet; a confirmed fresh refusal permits remapped coordinates", () => {
	const sessions = reader.createAskSessions();
	const a = sessions.show("A", "alpha", "one");
	const message: ReaderAskMessage = { requestId: "q", state: "sending", text: "Explain this", authoredRevision: 1 };
	const thread = {
		...question(""),
		threadId: "q",
		messages: [message],
		range: { start: 0, end: 5 },
		quote: "alpha",
		sourceAnchor: reader.uiLogic.capturePassage("alpha", { start: 0, end: 5 }),
	};
	a.threads.push(thread);
	const first = sessions.packet(thread, message, version("p1", 0));
	sessions.change([{ start: 0, end: 0, expected: "", text: "new " }], "new alpha");
	assert.deepEqual(plain(thread.range), { start: 4, end: 9 });
	const updated = version("p2", 1);
	assert.equal(sessions.packet(thread, message, updated), first);
	assert.deepEqual(plain(first.quoteRange), { start: 0, end: 5 });
	sessions.releasePacket(message);
	const retry = sessions.packet(thread, message, updated);
	assert.deepEqual(plain(retry), {
		...updated,
		requestId: "q",
		threadId: "q",
		text: "Explain this",
		quote: "alpha",
		quoteRange: { start: 4, end: 9 },
		authoredRevision: 1,
	});
});

test("batch members, the overall comment and a follow-up keep their own authored revisions", () => {
	const sessions = reader.createAskSessions();
	const thread: ReaderThread = {
		...question(""),
		threadId: "batch",
		comments: [
			{ text: "On the first version", range: { start: 3, end: 5 }, quote: "it", authoredRevision: 1 },
			{ text: "On the second version", authoredRevision: 2 },
		],
		overall: "General direction",
	};
	const batch: ReaderAskMessage = { requestId: "batch", text: "Batch", state: "sending", authoredRevision: 3 };
	const followUp: ReaderAskMessage = {
		requestId: "follow-up",
		text: "And another thing",
		state: "sending",
		authoredRevision: 4,
	};
	thread.messages.push(batch, followUp);
	const v = version("p5", 7);
	assert.deepEqual(plain(sessions.packet(thread, batch, v)), {
		...v,
		requestId: "batch",
		threadId: "batch",
		overall: "General direction",
		authoredRevision: 3,
		annotations: [
			{ text: "On the first version", quote: "it", quoteRange: { start: 3, end: 5 }, authoredRevision: 1 },
			{ text: "On the second version", authoredRevision: 2 },
		],
	});
	assert.deepEqual(plain(sessions.packet(thread, followUp, v)), {
		...v,
		requestId: "follow-up",
		threadId: "batch",
		text: "And another thing",
		authoredRevision: 4,
	});
});
