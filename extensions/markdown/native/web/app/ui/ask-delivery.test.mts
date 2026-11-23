import assert from "node:assert/strict";
import test from "node:test";
import { scripts } from "../../test/load.mts";

const { reader } = scripts(["app/ui/logic.ts", "app/ui/ask-state.ts", "app/ui/ask-delivery.ts"], { reader: {} });
function fixture(reply: (index: number) => ReaderPromptReceipt) {
	const sessions = reader.createAskSessions();
	const owner = sessions.show("A", "", "one");
	const message: ReaderAskMessage = { requestId: "q", text: "Question", state: "sending" };
	const thread: ReaderThread = { threadId: "q", draft: "", messages: [message] };
	const version = { documentKey: "A", presentation: "one", generation: 0 };
	const packets: Record<string, unknown>[] = [];
	owner.threads.push(thread);
	sessions.register(owner, thread, message);
	const delivery = reader.createAskDelivery(
		sessions,
		() => version,
		async (packet) => {
			packets.push(packet);
			return reply(packets.length);
		},
	);
	const send = () => delivery.submit(owner, thread, message);
	const update = (state: ReaderAskState, detail?: string, documentKey?: string) =>
		delivery.update({ requestId: "q", threadId: "q", state, detail, documentKey });
	return { sessions, delivery, send, update, message, owner, thread, version, packets };
}

test("a fresh refusal rebases once; another fresh refusal leaves an explicit new-base retry", async () => {
	const f = fixture((i) => {
		f.version.generation++;
		return i === 3 ? { accepted: true } : { accepted: false, fresh: true, detail: "Changed" };
	});
	await f.send();
	assert.equal(f.message.state, "failed");
	assert.equal(f.message.detail, "Changed");
	await f.send();
	assert.deepEqual(
		f.packets.map((p) => [p.requestId, p.generation]),
		[
			["q", 0],
			["q", 1],
			["q", 2],
		],
	);
	assert.equal(f.message.state, "sent");
});

test("a switched document neither rebases a fresh refusal nor submits a stale card", async () => {
	const f = fixture(() => ({ accepted: false, fresh: true }));
	const pending = f.send();
	const b = f.sessions.show("B", "", "two");
	f.version.documentKey = "B";
	await pending;
	await f.delivery.submit(b, f.thread, f.message);
	await f.send();
	f.sessions.show("A", "", "one");
	await f.send(); // The controller still shows B.
	assert.equal(f.message.state, "failed");
	assert.equal(f.packets.length, 1);
	f.version.documentKey = "A";
	f.version.presentation = "three";
	await f.send();
	assert.equal(f.packets.length, 2);
	assert.equal(f.packets[1].presentation, "three");
});

test("transport loss and cached refusal keep the original packet until delivery is known", async () => {
	const f = fixture((i) => {
		if (i === 1) throw Error("Lost response");
		return { accepted: false, detail: "Refused" };
	});
	await f.send();
	assert.equal(f.message.state, "unknown");
	assert.equal(f.message.retryable, true);
	f.version.generation++;
	await f.send();
	assert.equal(f.message.state, "failed");
	await f.send();
	assert.equal(f.packets.length, 3);
	assert.ok(f.packets.every((p) => p === f.packets[0]));
});

test("a late native refusal resolves uncertainty without a replay or a delayed transport downgrade", async () => {
	const f = fixture(() => ({ accepted: false, uncertain: true, retryable: true }));
	await f.send();
	assert.equal(f.message.state, "unknown");
	assert.equal(f.update("failed", "Not admitted")?.message, f.message);
	f.update("sending");
	f.update("unknown");
	assert.equal(f.message.state, "failed");
	assert.equal(f.message.detail, "Not admitted");
	assert.equal(f.message.retryable, false);
});

test("a native nonretryable receipt stops a replay; owner-matched evidence still resolves it", async () => {
	const f = fixture(() => ({ accepted: false, uncertain: true, retryable: false }));
	const pending = f.send();
	await f.send(); // Do not start a second attempt while the first is in flight.
	await pending;
	f.update("unknown", "No admission confirmation");
	assert.equal(f.message.retryable, false);
	await f.send();
	assert.equal(f.packets.length, 1);
	f.sessions.show("B", "", "two");
	f.update("working", undefined, "B");
	assert.equal(f.message.state, "unknown");
	assert.equal(f.update("working", undefined, "A")?.owner, f.owner);
	assert.equal(f.message.state, "working");
});

test("admission, progress and answers survive delayed negative states, receipts and transport errors", async () => {
	for (const state of ["admitted", "working", "answered", "unanswered"] as const) {
		for (const failure of ["refused", "fresh", "uncertain", "transport"]) {
			const f = fixture(() => {
				if (failure === "transport") throw Error("Lost");
				if (failure === "uncertain") return { accepted: false, uncertain: true, retryable: true };
				return failure === "fresh" ? { accepted: false, fresh: true } : { accepted: false };
			});
			const pending = f.send();
			f.version.generation++;
			f.update(state, "Original detail");
			f.update("unknown");
			f.update("failed", "Delayed refusal");
			await pending;
			assert.equal(f.message.state, state);
			assert.equal(f.message.detail, "Original detail");
			assert.equal(f.packets.length, 1);
		}
	}
});
