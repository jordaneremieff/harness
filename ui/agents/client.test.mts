import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord";
import { type AgentError, HostLink } from "./client.mts";
import { CHILD, deferred, descriptor, FakeHost, frame, receipt, STORAGE } from "./fake-host.mts";

const code =
	(expected: string, uncertain?: boolean) =>
	(error: unknown): boolean => {
		assert.equal((error as { code?: string }).code, expected);
		if (uncertain !== undefined) assert.equal((error as AgentError).uncertain, uncertain);
		return true;
	};
const input = { operationId: "input-example", message: "Describe the current state.", mode: "steer" as const };

test("fake Unix host uses private files and closes without native runtime calls", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	assert.equal((await stat(host.directory)).mode & 0o777, 0o700);
	assert.equal((await stat(host.endpoint.socketPath)).mode & 0o777, 0o600);
	const link = await HostLink.connect(host.endpoint);
	await link.close();
	await host.waitForRelease();
	assert.deepEqual(host.calls, []);
	await host.close();
	await assert.rejects(stat(host.directory), { code: "ENOENT" });
});

test("wrong public server handshake rejects before service dispatch", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	await assert.rejects(HostLink.connect({ ...host.endpoint, serverId: randomUUID() }));
	assert.equal(host.calls.length, 0);
});

for (const [name, value] of [
	["null descriptor", null],
	["unknown descriptor format", { format: "unknown" }],
	[
		"malformed operation",
		{
			format: "pi.agent.contract/1",
			release: "1.0.0",
			upstream: { codingAgent: "1.0.3", durable: "1.0.3" },
			requires: { codingAgent: "1.0.0", durable: "1.0.0" },
			operations: { abort: { request: 3, response: "abort/1.0.0" } },
		},
	],
] as const) {
	test(`${name} refuses the host`, async (t) => {
		// null must remain a malformed result rather than select the fake's default descriptor.
		const host = await FakeHost.start({ descriptor: value as JsonValue });
		t.after(() => host.close());
		await assert.rejects(HostLink.connect(host.endpoint));
		assert.equal(host.calls.length, 0);
	});
}

for (const mismatch of ["hash", "native version", "missing operation", "request identity"] as const) {
	test(`${mismatch} refuses only its operation`, async (t) => {
		const remote = await descriptor();
		const operations = remote.operations as Record<string, Record<string, JsonValue>>;
		if (mismatch === "hash") operations.inspect.response = "0".repeat(64);
		if (mismatch === "native version") operations.inspect.durable = "99.0.0";
		if (mismatch === "missing operation") delete operations.inspect;
		if (mismatch === "request identity") operations.inspect.request = "inspect/9.0.0";
		remote.release = "7.0.0";
		const host = await FakeHost.start({ descriptor: remote });
		t.after(() => host.close());
		const link = await HostLink.connect(host.endpoint);
		t.after(() => link.close());
		assert.equal(link.supports("inspect"), false);
		assert.equal(link.supports("task-submit"), true);
		await assert.rejects(link.request("inspect", { sessionId: STORAGE }), code("contract_mismatch"));
		assert.equal(host.calls.length, 0);
		const admission = await link.submit(CHILD, input, "installation-example");
		assert.equal(admission.identity, CHILD);
		assert.equal(host.calls.length, 1);
	});
}

test("submit captures the target and stable keys and deduplicates the exact input", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const first = link.submit(CHILD, input, "installation-example");
	const same = link.submit(CHILD, { ...input }, "installation-example");
	assert.equal(first, same);
	assert.equal((await first).result.requestId, "ui:input-example");
	const call = host.calls[0];
	assert.equal(call.member, "task-submit");
	assert.equal(call.wireRequestId, "ui:input-example");
	assert.deepEqual(call.params, {
		sessionId: CHILD,
		message: input.message,
		origin: "operator",
		requester: "ui:installation-example",
		replyTo: CHILD,
		requestId: "ui:input-example",
		whenBusy: "steer",
	});
	for (const [identity, changed] of [
		[CHILD, { ...input, message: "Edited text" }],
		[STORAGE, input],
		[CHILD, { ...input, mode: "followUp" as const }],
	] as const) {
		await assert.rejects(link.submit(identity, changed, "installation-example"), code("operation_conflict", false));
	}
	assert.equal(host.calls.length, 1);
});

for (const field of [
	"identity",
	"conversationId",
	"submissionId",
	"result.sessionId",
	"result.submissionId",
	"result.requestId",
] as const) {
	test(`wrong admission ${field} disables submission without another send`, async (t) => {
		const host = await FakeHost.start({
			handler: (call) => {
				if (call.member !== "task-submit") return;
				const value = receipt(CHILD, "ui:input-example");
				if (field.startsWith("result."))
					(value.result as Record<string, JsonValue>)[field.slice(7)] = field === "result.submissionId" ? 8 : "wrong";
				else value[field] = field === "identity" ? STORAGE : field === "conversationId" ? 1 : 0;
				return value;
			},
		});
		t.after(() => host.close());
		const link = await HostLink.connect(host.endpoint);
		t.after(() => link.close());
		await assert.rejects(link.submit(CHILD, input, "installation-example"), code("protocol_error", true));
		assert.equal(link.supports("task-submit"), false);
		assert.equal(link.supports("abort"), true);
		await assert.rejects(link.submit(CHILD, input, "installation-example"), code("protocol_error", true));
		assert.equal(host.calls.length, 1);
	});
}

test("observation tokens belong to their opening connection and subscription baseline wins", async (t) => {
	const host = await FakeHost.start({
		openFrame: (identity) => frame(1, identity),
		subscriptionFrame: (identity) => frame(4, identity),
	});
	t.after(() => host.close());
	const owner = await HostLink.connect(host.endpoint);
	t.after(() => owner.close());
	const foreign = await HostLink.connect(host.endpoint);
	t.after(() => foreign.close());
	await owner.request(
		"observe-open",
		{ token: "owned-token", scope: "conversation", sessionId: CHILD },
		{ identity: CHILD, token: "owned-token" },
	);
	await assert.rejects(foreign.subscribeObservation("owned-token", () => {}, CHILD));
	assert.equal(foreign.connected, true);
	assert.equal(foreign.supports("observe-frame"), true);
	const next = deferred<number>();
	const seen: number[] = [];
	const subscription = await owner.subscribeObservation(
		"owned-token",
		(value) => {
			seen.push(value.revision);
			next.resolve(value.revision);
		},
		CHILD,
	);
	assert.equal(subscription.baseline.revision, 4);
	await host.publish(frame(5, CHILD));
	assert.deepEqual(seen, []);
	subscription.start();
	assert.equal(await next.promise, 5);
	await subscription.dispose();
	await owner.request("observe-close", { token: "owned-token" }, { token: "owned-token" });
	assert.equal(host.tokenCount, 0);
	assert.deepEqual(
		host.lifecycle.filter((event) => event.token === "owned-token").map((event) => event.kind),
		["open", "subscribe", "close"],
	);
});

for (const member of ["task-submit", "abort"] as const) {
	test(`disconnect makes ${member} uncertain without automatic replay`, async (t) => {
		const held = deferred<JsonValue>();
		const host = await FakeHost.start({ handler: (call) => (call.member === member ? held.promise : undefined) });
		t.after(() => host.close());
		const link = await HostLink.connect(host.endpoint);
		t.after(() => link.close());
		const disconnected = deferred<void>();
		link.onDisconnect(() => disconnected.resolve());
		const request =
			member === "task-submit"
				? link.submit(CHILD, input, "installation-example")
				: link.request(member, { sessionId: CHILD }, { identity: CHILD });
		const refused = assert.rejects(request, code("host_unavailable", true));
		await host.waitForCall((call) => call.member === member);
		await host.disconnect();
		await disconnected.promise;
		await refused;
		held.resolve({});
		await host.waitForRelease();
		await turn();
		assert.equal(host.calls.filter((call) => call.member === member).length, 1);
		assert.equal(host.connectionCount, 0);
		if (member === "task-submit") {
			await assert.rejects(link.submit(CHILD, input, "installation-example"), code("host_unavailable", true));
		}
		await assert.rejects(link.request(member, { sessionId: CHILD }), code("host_unavailable"));
		assert.equal(host.calls.length, 1);
	});
}

test("configure stays unavailable and sends no mutation or retry", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("configure"), false);
	await assert.rejects(link.request("configure", { sessionId: CHILD, requestId: "configure-example" }));
	await turn();
	assert.equal(host.calls.length, 0);
});

test("request capacity refuses excess requests but permits a later request", async (t) => {
	const held = deferred<JsonValue>();
	const host = await FakeHost.start({
		handler: (call) => (call.member === "dashboard" && call.wireRequestId === "held" ? held.promise : undefined),
	});
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint, { maxPending: 1 });
	t.after(() => link.close());
	const first = link.request("dashboard", null, { wireRequestId: "held" });
	await host.waitForCall((call) => call.wireRequestId === "held");
	await assert.rejects(link.request("dashboard", null), code("capacity", false));
	held.resolve([]);
	await first;
	assert.deepEqual(await link.request("dashboard", null), []);
	assert.equal(host.calls.length, 2);
});

test("injected endpoint retains caller directory ownership", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ui-endpoint-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await chmod(directory, 0o700);
	const endpoint = { serverId: randomUUID(), socketPath: join(directory, "injected.sock") };
	const host = await FakeHost.start({ endpoint });
	t.after(() => host.close());
	assert.deepEqual(host.endpoint, endpoint);
	assert.notEqual(host.directory, directory);
	const link = await HostLink.connect(endpoint);
	await link.close();
	await host.close();
	assert.equal((await stat(directory)).isDirectory(), true);
	await assert.rejects(stat(host.directory), { code: "ENOENT" });
});
