import assert from "node:assert/strict";
import test from "node:test";
import {
	beginOwnership,
	changeOwnership,
	initialOwnershipState,
	isFinished,
	RECORD_LIMIT_MESSAGE,
	requestDigest,
	validateOwnershipState,
} from "./ownership.ts";
import type { OwnershipRecord, ResourceRef } from "./ownership.ts";

const ownedBlock: ResourceRef = {
	kind: "block",
	sessionId: "session:11111111-1111-4111-8111-111111111111",
	blockId: "block:33333333-3333-4333-8333-333333333333",
};

function record(callId = "call"): OwnershipRecord {
	return {
		callId,
		ownerId: "owner",
		requestDigest: requestDigest({ op: "create" }),
		operation: "create",
		phase: "pending",
		resources: [],
		server: { endpoint: "unix:///socket", hostId: "host", instanceId: "instance", selection: "home" },
		createdAt: "2026-11-01",
		updatedAt: "2026-11-01",
	};
}

test("ownership reducers preserve caller state, reject duplicate calls and enforce capacity", () => {
	const original = initialOwnershipState();
	const first = beginOwnership(original, record(), 2);
	assert.equal(original.records.length, 0);
	assert.throws(() => beginOwnership(first, record(), 2), /do not replay/);
	const changed = changeOwnership(first, "call", { phase: "unknown" }, 2);
	assert.equal(first.records[0]?.phase, "pending");
	assert.equal(changed.records[0]?.phase, "unknown");
	const full = beginOwnership(changed, record("second"), 2);
	assert.throws(() => beginOwnership(full, record("third"), 2), { message: RECORD_LIMIT_MESSAGE });
	assert.match(RECORD_LIMIT_MESSAGE, /"op":"cleanup","recordId":"<recordId>"/);
	assert.match(RECORD_LIMIT_MESSAGE, /"op":"reconcile","recordId":"<recordId>","recover":true/);
	assert.match(RECORD_LIMIT_MESSAGE, /"op":"reconcile","recordId":"<recordId>","release":true,"note":"<what remains>"/);
});

test("a finished record is closed, released, or confirmed without resources; every other record is an open claim", () => {
	const cases: Array<[OwnershipRecord["phase"], ResourceRef[], boolean]> = [
		["closed", [], true],
		["closed", [ownedBlock], true],
		["released", [], true],
		["released", [ownedBlock], true],
		["confirmed", [], true],
		["confirmed", [ownedBlock], false],
		["pending", [], false],
		["unknown", [], false],
		["unknown", [ownedBlock], false],
	];
	for (const [phase, resources, finished] of cases)
		assert.equal(isFinished({ phase, resources }), finished, `${phase} with ${resources.length} resources`);
});

test("a full store drops its oldest finished records first and refuses only when every record is an open claim", () => {
	const entry = (callId: string, phase: OwnershipRecord["phase"], resources: ResourceRef[] = []) => ({
		...record(callId),
		phase,
		resources,
	});
	const state = {
		version: 1 as const,
		records: [
			entry("open-pending", "pending"),
			entry("finished-closed", "closed", [ownedBlock]),
			entry("open-confirmed", "confirmed", [ownedBlock]),
			entry("finished-input", "confirmed"),
			entry("open-unknown", "unknown"),
			entry("finished-released", "released"),
		],
	};
	const ids = (value: { records: OwnershipRecord[] }) => value.records.map((item) => item.callId);
	const first = beginOwnership(state, record("new"), 6);
	assert.deepEqual(ids(first), [
		"open-pending",
		"open-confirmed",
		"finished-input",
		"open-unknown",
		"finished-released",
		"new",
	]);
	assert.equal(state.records.length, 6, "the input state is unchanged");
	const lower = beginOwnership(state, record("reserved"), 5);
	assert.deepEqual(
		ids(lower),
		["open-pending", "open-confirmed", "open-unknown", "finished-released", "reserved"],
		"an admission limit below the stored count drops as many finished records as it needs",
	);
	const open = beginOwnership(lower, record("newer"), 5);
	assert.deepEqual(ids(open), ["open-pending", "open-confirmed", "open-unknown", "reserved", "newer"]);
	assert.throws(() => beginOwnership(open, record("refused"), 5), { message: RECORD_LIMIT_MESSAGE });
	assert.throws(
		() => beginOwnership({ version: 1, records: [entry("call", "closed")] }, record("call"), 1),
		/already has retained effects/,
		"the duplicate-call check runs before a finished record is dropped",
	);
});

test("ownership validation rejects malformed resource identities rather than repairing records", () => {
	const malformed = record();
	malformed.resources = [{ kind: "block", sessionId: "session:short", blockId: "block:short" }];
	assert.throws(() => validateOwnershipState({ version: 1, records: [malformed] }), /resource is invalid/);
	assert.throws(() => validateOwnershipState({ version: 2, records: [] }), /state is invalid/);
});

test("current ownership shapes reject unsupported keys and accept every legitimate producer field", () => {
	const current = record();
	current.note = "An owned cleanup call has pending effects.";
	current.pendingCleanupCallId = "close";
	current.resources = [
		{
			kind: "block",
			sessionId: "session:11111111-1111-4111-8111-111111111111",
			windowId: "window:22222222-2222-4222-8222-222222222222",
			blockId: "block:33333333-3333-4333-8333-333333333333",
		},
	];
	const state = { version: 1 as const, records: [current] };
	assert.deepEqual(validateOwnershipState(state), state);
	for (const location of ["state", "record", "server", "resource"] as const) {
		const candidate = structuredClone(state);
		const entry = candidate.records[0];
		assert.ok(entry);
		const resource = entry.resources[0];
		assert.ok(resource);
		Object.assign({ state: candidate, record: entry, server: entry.server, resource }[location], {
			unsupported: "x".repeat(200000),
		});
		assert.throws(() => validateOwnershipState(candidate), /unsupported fields/);
	}
});

test("deliberate release is distinct from acknowledgement or closure", () => {
	const state = beginOwnership(initialOwnershipState(), record());
	const released = changeOwnership(state, "call", {
		phase: "released",
		note: "Native effects remain independent of this claim.",
	});
	assert.equal(released.records[0]?.phase, "released");
	assert.equal(state.records[0]?.phase, "pending");
});
