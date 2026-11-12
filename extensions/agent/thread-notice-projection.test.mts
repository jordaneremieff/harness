import assert from "node:assert/strict";
import { it } from "node:test";
import type { CollaborationEvent } from "./collaboration-contract.ts";
import { associateThreadNotices, projectThreadNotices, threadExcerpt, threadNoticeText, threadReadCall, threadRecoveryText, utcTime, type ThreadNoticeSource, type ThreadRangeSnapshot } from "./thread-notice-projection.ts";

const actor = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const recipient = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const threadId = `${actor}/${"c".repeat(32)}`;
const event = (sequence = 1, message = "Retained event text"): CollaborationEvent => ({ threadId, sequence, at: 1_700_000_000_000 + sequence, sender: actor, origin: "model", kind: "contribution", message, source: "", replyTo: null, revision: 1, notify: [] });
type Message = { role: "user" | "assistant"; content: string; timestamp: number };
function source(sequence: number, patch: Partial<ThreadNoticeSource<Message>> = {}): ThreadNoticeSource<Message> {
	const e = event(sequence);
	return {
		sourceId: `entry:${sequence}`, recipient, epoch: "initial",
		message: { role: "user", content: threadNoticeText(e, true), timestamp: e.at },
		passive: { format: "agent.communication-passive/1", requestId: `thread:${sequence}`, value: {
			format: "agent.communication/1", kind: "notice", sender: { identity: actor }, body: { text: "", complete: true, redacted: false }, recordedAt: e.at,
			metadata: { threadId, event: sequence, frameRevision: 1, eventKind: e.kind, passive: true },
		} }, ...patch,
	};
}
function project(sources: ThreadNoticeSource<Message>[], snapshots: ThreadRangeSnapshot[] = [], scope = "storage:conversation:fork") {
	const messages = sources.map((source) => source.message);
	return projectThreadNotices({ scope, messages, associations: associateThreadNotices(messages, sources), snapshots, marker: (original, text) => ({ ...original, content: text }) });
}

it("derives readable UTC without changing the original epoch or notice source text", () => {
	const e = event();
	const original = structuredClone(e);
	assert.equal(utcTime(e.at), new Date(e.at).toISOString());
	assert.equal(utcTime(Number.MAX_SAFE_INTEGER), null);
	assert.equal(utcTime(Number.NaN), null);
	assert.equal(utcTime(Infinity), null);
	for (const passive of [false, true]) {
		const notice = threadNoticeText(e, passive);
		assert.ok(notice.includes(`${e.at} (${new Date(e.at).toISOString()})`));
		assert.ok(notice.includes(threadRecoveryText(threadId, e.sequence)));
	}
	assert.ok(threadNoticeText({ ...e, at: Number.MAX_SAFE_INTEGER }, true).includes("UTC unavailable"));
	assert.deepEqual(e, original);
});
it("keeps passive notices body-free across post, membership, and governing events", () => {
	for (const kind of ["contribution", "carried-authority", "create", "join", "leave", "revise", "close"]) {
		const notice = threadNoticeText({ ...event(), kind, message: "PRIVATE_DISCUSSION_TEXT" }, true);
		assert.ok(!notice.includes("PRIVATE_DISCUSSION_TEXT"));
		assert.ok(notice.includes(kind));
		assert.ok(notice.includes("no reply or wake"));
	}
});
it("cuts excerpts at words and keeps exact-bound text and surrogate pairs intact", () => {
	assert.deepEqual(threadExcerpt("alpha beta gamma", 12), { text: "alpha beta", cut: true });
	assert.deepEqual(threadExcerpt("alpha beta", 10), { text: "alpha beta", cut: false });
	assert.deepEqual(threadExcerpt("abcdefghijk", 5), { text: "abcde", cut: true });
	assert.deepEqual(threadExcerpt("abcd😀xyz", 5), { text: "abcd", cut: true });
	assert.deepEqual(threadExcerpt("😀😀xyz", 4), { text: "😀😀", cut: true });
	const text = threadNoticeText(event(42, "word ".repeat(200)), false);
	assert.match(text, /word \[cut\]$/u);
	assert.ok(text.includes(`agent_collaborate(${JSON.stringify({ action: "read", threadId, before: 43, limit: 1 })})`));
	assert.ok(!text.includes("agent_inspect"));
});
it("names a bounded thread read rather than an invented exact event when sequence is unavailable", () => {
	assert.deepEqual(threadReadCall(threadId), { tool: "agent_collaborate", action: "read", threadId, limit: 1 });
	assert.ok(threadRecoveryText(threadId).includes("Event sequence unavailable"));
	assert.ok(!threadRecoveryText(threadId).includes("before"));
});
it("projects three verified passive messages into one range at the earliest position without changing raw input", () => {
	const sources = [source(2), source(4), source(6)];
	const messages: Message[] = [{ role: "user", content: "Keep the instruction", timestamp: 0 }, ...sources.map((source) => source.message), { role: "assistant", content: "Answer", timestamp: 10 }];
	const original = structuredClone(messages);
	const result = projectThreadNotices({ scope: "one", messages, associations: associateThreadNotices(messages, sources), snapshots: [], marker: (original, text) => ({ ...original, content: text }) });
	assert.equal(result.messages.length, 3);
	assert.equal(result.coverage, "complete");
	assert.deepEqual(result.messages[0], messages[0]);
	assert.deepEqual(result.messages[2], messages[4]);
	assert.ok(result.messages[1].content.includes("passive event range 2..6"));
	assert.ok(result.messages[1].content.includes("not a claim that every sequence was passive"));
	assert.deepEqual(result.snapshots[0].read, { tool: "agent_collaborate", action: "read", threadId, before: 7, limit: 1 });
	assert.deepEqual(result.snapshots[0].sources, ["entry:2", "entry:4", "entry:6"]);
	assert.deepEqual(messages, original);
});
it("freezes prior ranges while a later fourth event creates a later marker", () => {
	const sources = [source(1), source(2), source(3)];
	const first = project(sources);
	const frozen = structuredClone(first.snapshots);
	const second = project([...sources, source(4)], first.snapshots);
	assert.equal(second.messages.length, 2);
	assert.equal(second.messages[0].content, first.messages[0].content);
	assert.ok(second.messages[1].content.includes("passive event range 4..4"));
	assert.deepEqual(first.snapshots, frozen);
	const retry = project([...sources, source(4)], JSON.parse(JSON.stringify(second.snapshots)));
	assert.deepEqual(retry, second, "memo serialisation retains frozen text on retries");
});
it("does not merge recipients, assistant epochs, threads, or lifecycle scopes", () => {
	const other = "dddddddd-dddd-dddd-dddd-dddddddddddd";
	const sources = [source(1), source(2, { recipient: other }), source(3, { epoch: "assistant:9" })];
	assert.equal(project(sources).messages.length, 3);
	const first = project([source(1)]);
	const changedScope = project([source(1), source(2)], first.snapshots, "new-fork");
	assert.equal(changedScope.messages.length, 1);
	assert.equal(changedScope.snapshots[0].scope, "new-fork");
	assert.equal(project([], first.snapshots).snapshots.length, 0, "snapshots leave with their source messages");
});
it("preserves transformed, duplicate, ambiguous, active, and unrelated message tuples", () => {
	const one = source(1);
	const transformed = { ...one.message, content: `${one.message.content} transformed` };
	const active = { ...source(2), passive: { ...source(2).passive as object, format: "not-passive" } };
	for (const [messages, sources] of [
		[[transformed], [one]],
		[[one.message, one.message], [one]],
		[[one.message], [one, { ...one, sourceId: "other-entry" }]],
		[[active.message], [active]],
	] as [Message[], ThreadNoticeSource<Message>[]][]) {
		const association = associateThreadNotices(messages, sources);
		assert.equal(association.coverage, "partial");
		assert.equal(association.items.length, 0);
		const result = projectThreadNotices({ scope: "one", messages, associations: association, snapshots: [], marker: (original, text) => ({ ...original, content: text }) });
		assert.deepEqual(result.messages, messages);
	}
});
it("bounds source association visits and bytes and exposes partial coverage", () => {
	const sources = Array.from({ length: 129 }, (_, index) => source(index + 1));
	const result = project(sources);
	assert.equal(result.coverage, "partial");
	assert.equal(result.snapshots[0].sources.length, 128);
	assert.equal(result.messages.length, 2, "unvisited source retains its minimal marker");
	assert.ok(result.messages[0].content.includes("Coverage: partial"));
	const oversized = source(1, { sourceId: "x".repeat(256 * 1024) });
	assert.equal(associateThreadNotices([oversized.message], [oversized]).items.length, 0);
	assert.equal(associateThreadNotices([source(1).message], [source(1)], false).coverage, "partial");
});
