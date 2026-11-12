import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type Tx } from "@earendil-works/pi-durable";
import { recordAdmitted, recordRefused, recordRequested, recordScheduled, recordTimerCancelled } from "./continuity-admission.ts";
import { ContinuityMirror } from "./continuity-mirror.ts";
import { recordContinuityDelivered } from "./continuity-native.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";

const OWNER = "owner-storage";

/** Facts go through real transactions; the note text is the mirror's frozen text for a head placed afterwards. */
async function fixture(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	const mirror = new ContinuityMirror(harness, OWNER);
	t.after(() => mirror.close());
	await mirror.initialize(context);
	const write = <T,>(change: (tx: Tx) => Promise<T>): Promise<T> => harness.commit(change, context);
	const note = async (): Promise<string> => {
		await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
		return mirror.current(conversation.id)?.text ?? "";
	};
	return { id: conversation.id, write, note };
}
const request = (sessionId: string, requestId: string, replyTo = OWNER) => ({ sessionId, requestId, replyTo });

it("lists a request as unconfirmed before its receipt and as admitted after it", { timeout: 10000 }, async (t) => {
	const { id, write, note } = await fixture(t);
	assert.equal(await write((tx) => recordRequested(tx, id, request("worker", "a"))), true);
	assert.match(await note(), /Admission unconfirmed: \n\{"sessionId":"worker","requestId":"a"\}/u);
	await write((tx) => recordAdmitted(tx, id, request("worker", "a"), { sessionId: "worker", requestId: "a", submissionId: 4 }));
	const text = await note();
	assert.match(text, /no delivered result here: \n\{"sessionId":"worker","submissionId":4,"requestId":"a"\}/u);
	assert.match(text, /Admission unconfirmed: none/u);
});

it("records the admitted identity when the dispatched target was a handle or another spelling", { timeout: 10000 }, async (t) => {
	const { id, write, note } = await fixture(t);
	assert.equal(await write((tx) => recordRequested(tx, id, request("@worker", "a"))), false, "a handle is not a canonical identity");
	await write((tx) => recordAdmitted(tx, id, request("@worker", "a"), { sessionId: "worker", requestId: "a", submissionId: 4 }));
	assert.equal(await write((tx) => recordRequested(tx, id, request("alias", "b"))), true);
	await write((tx) => recordAdmitted(tx, id, request("alias", "b"), { sessionId: "worker:2", requestId: "b", submissionId: 5 }));
	const text = await note();
	assert.match(text, /\{"sessionId":"worker","submissionId":4,"requestId":"a"\}/u);
	assert.match(text, /\{"sessionId":"worker:2","submissionId":5,"requestId":"b"\}/u);
	assert.match(text, /Admission unconfirmed: none/u);
	assert.doesNotMatch(text, /alias|@worker/u);
});

it("closes a request on a proven refusal or a receipt without a result reference", { timeout: 10000 }, async (t) => {
	const { id, write, note } = await fixture(t);
	await write((tx) => recordRequested(tx, id, request("worker", "refused")));
	await write((tx) => recordRefused(tx, id, request("worker", "refused")));
	await write((tx) => recordRequested(tx, id, request("primary", "no-reference")));
	await write((tx) => recordAdmitted(tx, id, request("primary", "no-reference"), undefined));
	await write((tx) => recordRequested(tx, id, request("worker", "uncertain")));
	const text = await note();
	assert.match(text, /Admission unconfirmed: \n\{"sessionId":"worker","requestId":"uncertain"\}\nScheduled/u);
	assert.doesNotMatch(text, /refused|no-reference/u);
});

it("counts a request whose answer goes to another identity as routed elsewhere", { timeout: 10000 }, async (t) => {
	const { id, write, note } = await fixture(t);
	await write((tx) => recordRequested(tx, id, request("worker", "a", "another-owner")));
	await write((tx) => recordAdmitted(tx, id, request("worker", "a", "another-owner"), { sessionId: "worker", requestId: "a", submissionId: 4 }));
	const text = await note();
	assert.match(text, /Routed elsewhere: 1\./u);
	assert.match(text, /no delivered result here: none/u);
});

it("lists a scheduled input with its timer until a cancellation before firing or its delivered result", { timeout: 10000 }, async (t) => {
	const { id, write, note } = await fixture(t);
	await write((tx) => recordScheduled(tx, id, request("worker", "timer:1:delivery"), 9));
	await write((tx) => recordScheduled(tx, id, request("other", "timer:2:delivery"), 9));
	await write((tx) => recordScheduled(tx, id, request("worker", "timer:3:delivery"), 12));
	assert.match(await note(), /Scheduled inputs: \n\{"sessionId":"worker","timerId":12\}\n\{"sessionId":"other","timerId":9\}\n\{"sessionId":"worker","timerId":9\}/u);

	await write((tx) => recordTimerCancelled(tx, id, "@handle", 9));
	assert.match(await note(), /"sessionId":"other","timerId":9[\s\S]*"sessionId":"worker","timerId":9/u, "a target that is not the listed identity closes nothing");
	await write((tx) => recordTimerCancelled(tx, id, "other", 9));
	// Timer 12 is listed for one target only; the same timer ID in another storage is another timer.
	await write((tx) => recordTimerCancelled(tx, id, "other", 12));
	assert.match(await note(), /Scheduled inputs: \n\{"sessionId":"worker","timerId":12\}\n\{"sessionId":"worker","timerId":9\}\nRouted/u, "a sole listed timer stays listed when another target's timer with that ID is cancelled");
	await write((tx) => recordTimerCancelled(tx, id, "worker", 12));
	const cancelled = await note();
	assert.match(cancelled, /Scheduled inputs: \n\{"sessionId":"worker","timerId":9\}\nRouted/u);

	await write((tx) => recordContinuityDelivered(tx, id, [{ sessionId: "worker", requestId: "timer:1:delivery", submissionId: 31 }]));
	assert.match(await note(), /Scheduled inputs: none/u);
});
