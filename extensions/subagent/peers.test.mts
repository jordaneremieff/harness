import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PeerEnvelope, PeerHub } from "./peers.ts";

function family() {
	const hub = new PeerHub();
	const received: PeerEnvelope[] = [];
	const root = hub.register({
		sessionId: "root",
		parentSessionId: null,
		label: "parent",
		send: (envelope) => received.push(envelope),
	});
	const a = hub.register({
		sessionId: "a-session",
		workerId: "worker-a",
		parentSessionId: "root",
		label: "producer",
		send: (envelope) => received.push(envelope),
	});
	const b = hub.register({
		sessionId: "b-session",
		workerId: "worker-b",
		parentSessionId: "root",
		label: "consumer",
		send: (envelope) => received.push(envelope),
	});
	return { hub, received, root, a, b };
}

describe("peer routing", () => {
	it("keeps an absent receipt distinct from historical delivery and durable evidence", () => {
		const { hub } = family();
		assert.throws(
			() => hub.status("root", "absent"),
			/cannot determine whether the message was delivered or processed/,
		);
		assert.throws(
			() => hub.status("root", "absent"),
			/does not inspect the recipient transcript or other durable evidence/,
		);
	});
	it("discovers the same dispatch family from every peer without exposing another root", () => {
		const { hub } = family();
		hub.register({ sessionId: "foreign", parentSessionId: null, label: "private", send: () => {} });
		hub.register({
			sessionId: "nested",
			workerId: "worker-nested",
			parentSessionId: "a-session",
			label: "nested",
			send: () => {},
		});
		assert.equal(hub.list("a-session").self, "worker-a");
		assert.deepEqual(
			hub.list("root").peers.map((peer) => peer.id),
			["root", "worker-a", "worker-b", "worker-nested"],
		);
		assert.equal(hub.list("nested").total, 4);
		assert.throws(() => hub.send("nested", "foreign", "leak"), /dispatch family/);
		assert.throws(() => hub.send("foreign", "worker-a", "leak"), /dispatch family/);
	});
	it("routes direct siblings and correlated replies without a parent relay", () => {
		const { hub, received } = family();
		const question = hub.send("a-session", "worker-b", "What is the schema?");
		assert.equal(question.status, "sent_unconfirmed");
		assert.equal(received[0].to, "worker-b");
		assert.equal(received[0].message, "What is the schema?");
		assert.equal("message" in question, false);
		const answer = hub.send("b-session", "worker-a", "Use an integer.", question.id);
		assert.equal(answer.replyTo, question.id);
		assert.throws(() => hub.send("root", "worker-a", "spoof", question.id), /replyTo/);
		assert.throws(() => hub.status("root", question.id), /No retained/);
		hub.observeContext("a-session", [question.id]);
		assert.equal(hub.status("a-session", question.id).status, "sent_unconfirmed");
		hub.observeContext("b-session", [question.id]);
		assert.equal(hub.status("a-session", question.id).status, "context_seen");
	});
	it("resolves parent from actual session ownership and rejects self or absent peers", () => {
		const { hub } = family();
		assert.equal(hub.send("a-session", "parent", "finding").to, "root");
		assert.throws(() => hub.send("root", "parent", "finding"), /unavailable/);
		assert.throws(() => hub.send("a-session", "worker-a", "echo"), /another session/);
		assert.throws(() => hub.list("unknown"), /not an available/);
	});
	it("refuses a broken or cyclic ownership chain", () => {
		const { hub, root } = family();
		root();
		assert.throws(() => hub.list("a-session"), /no longer available/);
		assert.throws(() => hub.send("a-session", "worker-b", "orphan"), /dispatch family/);
		hub.register({ sessionId: "x", parentSessionId: "y", label: "x", send: () => {} });
		hub.register({ sessionId: "y", parentSessionId: "x", label: "y", send: () => {} });
		assert.throws(() => hub.list("x"), /no longer available/);
	});
	it("bounds message bytes and lines without silently shortening content", () => {
		const { hub, received } = family();
		for (const text of ["", " ", "😀".repeat(2049), "x\n".repeat(256)]) {
			assert.throws(() => hub.send("a-session", "worker-b", text), /nothing was sent/);
		}
		const exact = "😀".repeat(2048);
		hub.send("a-session", "worker-b", exact);
		assert.equal(received.length, 1);
		assert.equal(received[0].message, exact);
	});
	it("rolls back a synchronous delivery failure without waking a waiter", async () => {
		const { hub } = family();
		hub.register({
			sessionId: "b-session",
			workerId: "worker-b",
			parentSessionId: "root",
			label: "broken",
			send: () => {
				throw new Error("queue unavailable");
			},
		});
		const waiting = hub.wait("b-session", 5);
		assert.throws(() => hub.send("a-session", "worker-b", "one"), /queue unavailable/);
		assert.equal((await waiting).status, "timeout");
	});
	it("paginates a bounded directory and reports the full family total", () => {
		const { hub } = family();
		for (let i = 0; i < 40; i++)
			hub.register({ sessionId: `session-${i}`, parentSessionId: "root", label: "child", send: () => {} });
		const first = hub.list("root");
		assert.equal(first.total, 43);
		assert.equal(first.peers.length, 32);
		assert.equal(first.nextOffset, 32);
		const second = hub.list("root", 32);
		assert.equal(second.peers.length, 11);
		assert.equal(second.nextOffset, null);
		assert.throws(() => hub.list("root", -1), /offset/);
	});
	it("refuses overflow rather than dropping unconfirmed messages", () => {
		const { hub, received } = family();
		for (let i = 0; i < 128; i++) hub.send("a-session", "worker-b", `${i}`);
		assert.throws(() => hub.send("a-session", "worker-b", "overflow"), /too many unconfirmed/);
		assert.equal(received.length, 128);
		hub.observeContext(
			"b-session",
			received.map((message) => message.id),
		);
		assert.doesNotThrow(() => hub.send("a-session", "worker-b", "space released"));
	});
});

describe("peer wait ownership", () => {
	it("queues the payload before waking and does not infer context observation", async () => {
		const { hub, received } = family();
		const waiting = hub.wait("b-session", 1000).then((result) => {
			assert.equal(received.length, 1);
			return result;
		});
		assert.equal(hub.list("root").peers.find((peer) => peer.id === "worker-b")?.waiting, true);
		const sent = hub.send("a-session", "worker-b", "ready");
		const result = await waiting;
		assert.equal(result.status, "message");
		assert.equal(result.messages[0].id, sent.id);
		assert.equal(result.messages[0].status, "sent_unconfirmed");
		assert.equal(hub.list("root").peers.find((peer) => peer.id === "worker-b")?.waiting, false);
	});
	it("handles message-before-wait and does not reuse a message already in context", async () => {
		const { hub } = family();
		const sent = hub.send("a-session", "worker-b", "early");
		assert.equal((await hub.wait("b-session", 1000)).messages[0].id, sent.id);
		hub.observeContext("b-session", [sent.id]);
		assert.equal((await hub.wait("b-session", 5)).status, "timeout");
	});
	it("cancels waits through their tool signal and releases the timer and slot", async () => {
		const { hub } = family();
		const controller = new AbortController();
		const waiting = hub.wait("a-session", 1000, controller.signal);
		assert.throws(() => hub.wait("a-session", 1000), /already has/);
		controller.abort();
		await assert.rejects(waiting, /aborted/);
		await assert.rejects(hub.wait("a-session", 1000, controller.signal), /aborted/);
		assert.equal((await hub.wait("a-session", 5)).status, "timeout");
		assert.throws(() => hub.wait("a-session", 0), /between/);
		assert.throws(() => hub.wait("a-session", 300001), /between/);
	});
	it("settles on close and records target closure without claiming receipt", async () => {
		const { hub, b } = family();
		const waiting = hub.wait("b-session", 1000);
		b();
		b();
		assert.equal((await waiting).status, "closed");
		const replacement = hub.register({
			sessionId: "b-session",
			workerId: "worker-b",
			parentSessionId: "root",
			label: "replacement",
			send: () => {},
		});
		const sent = hub.send("a-session", "worker-b", "pending");
		replacement();
		assert.equal(hub.status("a-session", sent.id).status, "target_closed");
	});
	it("keeps a replacement binding when an old cleanup callback runs", () => {
		const { hub, b } = family();
		let calls = 0;
		hub.register({
			sessionId: "b-session",
			workerId: "worker-b",
			parentSessionId: "root",
			label: "replacement",
			send: () => {
				calls++;
			},
		});
		b();
		hub.send("a-session", "worker-b", "current");
		assert.equal(calls, 1);
	});
});
