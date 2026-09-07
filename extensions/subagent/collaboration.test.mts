import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { COLLABORATION_LIMITS, createCollaborationReader } from "./collaboration.ts";
import type { WorkerRecord } from "./index.ts";
import type { PeerReceipt } from "./peers.ts";

const rootId = "11111111-1111-4111-8111-111111111111";
const workerSession = "22222222-2222-4222-8222-222222222222";
const nestedSession = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
function manager(id = rootId) {
	return SessionManager.inMemory(process.cwd(), { id });
}
function record(
	id: string,
	sessionId: string,
	ownerSession: string | null,
	extra: Partial<WorkerRecord> = {},
): WorkerRecord {
	return {
		id,
		task: `Task ${id}`,
		sessionId,
		ownerSession,
		model: "provider/model",
		state: "running",
		createdAt: 1,
		sessionFile: null,
		continuedFrom: null,
		interruptedAt: null,
		...extra,
	} as WorkerRecord;
}
function peer(manager: SessionManager, details: unknown, text = "Peer body") {
	return manager.appendCustomMessageEntry("subagent_peer", text, true, details);
}

test("collaboration groups nested ownership and keeps continuation as a separate participant", async () => {
	const current = manager();
	const one = record("bg-one", workerSession, rootId);
	const nested = record("bg-nested", nestedSession, workerSession);
	const continued = record("bg-continued", otherId, rootId, { continuedFrom: one.id });
	const query = createCollaborationReader({ current, records: () => [one, nested, continued], managers: () => [] });
	const result = await query({});
	assert.equal(result.familyId, rootId);
	assert.equal(result.families.length, 1);
	assert.equal(result.participants.find((p) => p.id === nested.id)?.parentId, one.id);
	assert.equal(result.participants.find((p) => p.id === continued.id)?.parentId, rootId);
	assert.equal(result.participants.find((p) => p.id === continued.id)?.continuedFrom, one.id);
	assert.equal(result.events.filter((e) => e.kind === "dispatch").length, 3);
});

test("history family has an explicit unavailable manager and omits unrelated workers", async () => {
	const query = createCollaborationReader({
		current: manager(),
		records: () => [record("bg-other", workerSession, otherId)],
		managers: () => [],
	});
	const result = await query({ familyId: otherId });
	assert.equal(result.participants[0].state, "unavailable");
	assert.equal(result.participants[0].id, otherId);
	assert.equal(result.participants.length, 2);
	assert.match(result.notices.join("\n"), /Manager: no live session entries/);
	assert.equal((await query({ familyId: "unknown" })).familyId, rootId);
});

test("terminal record outcomes remain visible without the manager and distinguish submitted previews", async () => {
	const records = [
		record("bg-done", workerSession, otherId, {
			state: "done",
			exitedAt: 12,
			stopReason: "submitted",
			resultBytes: 8,
			resultPreview: "stored result",
		}),
		record("bg-final", nestedSession, otherId, {
			state: "no_result_submitted",
			exitedAt: 13,
			lastOutput: "arbitrary final text",
			error: "No protocol submission",
		}),
		record("bg-unconfirmed", "55555555-5555-4555-8555-555555555555", otherId, {
			state: "done",
			exitedAt: 14,
			resultPreview: "unconfirmed preview",
			resultBytes: null,
		}),
	];
	const query = createCollaborationReader({ current: manager(), records: () => records, managers: () => [] });
	const result = await query({ familyId: otherId });
	const outcomes = result.events.filter((event) => event.kind === "worker outcome");
	assert.deepEqual(
		outcomes.map((event) => event.id),
		["outcome:bg-done", "outcome:bg-final", "outcome:bg-unconfirmed"],
	);
	assert.deepEqual(
		outcomes.map((event) => event.timestamp),
		[12, 13, 14],
	);
	assert.equal(result.participants[0].state, "unavailable");
	assert.match(outcomes[0].text, /Submitted-result preview.*stored result/);
	assert.match(outcomes[1].text, /Final output \(not a submitted result\).*arbitrary final text/);
	assert.match(outcomes[1].text, /Recorded error: No protocol submission/);
	assert.doesNotMatch(outcomes[2].text, /Submitted-result preview/);
	assert.ok(outcomes.every((event) => event.source === "worker record" && event.entryId === null));
});

test("live projection keeps ancestry order and source identities across compaction", async () => {
	const current = manager();
	const first = current.appendCustomMessageEntry("subagent_report", "first", true, { id: "bg-one" });
	current.appendCompaction("summary", first, 100);
	const second = current.appendCustomMessageEntry("subagent_result", "second", true, { id: "bg-one" });
	const query = createCollaborationReader({ current, records: () => [], managers: () => [] });
	const result = await query({});
	assert.deepEqual(
		result.events.map((e) => e.entryId),
		[first, second],
	);
	assert.deepEqual(
		result.events.map((e) => e.text),
		["first", "second"],
	);
	assert.ok(result.events.every((e) => e.sourceSessionId === rootId && e.source === "live session entry"));
});

test("tool evidence retains calls, outcomes, envelope replies, and explicit receipt labels", async () => {
	const current = manager();
	current.appendMessage({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "tc1",
				name: "subagent_message",
				arguments: { to: "bg-one", message: "body", replyTo: "pm-old" },
			},
		],
		stopReason: "toolUse",
		timestamp: 1,
	} as never);
	current.appendMessage({
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "subagent_message",
		content: [{ type: "text", text: "receipt" }],
		details: { id: "pm-one", replyTo: "pm-old", to: "bg-one", status: "sent_unconfirmed" },
		isError: false,
		timestamp: 2,
	});
	const query = createCollaborationReader({ current, records: () => [], managers: () => [] });
	const events = (await query({})).events;
	assert.equal(events[0].messageId, "tc1");
	assert.equal(events[0].replyTo, "pm-old");
	assert.equal(events[1].messageId, "pm-one");
	assert.match(events[1].id, /tc1$/);
	assert.equal(events[1].receipt, "recorded sent_unconfirmed");
});

test("copied peer envelopes deduplicate content but retain every observed source occurrence", async () => {
	const current = manager();
	const one = manager(workerSession);
	const continued = manager(nestedSession);
	const envelope = { id: "pm-one", from: rootId, to: "bg-one", replyTo: "pm-old", sentAt: 1, status: "context_seen" };
	const first = peer(one, envelope);
	const second = peer(continued, envelope);
	const query = createCollaborationReader({
		current,
		records: () => [
			record("bg-one", workerSession, rootId),
			record("bg-two", nestedSession, rootId, { continuedFrom: "bg-one" }),
		],
		managers: () => [one, continued],
	});
	const result = await query({});
	assert.equal(result.events.filter((e) => e.kind === "subagent_peer").length, 1);
	const occurrences = result.events.filter((e) => e.kind === "subagent_peer" || e.kind === "peer occurrence");
	assert.equal(occurrences.length, 2, "the first source is represented by its message row, not counted twice");
	assert.deepEqual(
		occurrences.map((e) => e.entryId),
		[first, second],
	);
	assert.deepEqual(
		occurrences.map((e) => e.sourceSessionId),
		[workerSession, nestedSession],
	);
	assert.ok(occurrences.every((e) => e.messageId === "pm-one" && e.replyTo === "pm-old"));
	assert.ok(result.events.every((e) => !e.receipt?.includes("context_seen")));
});

test("conflicting peer envelopes retain both bodies rather than hiding changed evidence", async () => {
	const current = manager();
	peer(current, { id: "pm-one", from: "bg-one", to: rootId }, "first body");
	peer(current, { id: "pm-one", from: "bg-one", to: rootId }, "changed body");
	const query = createCollaborationReader({ current, records: () => [], managers: () => [] });
	const result = await query({});
	assert.ok(result.events.some((event) => event.text === "first body"));
	assert.ok(result.events.some((event) => event.text === "changed body" && event.kind === "peer conflicting envelope"));
	assert.match(result.notices.join("\n"), /conflicting envelope evidence/);
});

test("only process-local receipt evidence establishes a live context_seen label", async () => {
	const current = manager();
	peer(current, { id: "pm-one", from: "bg-one", to: rootId });
	const receipt: PeerReceipt = {
		id: "pm-one",
		from: "bg-one",
		to: rootId,
		replyTo: null,
		sentAt: 1,
		status: "context_seen",
	};
	const query = createCollaborationReader({ current, records: () => [], managers: () => [], receipt: () => receipt });
	const result = await query({});
	assert.equal(result.events.find((e) => e.kind === "peer receipt")?.receipt, "live context_seen");
	assert.equal(
		result.events.find((e) => e.kind === "subagent_peer")?.receipt,
		"recorded envelope; no context acknowledgement",
	);
});

test("malformed custom metadata and cyclic tool arguments stay contained", async () => {
	const current = manager();
	peer(current, null);
	current.appendCustomEntry("subagent_paused", [null]);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	current.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "tc", name: "subagent", arguments: cyclic }],
		stopReason: "toolUse",
		timestamp: 1,
	} as never);
	const query = createCollaborationReader({ current, records: () => [], managers: () => [] });
	const result = await query({});
	assert.equal(result.events.length, 3);
	assert.match(result.events[2].text, /content omitted/);
});

test("live projection never reads files; explicit history reads only the selected known family", async () => {
	const dir = mkdtempSync(join(tmpdir(), "collaboration-test-"));
	try {
		const current = manager();
		const selected = manager(workerSession);
		selected.appendCustomMessageEntry("subagent_report", "history body", true, { id: "bg-one" });
		const path = join(dir, "known.jsonl");
		writeFileSync(
			path,
			`${[selected.getHeader(), ...selected.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const original = readFileSync(path);
		const query = createCollaborationReader({
			current,
			records: () => [
				record("bg-one", workerSession, rootId, { sessionFile: path }),
				record("bg-other", nestedSession, otherId, { sessionFile: join(dir, "missing.jsonl") }),
			],
			managers: () => [],
		});
		const live = await query({});
		assert.equal(
			live.events.some((e) => e.text === "history body"),
			false,
		);
		const history = await query({ history: true });
		assert.equal(
			history.events.some((e) => e.text === "history body"),
			true,
		);
		assert.equal(
			history.notices.some((text) => text.includes("ENOENT")),
			false,
		);
		assert.deepEqual(readFileSync(path), original);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selected history bounds aggregate file bytes before additional reads", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "collaboration-byte-test-"));
	try {
		const records: WorkerRecord[] = [];
		for (let i = 0; i < 10; i++) {
			const session = SessionManager.inMemory();
			session.appendCustomEntry("unrelated", "x".repeat(1900000));
			const path = join(dir, `${i}.jsonl`);
			writeFileSync(
				path,
				`${[session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			records.push(record(`bg-${i}`, session.getSessionId(), rootId, { sessionFile: path }));
		}
		let bytes = 0;
		const original = fs.readSync;
		const mock = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
			const count = original(...args);
			bytes += count;
			return count;
		});
		syncBuiltinESMExports();
		try {
			const query = createCollaborationReader({ current: manager(), records: () => records, managers: () => [] });
			const result = await query({ history: true });
			assert.ok(bytes > 0 && bytes <= COLLABORATION_LIMITS.historyBytes);
			assert.match(result.notices.join("\n"), /byte history limit/);
		} finally {
			mock.mock.restore();
			syncBuiltinESMExports();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("family and event bounds stop producing evidence and report omissions", async () => {
	const current = manager();
	for (let i = 0; i < 100; i++) current.appendCustomMessageEntry("subagent_report", "😀".repeat(5000), true, {});
	let visited = 0;
	function* records() {
		for (let i = 0; i < 2000; i++) {
			visited++;
			yield record(`bg-${i}`, `session-${i}`, rootId);
		}
	}
	const query = createCollaborationReader({ current, records, managers: () => [] });
	const result = await query({});
	assert.equal(visited, COLLABORATION_LIMITS.records + 1);
	assert.equal(result.participants.length, COLLABORATION_LIMITS.members + 1);
	assert.ok(
		Buffer.byteLength(JSON.stringify(result.events)) <= COLLABORATION_LIMITS.eventBytes + result.events.length + 2,
	);
	assert.match(result.notices.join("\n"), /known-record limit/);
	assert.match(result.notices.join("\n"), /family member limit/);
	assert.match(result.notices.join("\n"), /event count or byte limit/);
});

test("ownership cycles and missing owners yield explicit manager placeholders", async () => {
	const records = [
		record("bg-one", workerSession, nestedSession),
		record("bg-two", nestedSession, workerSession),
		record("bg-orphan", otherId, null),
	];
	const query = createCollaborationReader({ current: manager(), records: () => records, managers: () => [] });
	const initial = await query({});
	assert.match(initial.notices.join("\n"), /ownership contains a cycle/);
	const orphan = await query({ familyId: "unavailable:bg-orphan" });
	assert.equal(orphan.participants[0].state, "unavailable");
	assert.equal(orphan.participants[1].parentId, "unavailable:bg-orphan");
});
