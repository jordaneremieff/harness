import assert from "node:assert/strict";
import { test } from "node:test";

import {
	appendGuidance,
	GUIDANCE_HISTORY_LIMITS,
	guidanceHistory,
	guidanceMessage,
	guidanceRecord,
	guidanceRecordBytes,
	messageDigest,
	parseGuidanceRecord,
	parseGuidanceRetirement,
	prepareGuidance,
	projectGuidance,
	planGuidance,
	type GuidanceAnchor,
	type GuidanceEpochs,
	type GuidanceRecord,
	type GuidanceSource,
} from "./guidance-history.ts";
import { evaluatePrograms, type FactsProgram, type ProgramRule } from "./program.ts";
import { ObservationState } from "./state.ts";

type Draft = { role: string } & Record<string, unknown>;

function rule(id: string, program: FactsProgram): ProgramRule {
	return { id, revision: "123456abcdef", program };
}

function baseRule(id = "guide"): ProgramRule {
	return rule(id, {
		phase: "context",
		when: { op: "gte", path: ["state", "count"], value: 1 },
		action: { kind: "guide", text: "Inspect the completed outcome." },
		onUnavailable: "skip",
		state: {
			observe: { op: "eq", path: ["outcome", "kind"], value: "success" },
			once: "period",
		},
	});
}

function user(text: string, timestamp = 1): Draft {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function system(sections: Record<string, string>, timestamp = 0): Draft {
	return { role: "system", content: "", sections, timestamp };
}

type Source = GuidanceSource;

/** Contributions for the non-system messages, one entry each, identified by position. */
function sourcesOf(messages: readonly Draft[], ids?: readonly string[]): Source[] {
	return messages
		.filter((message) => message.role !== "system")
		.map((message, index) => ({ entryId: ids?.[index] ?? `entry-${index}`, contribution: 0, message }));
}

function anchorOf(source: Source | undefined, epoch = "epoch-one"): GuidanceAnchor {
	assert.ok(source, "source");
	return {
		epoch,
		entryId: source.entryId,
		contribution: source.contribution,
		messageDigest: messageDigest(source.message),
	};
}

function recordAt(
	source: Source | undefined,
	text: string,
	epoch = "epoch-one",
	timestamp = 10,
): GuidanceRecord {
	return {
		id: `record-${epoch}-${source?.entryId}-${text.length}-${timestamp}`,
		anchor: anchorOf(source, epoch),
		timestamp,
		text,
		pins: [{ id: "guide", revision: "123456abcdef", generation: 1 }],
	};
}

const same = (epoch: string): GuidanceEpochs => ({ epoch, validatedEpoch: epoch });
const crossing = (from: string, to: string): GuidanceEpochs => ({ epoch: to, validatedEpoch: from });
const roles = (messages: readonly { role: string }[]) => messages.map((message) => message.role);
const assistant = (text: string, timestamp: number): Draft => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp,
});

test("prepared guidance does not consume an allowance before persistence", () => {
	const state = new ObservationState();
	const policy = baseRule();
	state.sync([policy], 0);
	const pin = state.pin(policy.id);
	assert.ok(pin);
	assert.equal(state.complete(pin, { outcome: { kind: "success" } }, 1, 1), true);
	const evaluations = evaluatePrograms([policy], "context", {
		tool: "",
		facts: { context: {} },
		states: Object.fromEntries(state.snapshot(2, 1).map((view) => [view.id, view])),
		now: 2,
	});
	const prepared = prepareGuidance(evaluations, state, 2, 1);
	assert.ok(prepared);
	assert.equal(prepared.text, "[policy] Inspect the completed outcome.");
	assert.deepEqual(prepared.pins, [pin]);
	assert.equal(state.view(policy.id, 2, 1)?.projected, 0);
	assert.equal(state.eligible(policy.id, 2, 1), true);
	assert.equal(state.project(policy.id, 2, 1), true);
	assert.equal(state.view(policy.id, 2, 1)?.projected, 1);
	assert.equal(prepareGuidance(evaluations, state, 3, 1), undefined);
});

test("record identity is deterministic for a retry at the same anchor", () => {
	const messages = [system({}, 0), user("first")];
	const anchor = anchorOf(sourcesOf(messages)[0]);
	const prepared = {
		text: "[policy] Inspect the completed outcome.",
		pins: [{ id: "guide", revision: "123456abcdef", generation: 1 }],
	};
	const first = guidanceRecord(anchor, 10, prepared);
	const second = guidanceRecord(anchor, 10, prepared);
	assert.equal(first.id, second.id);
	assert.equal(guidanceRecord(anchor, 11, prepared).id, first.id);
	assert.notEqual(
		guidanceRecord(anchor, 10, { ...prepared, text: "[policy] Different text." }).id,
		first.id,
	);
	const other = anchorOf(sourcesOf(messages)[0], "epoch-two");
	assert.notEqual(guidanceRecord(other, 10, prepared).id, first.id);
	assert.notEqual(guidanceRecord({ ...anchor, entryId: "entry-9" }, 10, prepared).id, first.id);
	assert.notEqual(guidanceRecord({ ...anchor, contribution: 1 }, 10, prepared).id, first.id);
});

test("projection keeps frozen guidance after its anchor and preserves system patches", () => {
	const messages = [
		system({ preamble: "prompt" }, 0),
		user("first", 1),
		system({ skills: "patched" }, 2),
		assistant("answer", 3),
		user("second", 4),
	];
	const sources = sourcesOf(messages);
	const first = recordAt(sources[0], "[policy] First notice.", "epoch-one", 10);
	const second = recordAt(sources[2], "[policy] Second notice.", "epoch-one", 11);
	const history = guidanceHistory([first, second]);
	const projected = projectGuidance(messages, sources, history, same("epoch-one"));
	assert.deepEqual(roles(projected.messages), ["system", "user", "user", "system", "assistant", "user", "user"]);
	assert.deepEqual(projected.messages[2], guidanceMessage(first));
	assert.deepEqual(projected.messages[6], guidanceMessage(second));
	assert.deepEqual(projected.messages[0], messages[0]);
	assert.deepEqual(projected.messages[3], messages[2]);
	assert.deepEqual(projected.retained, [first, second]);
	assert.deepEqual(projected.retired, []);
	assert.deepEqual(projected.mismatched, []);

	const repeated = projectGuidance(messages, sources, history, same("epoch-one"));
	assert.equal(JSON.stringify(repeated.messages), JSON.stringify(projected.messages));
});

test("later base messages append without moving earlier guidance", () => {
	const firstRequest = [system({}, 0), user("first", 1)];
	const record = recordAt(sourcesOf(firstRequest)[0], "[policy] Frozen.", "epoch-one", 10);
	const history = guidanceHistory([record]);
	const later = [...firstRequest, assistant("answer", 2), user("second", 3)];
	const sources = sourcesOf(later);
	const projected = projectGuidance(later, sources, history, same("epoch-one"));
	assert.deepEqual(roles(projected.messages), ["system", "user", "user", "assistant", "user"]);
	assert.deepEqual(projected.messages[2], guidanceMessage(record));
	const plan = planGuidance(
		later,
		sources,
		history,
		same("epoch-one"),
		() => ({ text: "[policy] Next.", pins: [], ids: [] }),
		20,
	);
	assert.ok(plan.addition);
	assert.equal(plan.addition.record.anchor.entryId, "entry-2");
	assert.equal(plan.addition.record.anchor.contribution, 0);
	assert.equal(plan.addition.record.anchor.messageDigest, messageDigest(later[3]));
	assert.deepEqual(roles(plan.addition.messages), ["system", "user", "user", "assistant", "user", "user"]);
});

test("an anchor that changes inside one epoch is a fault, not a new position", () => {
	const messages = [system({}, 0), user("first", 1)];
	const record = recordAt(sourcesOf(messages)[0], "[policy] Frozen.", "epoch-one", 10);
	const changed = [system({}, 0), user("different", 1)];
	const projected = projectGuidance(changed, sourcesOf(changed), guidanceHistory([record]), same("epoch-one"));
	assert.deepEqual(projected.mismatched, [record]);
	assert.deepEqual(projected.retained, []);
	assert.equal(projected.messages.length, changed.length);
});

test("a source whose position moves keeps its guidance and a removed source retires across a boundary", () => {
	const messages = [system({}, 0), user("first", 1), user("second", 2), user("third", 3)];
	const sources = sourcesOf(messages);
	const kept = recordAt(sources[2], "[policy] Kept.", "epoch-one", 10);
	const removed = recordAt(sources[0], "[policy] Removed.", "epoch-one", 11);
	// A compaction drops the first two messages and prepends a summary, so the third message moves
	// from base position 2 to base position 1 while keeping its entry.
	const summary = user("summary", 50);
	const request = [system({}, 0), summary, messages[3] as Draft, user("fourth", 4)];
	const survivors: Source[] = [
		{ entryId: "summary", contribution: 0, message: summary },
		sources[2] as Source,
		{ entryId: "entry-3", contribution: 0, message: request[3] },
	];
	const projected = projectGuidance(
		request,
		survivors,
		guidanceHistory([removed, kept]),
		crossing("epoch-one", "epoch-two"),
	);
	assert.deepEqual(projected.retired, [removed]);
	assert.deepEqual(projected.retained, [kept]);
	assert.deepEqual(projected.mismatched, []);
	assert.equal(projected.messages[2], messages[3]);
	assert.deepEqual(projected.messages[3], guidanceMessage(kept));
	assert.equal(projected.messages.length, request.length + 1);
});

test("a replaced source contribution retires its record even when its entry identity remains", () => {
	const messages = [system({}, 0), user("first", 1), user("second", 2)];
	const sources = sourcesOf(messages);
	const record = recordAt(sources[0], "[policy] Frozen.", "epoch-one", 10);
	const edited = [system({}, 0), user("edited", 1), messages[2] as Draft];
	const projected = projectGuidance(edited, sourcesOf(edited), guidanceHistory([record]), crossing("epoch-one", "epoch-two"));
	assert.deepEqual(projected.retired, [record]);
	assert.deepEqual(projected.retained, []);
	assert.equal(projected.messages.length, edited.length);
});

test("a source lost inside the validated epoch faults even when the record was created earlier", () => {
	const messages = [system({}, 0), user("first", 1), user("second", 2)];
	const sources = sourcesOf(messages);
	const record = recordAt(sources[0], "[policy] Frozen.", "epoch-one", 10);
	const shorter = messages.slice(0, 1).concat(messages[2] as Draft);
	const projected = projectGuidance(shorter, sourcesOf(shorter, ["entry-1"]), guidanceHistory([record]), same("epoch-two"));
	assert.deepEqual(projected.mismatched, [record]);
	assert.deepEqual(projected.retired, []);
});

test("request-only messages never shift where a record lands", () => {
	const messages = [system({}, 0), user("first", 1), assistant("answer", 2), user("second", 3)];
	const sources = sourcesOf(messages);
	const record = recordAt(sources[1], "[policy] After the answer.", "epoch-one", 10);
	const notice = { role: "user", content: [{ type: "text", text: "Memory notice." }], timestamp: 9 };
	const request = [
		messages[0] as Draft,
		notice,
		messages[1] as Draft,
		system({ skills: "patched" }, 4),
		messages[2] as Draft,
		notice,
		messages[3] as Draft,
		notice,
	];
	const projected = projectGuidance(request, sources, guidanceHistory([record]), same("epoch-one"));
	assert.deepEqual(projected.retained, [record]);
	const at = projected.messages.indexOf(messages[2] as Draft);
	assert.deepEqual(projected.messages[at + 1], guidanceMessage(record));
	const plan = planGuidance(
		request,
		sources,
		guidanceHistory([]),
		same("epoch-one"),
		() => ({ text: "[policy] Tail.", pins: [], ids: [] }),
		20,
	);
	assert.equal(plan.addition?.record.anchor.entryId, "entry-2");
});

test("identical contents resolve by order and a request-only twin makes the mapping ambiguous", () => {
	const twin = (timestamp: number): Draft => ({
		role: "user",
		content: [{ type: "text", text: "ok" }],
		timestamp,
	});
	const messages = [system({}, 0), twin(1), user("between", 2), twin(1)];
	const sources = sourcesOf(messages);
	const second = recordAt(sources[2], "[policy] Second twin.", "epoch-one", 10);
	const placed = projectGuidance(messages, sources, guidanceHistory([second]), same("epoch-one"));
	assert.deepEqual(placed.retained, [second]);
	assert.deepEqual(placed.messages[4], guidanceMessage(second));
	assert.equal(placed.messages.length, messages.length + 1);

	const withTwin = [...messages, twin(1)];
	const ambiguous = projectGuidance(withTwin, sources, guidanceHistory([second]), same("epoch-one"));
	assert.deepEqual(ambiguous.mismatched, [second]);
	assert.equal(ambiguous.messages.length, withTwin.length);
	const refused = planGuidance(
		withTwin,
		sources,
		guidanceHistory([second]),
		same("epoch-one"),
		() => ({ text: "[policy] Never.", pins: [], ids: [] }),
		20,
	);
	assert.equal(refused.status, "anchor-mismatch");
	assert.equal(refused.addition, undefined);
	const unanchored = planGuidance(
		[system({}, 0), twin(1), twin(1)],
		[{ entryId: "only", contribution: 0, message: twin(1) }],
		guidanceHistory([]),
		same("epoch-one"),
		() => ({ text: "[policy] Never.", pins: [], ids: [] }),
		20,
	);
	assert.equal(unanchored.addition, undefined);
});

test("capacity refuses new records without evicting existing ones", () => {
	const messages = [system({}, 0), user("first", 1)];
	const records: GuidanceRecord[] = [];
	for (let index = 0; index < GUIDANCE_HISTORY_LIMITS.records; index++) {
		const anchor = anchorOf(sourcesOf(messages)[0]);
		records.push({
			id: `record-${index}`,
			anchor,
			timestamp: index,
			text: `[policy] Notice ${index}.`,
			pins: [],
		});
	}
	const full = guidanceHistory(records);
	assert.equal(full.records.length, GUIDANCE_HISTORY_LIMITS.records);
	const candidate: GuidanceRecord = {
		id: "record-overflow",
		anchor: anchorOf(sourcesOf(messages)[0]),
		timestamp: 99,
		text: "[policy] Overflow.",
		pins: [],
	};
	const refused = appendGuidance(full, candidate);
	assert.equal(refused.status, "capacity");
	assert.equal(refused.history.records.length, GUIDANCE_HISTORY_LIMITS.records);
	assert.equal(refused.history.retainedBytes, full.retainedBytes);
	assert.equal(refused.history.records.includes(candidate), false);

	const bytes = GUIDANCE_HISTORY_LIMITS.bytes - 10;
	const large: GuidanceRecord = {
		id: "record-large",
		anchor: anchorOf(sourcesOf(messages)[0]),
		timestamp: 0,
		text: "[policy] Large.",
		pins: [],
	};
	const filled = guidanceHistory([{ ...large, id: "record-first" }]);
	const synthetic = {
		records: [large],
		retainedBytes: bytes,
	};
	const byteRefusal = appendGuidance(synthetic, { ...large, id: "record-second" });
	assert.equal(byteRefusal.status, "capacity");
	assert.deepEqual(byteRefusal.history, synthetic);
	assert.equal(appendGuidance(filled, { ...large, id: "record-second" }).status, "appended");
	assert.equal(guidanceRecordBytes(large) > 0, true);
});

test("restoration checks surviving records before capacity and never selects guidance for an oversized ledger", () => {
	const messages = [system({}, 0), user("first", 1)];
	const sources = sourcesOf(messages);
	const record = recordAt(sources[0], "[policy] Retained.", "epoch-one", 10);
	const records = Array.from({ length: GUIDANCE_HISTORY_LIMITS.records + 1 }, (_, index) => ({
		...record, id: `record-${index}`,
	}));
	const restored = guidanceHistory(records);
	const selection = () => { assert.fail("An oversized ledger must not select new guidance"); };
	const overflow = planGuidance(messages, sources, restored, same("epoch-one"), selection, 20);
	assert.equal(overflow.status, "capacity");
	assert.deepEqual(overflow.history, restored);
	assert.deepEqual(overflow.messages, messages);
	assert.equal(overflow.addition, undefined);

	const replaced = [system({}, 0), user("replacement", 1)];
	const retired = planGuidance(replaced, sourcesOf(replaced), restored,
		{ epoch: "epoch-two", validatedEpoch: "epoch-one" }, undefined, 20);
	assert.equal(retired.status, "ok");
	assert.deepEqual(retired.history.records, []);
	assert.deepEqual(retired.messages, replaced);
});

test("retirement entries require a complete list of valid record identities", () => {
	assert.deepEqual(parseGuidanceRetirement({ ids: ["one", "two"] }), ["one", "two"]);
	for (const value of [null, [], { ids: "one" }, { ids: ["one", ""] }, { ids: ["one", 2] }, { ids: ["x".repeat(129)] }])
		assert.deepEqual(parseGuidanceRetirement(value), []);
});

test("malformed stored records are discarded", () => {
	const messages = [system({}, 0), user("first", 1)];
	const valid = recordAt(sourcesOf(messages)[0], "[policy] Valid.", "epoch-one", 10);
	assert.deepEqual(parseGuidanceRecord(valid), valid);
	assert.equal(parseGuidanceRecord({ ...valid, id: "" }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, anchor: { ...valid.anchor, messageDigest: "abc" } }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, anchor: { ...valid.anchor, contribution: -1 } }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, anchor: { ...valid.anchor, entryId: "" } }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, timestamp: Number.NaN }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, pins: [{ id: "guide" }] }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, text: "" }), undefined);
	assert.equal(parseGuidanceRecord(null), undefined);
});

test("message digests ignore object key order but not content", () => {
	const left = { role: "user", content: [{ type: "text", text: "same" }], timestamp: 1 };
	const right = { timestamp: 1, content: [{ text: "same", type: "text" }], role: "user" };
	assert.equal(messageDigest(left), messageDigest(right));
	assert.notEqual(messageDigest(left), messageDigest({ ...left, timestamp: 2 }));
});
