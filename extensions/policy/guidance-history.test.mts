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
	prepareGuidance,
	projectGuidance,
	tailGuidanceAnchor,
	type GuidanceAnchor,
	type GuidanceRecord,
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

function anchorOf(
	messages: readonly Draft[],
	ordinal: number,
	epoch = "epoch-one",
): GuidanceAnchor {
	const base = messages.filter((message) => message.role !== "system");
	const message = base[ordinal];
	assert.ok(message, `base message ${ordinal}`);
	return { epoch, messageOrdinal: ordinal, messageDigest: messageDigest(message) };
}

function recordAt(
	messages: readonly Draft[],
	ordinal: number,
	text: string,
	epoch = "epoch-one",
	timestamp = 10,
): GuidanceRecord {
	return {
		id: `record-${epoch}-${ordinal}-${text.length}-${timestamp}`,
		anchor: anchorOf(messages, ordinal, epoch),
		timestamp,
		text,
		pins: [{ id: "guide", revision: "123456abcdef", generation: 1 }],
	};
}

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
	const anchor = anchorOf(messages, 0);
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
	const other = anchorOf(messages, 0, "epoch-two");
	assert.notEqual(guidanceRecord(other, 10, prepared).id, first.id);
});

test("projection keeps frozen guidance after its anchor and preserves system patches", () => {
	const messages = [
		system({ preamble: "prompt" }, 0),
		user("first", 1),
		system({ skills: "patched" }, 2),
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 3 },
		user("second", 4),
	];
	const first = recordAt(messages, 0, "[policy] First notice.", "epoch-one", 10);
	const second = recordAt(messages, 2, "[policy] Second notice.", "epoch-one", 11);
	const history = guidanceHistory([first, second]);
	const projected = projectGuidance(messages, history, { epoch: "epoch-one" });
	assert.deepEqual(
		projected.messages.map((message) => message.role),
		["system", "user", "user", "system", "assistant", "user", "user"],
	);
	assert.deepEqual(projected.messages[2], guidanceMessage(first));
	assert.deepEqual(projected.messages[6], guidanceMessage(second));
	assert.deepEqual(projected.messages[0], messages[0]);
	assert.deepEqual(projected.messages[3], messages[2]);
	assert.deepEqual(projected.retained, [first, second]);
	assert.deepEqual(projected.retired, []);
	assert.deepEqual(projected.mismatched, []);

	const repeated = projectGuidance(messages, history, { epoch: "epoch-one" });
	assert.equal(
		JSON.stringify(repeated.messages.filter((message) => message.role === "user" && message !== messages[1])),
		JSON.stringify(projected.messages.filter((message) => message.role === "user" && message !== messages[1])),
	);
});

test("later base messages append without moving earlier guidance", () => {
	const firstRequest = [system({}, 0), user("first", 1)];
	const record = recordAt(firstRequest, 0, "[policy] Frozen.", "epoch-one", 10);
	const history = guidanceHistory([record]);
	const later = [
		...firstRequest,
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
		user("second", 3),
	];
	const projected = projectGuidance(later, history, { epoch: "epoch-one" });
	assert.deepEqual(
		projected.messages.map((message) => message.role),
		["system", "user", "user", "assistant", "user"],
	);
	assert.deepEqual(projected.messages[2], guidanceMessage(record));
	const tail = tailGuidanceAnchor(later, "epoch-one", history);
	assert.ok(tail);
	assert.equal(tail.messageOrdinal, 2);
	assert.equal(tail.messageDigest, messageDigest(later[3]));
});

test("an anchor that changes inside one epoch is a fault, not a new position", () => {
	const messages = [system({}, 0), user("first", 1)];
	const record = recordAt(messages, 0, "[policy] Frozen.", "epoch-one", 10);
	const changed = [system({}, 0), user("different", 1)];
	const projected = projectGuidance(changed, guidanceHistory([record]), { epoch: "epoch-one" });
	assert.deepEqual(projected.mismatched, [record]);
	assert.deepEqual(projected.retained, []);
	assert.equal(projected.messages.length, changed.length);
});

test("valid anchors survive a new epoch and removed sources retire", () => {
	const messages = [system({}, 0), user("first", 1), user("second", 2)];
	const valid = recordAt(messages, 0, "[policy] Valid.", "epoch-one", 10);
	const removed = recordAt(messages, 1, "[policy] Removed.", "epoch-one", 11);
	const shorter = messages.slice(0, 2);
	const projected = projectGuidance(shorter, guidanceHistory([valid, removed]), {
		epoch: "epoch-two",
	});
	assert.deepEqual(projected.retained, [valid]);
	assert.deepEqual(projected.retired, [removed]);
	assert.deepEqual(projected.mismatched, []);
	assert.deepEqual(projected.messages[2], guidanceMessage(valid));
});

test("capacity refuses new records without evicting existing ones", () => {
	const messages = [system({}, 0), user("first", 1)];
	const records: GuidanceRecord[] = [];
	for (let index = 0; index < GUIDANCE_HISTORY_LIMITS.records; index++) {
		const anchor = anchorOf(messages, 0);
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
		anchor: anchorOf(messages, 0),
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
		anchor: anchorOf(messages, 0),
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

test("malformed stored records are discarded", () => {
	const messages = [system({}, 0), user("first", 1)];
	const valid = recordAt(messages, 0, "[policy] Valid.", "epoch-one", 10);
	assert.deepEqual(parseGuidanceRecord(valid), valid);
	assert.equal(parseGuidanceRecord({ ...valid, id: "" }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, anchor: { ...valid.anchor, messageDigest: "abc" } }), undefined);
	assert.equal(parseGuidanceRecord({ ...valid, anchor: { ...valid.anchor, messageOrdinal: -1 } }), undefined);
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
