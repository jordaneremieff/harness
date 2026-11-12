import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ORDINARY_CONTINUITY_ENTRY, continuityText, foldContinuity, nativeContinuityText, ordinaryContinuityText, pruneContinuity, validateContinuityDelivered, validateContinuityFact, type ContinuityEvent, type ContinuityFact } from "./continuity-facts.ts";

const requested = (requestId = "request-a", replyTo = "owner"): ContinuityFact => ({ phase: "requested", sessionId: "worker:2", requestId, replyTo });
const admitted = (requestId = "request-a", submissionId = 1): ContinuityFact => ({ ...requested(requestId), phase: "admitted", submissionId });
const event = (fact: ContinuityFact, afterHead = 0): ContinuityEvent => ({ ...fact, afterHead });
it("keeps uncertain admissions, scheduled inputs and routed work in separate exact counts", () => {
	const text = continuityText("owner", "head", [requested(), { ...requested("scheduled"), timerId: 5 }, { ...admitted("elsewhere", 2), replyTo: "other" }, admitted("settled-undelivered", 3)]);
	assert.match(text, /Admission unconfirmed:\s+\{"sessionId":"worker:2","requestId":"request-a"\}/u);
	assert.match(text, /Scheduled inputs:\s+\{"sessionId":"worker:2","timerId":5\}/u);
	assert.match(text, /Routed elsewhere: 1\./u);
	assert.match(text, /settled-undelivered/u);
	assert.doesNotMatch(text, /"requestId":"elsewhere"/u);
	assert.match(text, /Not covered: messages sent to an ordinary primary/u);
});

it("uses causal head order rather than time and keeps the current head's bytes frozen", () => {
	const events = [event(requested()), event(admitted()), event({ ...admitted(), phase: "delivered" }, 10)];
	const first = nativeContinuityText("owner", 10, events);
	assert.match(first, /"submissionId":1/u);
	assert.equal(nativeContinuityText("owner", 10, events.slice(0, 2)), first);
	assert.doesNotMatch(nativeContinuityText("owner", 20, events), /"submissionId":1/u);
	assert.deepEqual(pruneContinuity(events, 10), events);
	assert.deepEqual(pruneContinuity(events, 20), []);
	assert.equal(nativeContinuityText("owner", 10, structuredClone(events)), first);
});

it("lists newest admissions first and accounts for every omitted row", () => {
	const facts = Array.from({ length: 40 }, (_, index) => admitted(`request-${index}`, index + 1));
	const text = continuityText("owner", 100, facts);
	assert.equal((text.match(/"submissionId":/gu) ?? []).length, 32);
	assert.match(text, /8 more not listed/u);
	assert.ok(text.indexOf('"submissionId":40') < text.indexOf('"submissionId":9'));
	assert.doesNotMatch(text, /"submissionId":8,/u);
});

it("does not reopen a delivered request or infer delivery from missing live work", () => {
	const done = { ...admitted(), phase: "delivered" as const };
	assert.deepEqual(foldContinuity([requested(), admitted(), done, requested(), admitted()]), [done]);
	assert.equal(foldContinuity([requested(), admitted()])[0].phase, "admitted");
	assert.throws(() => foldContinuity([admitted(), { ...admitted(), submissionId: 2 }]), /Conflicting/u);
	assert.throws(() => validateContinuityFact({ ...admitted(), submissionId: undefined }), /requires a submission/u);
	assert.throws(() => validateContinuityFact({ ...requested(), requestId: "bad\nrequest" }), /Invalid/u);
	assert.throws(() => validateContinuityDelivered([{ sessionId: "worker", submissionId: 1 }]), /Invalid/u);
	assert.throws(() => validateContinuityDelivered("prose"), /Invalid/u);
});

it("reads ordinary records before the exact compaction entry, beyond a fixed tail window", () => {
	const custom = (id: string, data: ContinuityFact): SessionEntry => ({ type: "custom", customType: ORDINARY_CONTINUITY_ENTRY, id, parentId: null, timestamp: "2026-01-01T00:00:00Z", data });
	const filler: SessionEntry[] = Array.from({ length: 4100 }, (_, index) => ({ type: "custom", customType: "other", id: `f-${index}`, parentId: null, timestamp: "2026-01-01T00:00:00Z" }));
	const head: SessionEntry = { type: "compaction", id: "head", parentId: null, timestamp: "2026-01-01T00:00:00Z", summary: "Summary", firstKeptEntryId: "head", tokensBefore: 1 };
	const entries = [custom("start", requested()), ...filler, head, custom("later", { ...requested(), phase: "refused" })];
	assert.match(ordinaryContinuityText("owner", head.id, entries), /request-a/u);
	assert.equal(ordinaryContinuityText("owner", head.id, entries), ordinaryContinuityText("owner", head.id, entries.slice(0, -1)));
	assert.throws(() => ordinaryContinuityText("owner", "missing", entries), /absent/u);
});
