import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord";
import { HostLink } from "./client.mts";
import type { ConversationFrame } from "./contract.mts";
import { CHILD, deferred, descriptor, FakeHost, frame, snapshot, STORAGE } from "./fake-host.mts";
import { ObservationManager, type AvailabilityState } from "./observation.mts";

interface Seen {
	workspace: string;
	identity: string;
	epoch: number;
	revision: number;
}
function observer(getLink: (identity: string) => Promise<HostLink>) {
	const seen: Seen[] = [];
	const availability: { identity: string; state: AvailabilityState }[] = [];
	const waiters: { predicate: (value: Seen) => boolean; resolve: (value: Seen) => void }[] = [];
	const unavailable = deferred<void>();
	const manager = new ObservationManager({
		getLink,
		onFrame: (workspace, identity, epoch, value) => {
			const received = { workspace, identity, epoch, revision: value.revision };
			seen.push(received);
			for (const waiter of [...waiters])
				if (waiter.predicate(received)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(received);
				}
		},
		onAvailability: (_workspace, identity, state) => {
			availability.push({ identity, state });
			if (state === "unavailable") unavailable.resolve();
		},
	});
	return {
		manager,
		seen,
		availability,
		unavailable,
		wait: (predicate: (value: Seen) => boolean): Promise<Seen> => {
			const existing = seen.find(predicate);
			return existing ? Promise.resolve(existing) : new Promise((resolve) => waiters.push({ predicate, resolve }));
		},
	};
}

test("subscription baseline replaces older open and snapshot state", async (t) => {
	const held = deferred<JsonValue>();
	const host = await FakeHost.start({
		openFrame: (identity) => frame(2, identity),
		subscriptionFrame: (identity) => frame(7, identity),
		handler: (call) => (call.member === "snapshot" ? held.promise : undefined),
	});
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	const selected = watch.manager.select("workspace", CHILD);
	const baseline = await watch.wait((value) => value.revision === 7);
	assert.equal(baseline.identity, CHILD);
	const older = snapshot();
	older.revision = "newer-history-response";
	older.entries = [{ id: "99", kind: "user", data: { text: "not the selected frame" } }];
	held.resolve(older);
	await selected;
	await turn();
	assert.deepEqual(
		watch.seen.map((value) => value.revision),
		[7],
	);
	assert.equal(host.tokenCount, 1);
	await watch.manager.hide("workspace");
	assert.equal(host.tokenCount, 0);
	const events = host.lifecycle.map((event) => event.kind);
	assert.ok(events.indexOf("unsubscribe") < events.indexOf("close"));
	assert.equal(host.calls.filter((call) => call.member === "abort").length, 0);
});

test("hide prevents a delayed link acquisition from opening an observation", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const held = deferred<HostLink>();
	const watch = observer(() => held.promise);
	t.after(() => watch.manager.close());
	const selected = watch.manager.select("workspace", STORAGE);
	await watch.manager.hide("workspace");
	held.resolve(link);
	await selected;
	await turn();
	assert.equal(host.calls.length, 0);
	assert.deepEqual(watch.seen, []);
	assert.deepEqual(watch.manager.identities(), []);
});

test("replacement selection suppresses a delayed previous selection", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const held = deferred<HostLink>();
	const watch = observer((identity) => (identity === STORAGE ? held.promise : Promise.resolve(link)));
	t.after(() => watch.manager.close());
	const previous = watch.manager.select("workspace", STORAGE);
	await watch.manager.select("workspace", CHILD);
	await watch.wait((value) => value.identity === CHILD);
	held.resolve(link);
	await previous;
	await turn();
	assert.deepEqual(
		watch.seen.map((value) => value.identity),
		[CHILD],
	);
	assert.deepEqual(watch.manager.identities(), [CHILD]);
	assert.equal(host.tokenCount, 1);
	assert.ok(host.calls.every((call) => call.member !== "observe-open" || call.params?.sessionId === CHILD));
});

test("hide closes a token when subscription setup completes late", async (t) => {
	const gate = deferred<void>();
	const subscribed = deferred<void>();
	const host = await FakeHost.start({ subscriptionGate: gate.promise, onSubscribe: () => subscribed.resolve() });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	const selected = watch.manager.select("workspace", STORAGE);
	await subscribed.promise;
	await watch.manager.hide("workspace");
	gate.resolve();
	await selected;
	await turn();
	assert.equal(host.tokenCount, 0);
	assert.deepEqual(watch.seen, []);
	assert.equal(host.lifecycle.filter((event) => event.kind === "close").length, 1);
});

test("replacement frames coalesce and stale revisions do not replace current state", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	let deliver!: (value: ConversationFrame) => void;
	const wrapped = {
		require: link.require.bind(link),
		request: link.request.bind(link),
		onDisconnect: link.onDisconnect.bind(link),
		capabilities: link.capabilities.bind(link),
		get connected() {
			return link.connected;
		},
		subscribeObservation: async (...args: Parameters<HostLink["subscribeObservation"]>) => {
			deliver = args[1];
			return link.subscribeObservation(...args);
		},
	} as HostLink;
	const watch = observer(async () => wrapped);
	t.after(() => watch.manager.close());
	await watch.manager.select("workspace", STORAGE);
	await watch.wait((value) => value.revision === 1);
	// Synchronous producer replacements make the microtask-independent coalescing boundary deterministic.
	for (const revision of [2, 3, 4, 3]) deliver(frame(revision) as unknown as ConversationFrame);
	await watch.wait((value) => value.revision === 4);
	await turn();
	assert.deepEqual(
		watch.seen.map((value) => value.revision),
		[1, 4],
	);
});

test("disconnect keeps last frame and reconnect creates a fresh baseline and token", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const links: HostLink[] = [];
	let acquisitions = 0;
	const watch = observer(async () => {
		acquisitions++;
		const link = await HostLink.connect(host.endpoint);
		links.push(link);
		return link;
	});
	t.after(async () => {
		await watch.manager.close();
		await Promise.all(links.map((link) => link.close()));
	});
	await watch.manager.select("workspace", STORAGE);
	await watch.wait((value) => value.epoch === 1);
	const firstToken = host.calls.find((call) => call.member === "observe-open")?.params?.token;
	await host.publish(frame(8));
	await watch.wait((value) => value.revision === 8);
	await host.disconnect();
	await watch.unavailable.promise;
	await host.waitForRelease();
	await turn();
	assert.equal(host.tokenCount, 0);
	assert.equal(acquisitions, 1);
	assert.equal(watch.seen.at(-1)?.revision, 8);
	assert.equal(host.calls.filter((call) => ["abort", "configure", "task-submit"].includes(call.member)).length, 0);
	await watch.manager.reconnect("workspace");
	await watch.wait((value) => value.epoch === 2);
	const opens = host.calls.filter((call) => call.member === "observe-open");
	assert.equal(opens.length, 2);
	assert.notEqual(opens[1].params?.token, firstToken);
	assert.deepEqual(watch.seen.at(-1), { workspace: "workspace", identity: STORAGE, epoch: 2, revision: 1 });
	assert.equal(acquisitions, 2);
	await watch.manager.close();
	assert.equal(host.tokenCount, 0);
});

for (const member of ["snapshot", "observe-open", "observe-frame", "observe-close"] as const) {
	test(`selection requires compatible ${member} before any observation request`, async (t) => {
		const remote = await descriptor();
		delete (remote.operations as Record<string, JsonValue>)[member];
		const host = await FakeHost.start({ descriptor: remote });
		t.after(() => host.close());
		const link = await HostLink.connect(host.endpoint);
		t.after(() => link.close());
		const watch = observer(async () => link);
		t.after(() => watch.manager.close());
		await assert.rejects(watch.manager.select("workspace", STORAGE));
		assert.deepEqual(watch.availability, [{ identity: STORAGE, state: "incompatible" }]);
		assert.equal(host.calls.length, 0);
		assert.equal(link.supports("task-submit"), true);
	});
}

test("two workspaces retain separate owned tokens and close never shuts down the host", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	await Promise.all([watch.manager.select("one", STORAGE), watch.manager.select("two", CHILD)]);
	await watch.wait((value) => value.workspace === "one");
	await watch.wait((value) => value.workspace === "two");
	assert.equal(host.tokenCount, 2);
	await watch.manager.hide("one");
	assert.equal(host.tokenCount, 1);
	await watch.manager.close();
	assert.equal(host.tokenCount, 0);
	assert.equal(link.connected, true);
	assert.equal(host.calls.filter((call) => call.member === "close" || call.member === "abort").length, 0);
	await assert.rejects(watch.manager.select("one", STORAGE), { code: "not_ready" });
});

test("malformed open receipt closes the original owned token", async (t) => {
	const host = await FakeHost.start({ openResult: (_token, value) => ({ token: "wrong", frame: value }) });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	await assert.rejects(watch.manager.select("workspace", CHILD), { code: "protocol_error" });
	const opened = host.calls.find((call) => call.member === "observe-open");
	const closed = host.calls.find((call) => call.member === "observe-close");
	assert.ok(opened?.params?.token);
	assert.equal(closed?.params?.token, opened.params.token);
	assert.notEqual(closed?.params?.token, "wrong");
	assert.equal(host.tokenCount, 0);
	assert.equal(host.lifecycle.filter((event) => event.kind === "subscribe").length, 0);
	assert.deepEqual(watch.seen, []);
	assert.deepEqual(watch.manager.identities(), []);
});
