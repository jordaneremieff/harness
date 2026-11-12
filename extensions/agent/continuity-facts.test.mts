import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ORDINARY_CONTINUITY_ENTRY, continuityText, continuityWorkText, validateContinuityState, validateContinuityWork, foldContinuity, nativeContinuityText, ordinaryContinuityText, pruneContinuity, validateContinuityDelivered, validateContinuityFact, type ContinuityEvent, type ContinuityFact } from "./continuity-facts.ts";

it("loads ordinary continuity helpers without resolving the Durable runtime", () => {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { registerHooks } from 'node:module';
		let durable = 0;
		registerHooks({resolve(specifier, context, next) {
			if (specifier.startsWith('@earendil-works/pi-durable')) durable++;
			return next(specifier, context);
		}});
		for (const module of process.argv.slice(1)) await import(module);
		console.log(JSON.stringify({durable}));
	`, ...["continuity-facts.ts", "continuity-projection.ts", "continuity-budget.ts"].map((name) => new URL(name, import.meta.url).href)], { encoding: "utf8", timeout: 20000, maxBuffer: 16384 });
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { durable: 0 });
});

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

it("lists declared open work by identifiers only and names a head whose work was not read", () => {
	const items = [
		{ requestId: "request-a", replyTo: "owner", results: [{ sessionId: "worker:2", submissionId: 7, requestId: "task-a" }, { sessionId: "worker:3", submissionId: 9 }] },
		{ requestId: "request-b", replyTo: "other", results: [] },
	];
	assert.equal(continuityWorkText("owner:3", items), [
		"Declared open work of this session at the first request after this context head; each item owes one final report to its replyTo: ",
		'{"requestId":"request-a","replyTo":"owner","dependsOn":[{"sessionId":"worker:2","submissionId":7,"requestId":"task-a"},{"sessionId":"worker:3","submissionId":9}]}',
		'{"requestId":"request-b","replyTo":"other","dependsOn":[]}',
		'An arrived result closes no item: agent_work complete closes it, and a host abort or reset closes it with a final report. Read current items, notes and dependency states with agent_status({"sessionId":"owner:3"}).',
	].join("\n"));
	assert.equal(continuityWorkText("owner", []), "Declared open work of this session at the first request after this context head; each item owes one final report to its replyTo: none");
	assert.equal(continuityWorkText("owner", undefined), 'Declared open work of this session: not read for this context head. Read it with agent_status({"sessionId":"owner"}).');
	assert.match(continuityWorkText("owner", Array.from({ length: 34 }, (_, index) => ({ requestId: `request-${index}`, replyTo: "owner", results: [] }))), /\n2 more not listed\nAn arrived result closes no item/u);

	const text = nativeContinuityText("owner", 10, [], { headId: 10, items });
	assert.ok(text.startsWith("Host-held continuity facts from the Agent extension for context head entry 10."));
	assert.ok(text.endsWith(continuityWorkText("owner", items)));
	assert.ok(nativeContinuityText("owner", 11, [], { headId: 10, items }).endsWith(continuityWorkText("owner", undefined)), "open work that was read for another head never enters the note");
	assert.doesNotMatch(continuityText("owner", "head", []), /Declared open work/u, "the shared text has no open-work section");
});

it("validates retained open work with the continuity state", () => {
	const work = { headId: 10, items: [{ requestId: "request-a", replyTo: "owner", results: [{ sessionId: "worker:2", submissionId: 7 }] }] };
	validateContinuityWork(work);
	validateContinuityState({ events: [], work });
	validateContinuityState({ events: [] });
	for (const invalid of [
		{ ...work, headId: 0 }, { headId: 10 },
		{ headId: 10, items: [{ ...work.items[0], requestId: "" }] },
		{ headId: 10, items: [{ ...work.items[0], replyTo: "@handle" }] },
		{ headId: 10, items: [{ ...work.items[0], results: [{ sessionId: "worker:2", submissionId: 0 }] }] },
		{ headId: 10, items: [{ ...work.items[0], results: [{ sessionId: "worker 2", submissionId: 1 }] }] },
	]) assert.throws(() => validateContinuityState({ events: [], work: invalid }), TypeError);
});
