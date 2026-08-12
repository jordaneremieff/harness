import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HerdrClient,
	HerdrError,
	LineSplitter,
	parseResponse,
	socketEndpoint,
	type StreamHooks,
	SubscriptionClient,
	TransportError,
} from "./socket.ts";

function idOf(payload: string): string {
	return JSON.parse(payload).id as string;
}

function ok(payload: string, result: unknown): string {
	return `${JSON.stringify({ id: idOf(payload), result })}\n`;
}

function fail(payload: string, code: string, message: string): string {
	return `${JSON.stringify({ id: idOf(payload), error: { code, message } })}\n`;
}

describe("socketEndpoint", () => {
	it("passes unix paths through", () => {
		assert.equal(socketEndpoint("/tmp/herdr.sock", "linux"), "/tmp/herdr.sock");
	});
	it("maps windows paths to named pipes", () => {
		assert.equal(socketEndpoint("herdr.sock", "win32"), "\\\\.\\pipe\\herdr.sock");
	});
});

describe("LineSplitter", () => {
	it("joins chunks that split one line", () => {
		const splitter = new LineSplitter();
		assert.deepEqual(splitter.push('{"id":"a",'), []);
		assert.deepEqual(splitter.push('"result":1}\n'), ['{"id":"a","result":1}']);
	});

	it("returns every complete line in one chunk and keeps the remainder", () => {
		const splitter = new LineSplitter();
		assert.deepEqual(splitter.push("one\ntwo\nthr"), ["one", "two"]);
		assert.deepEqual(splitter.push("ee\n"), ["three"]);
	});

	it("skips blank lines", () => {
		const splitter = new LineSplitter();
		assert.deepEqual(splitter.push("\n\nvalue\n"), ["value"]);
	});

	it("rejects a line that never ends", () => {
		const splitter = new LineSplitter(8);
		assert.throws(() => splitter.push("123456789"), /without a line break/);
	});
});

describe("parseResponse", () => {
	it("rejects a response whose id does not match the request", () => {
		const line = JSON.stringify({ id: "other", result: {} });
		assert.throws(() => parseResponse(line, "mine"), /id mismatch/);
	});

	it("rejects a response carrying neither result nor error", () => {
		assert.throws(() => parseResponse(JSON.stringify({ id: "mine" }), "mine"), /neither a result nor an error/);
	});

	it("returns the result when the id matches", () => {
		const line = JSON.stringify({ id: "mine", result: { type: "pong" } });
		assert.deepEqual(parseResponse(line, "mine"), { type: "pong" });
	});
});

describe("HerdrClient.request", () => {
	it("sends one JSONL request and parses the result", async () => {
		const payloads: string[] = [];
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => {
				payloads.push(payload);
				return ok(payload, { type: "tab_list", tabs: [] });
			},
		});
		const result = (await client.request("tab.list", { workspace_id: "w1" })) as { type: string };
		assert.equal(result.type, "tab_list");
		assert.equal(payloads.length, 1);
		const sent = JSON.parse(payloads[0]);
		assert.equal(sent.method, "tab.list");
		assert.deepEqual(sent.params, { workspace_id: "w1" });
		assert.ok(sent.id.startsWith("custom:test:tab.list:"));
	});

	it("gives every request a distinct id", async () => {
		const ids: string[] = [];
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			now: () => 1000,
			transport: async (_endpoint, payload) => {
				ids.push(idOf(payload));
				return ok(payload, {});
			},
		});
		await client.request("ping", {});
		await client.request("ping", {});
		assert.equal(new Set(ids).size, 2);
	});

	it("retries once when the request never reached the server", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => {
				calls += 1;
				if (calls === 1) throw new TransportError("connect refused", false);
				return ok(payload, { type: "tab_list", tabs: [] });
			},
		});
		await client.request("tab.list", {});
		assert.equal(calls, 2);
	});

	it("never repeats a mutation that may have reached the server", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => {
				calls += 1;
				throw new TransportError("timeout", true);
			},
		});
		await assert.rejects(client.request("pane.send_text", { pane_id: "w1:p1", text: "x" }), /timeout/);
		assert.equal(calls, 1);
	});

	it("repeats a sent request when the caller declares it idempotent", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => {
				calls += 1;
				if (calls === 1) throw new TransportError("timeout", true);
				return ok(payload, {});
			},
		});
		await client.request("pane.report_metadata", { seq: 1 }, { idempotent: true });
		assert.equal(calls, 2);
	});

	it("never retries a server error", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => {
				calls += 1;
				return fail(payload, "not_found", "no such tab");
			},
		});
		await assert.rejects(client.request("tab.get", {}, { idempotent: true }), (err) => {
			assert.ok(err instanceof HerdrError);
			assert.equal(err.code, "not_found");
			return true;
		});
		assert.equal(calls, 1);
	});

	it("passes the caller deadline to the transport", async () => {
		const timeouts: number[] = [];
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload, options) => {
				timeouts.push(options.timeoutMs);
				return ok(payload, {});
			},
		});
		await client.request("agent.wait", { target: "a" }, { timeoutMs: 60000 });
		assert.deepEqual(timeouts, [60000]);
	});

	it("forwards an abort signal", async () => {
		const controller = new AbortController();
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, _payload, options) => {
				assert.equal(options.signal, controller.signal);
				throw new TransportError("aborted", false);
			},
		});
		await assert.rejects(client.request("ping", {}, { signal: controller.signal }));
	});

	it("rejects on an empty response", async () => {
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => "",
		});
		await assert.rejects(client.request("tab.list", {}), /empty response/);
	});

	it("increments the report sequence", () => {
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => "",
			now: () => 1000,
		});
		const first = client.nextSeq();
		const second = client.nextSeq();
		assert.equal(second, first + 1);
	});
});

describe("HerdrClient.send", () => {
	it("retries once after a transport failure", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => {
				calls += 1;
				if (calls === 1) throw new TransportError("boom", true);
				return ok(payload, {});
			},
		});
		await client.send("pane.report_metadata", { seq: 1 });
		assert.equal(calls, 2);
	});

	it("drops the report when both attempts fail", async () => {
		let calls = 0;
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async () => {
				calls += 1;
				throw new TransportError("down", false);
			},
		});
		await client.send("pane.report_metadata", { seq: 1 });
		assert.equal(calls, 2);
	});

	it("drops a server error without throwing", async () => {
		const client = new HerdrClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			transport: async (_endpoint, payload) => fail(payload, "invalid_params", "bad token"),
		});
		await client.send("pane.report_metadata", { seq: 1 });
	});
});

/** A stream transport stand-in: opens connections on demand and feeds lines. */
function fakeStream() {
	const connections: { payload: string; hooks: StreamHooks; closed: boolean }[] = [];
	const transport = (_endpoint: string, payload: string, hooks: StreamHooks) => {
		const connection = { payload, hooks, closed: false };
		connections.push(connection);
		return {
			close(): void {
				if (connection.closed) return;
				connection.closed = true;
				hooks.onClose();
			},
		};
	};
	const ack = (index = connections.length - 1): void => {
		const connection = connections[index];
		connection.hooks.onLine(
			JSON.stringify({ id: JSON.parse(connection.payload).id, result: { type: "subscription_started" } }),
		);
	};
	return { connections, transport, ack };
}

describe("SubscriptionClient", () => {
	it("subscribes with the requested filters and reports readiness", async () => {
		const stream = fakeStream();
		const ready: number[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			params: { subscriptions: [{ type: "pane.agent_status_changed" }] },
			onEvent: () => {},
			onReady: (attempt) => ready.push(attempt),
			transport: stream.transport,
		});
		client.start();
		const sent = JSON.parse(stream.connections[0].payload);
		assert.equal(sent.method, "events.subscribe");
		assert.deepEqual(sent.params, { subscriptions: [{ type: "pane.agent_status_changed" }] });
		assert.deepEqual(ready, []);
		stream.ack();
		assert.deepEqual(ready, [1]);
		client.close();
	});

	it("dispatches event lines after the acknowledgement", async () => {
		const stream = fakeStream();
		const seen: string[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			onEvent: (event) => {
				seen.push(event.event);
			},
			transport: stream.transport,
		});
		client.start();
		stream.ack();
		stream.connections[0].hooks.onLine(
			JSON.stringify({ event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "w1:p2" } }),
		);
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(seen, ["pane_agent_status_changed"]);
		client.close();
	});

	it("treats a missing acknowledgement as a failed attempt and reconnects", () => {
		const stream = fakeStream();
		const timers: (() => void)[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			onEvent: () => {},
			transport: stream.transport,
			setTimer: (fn) => {
				timers.push(fn);
				return () => {};
			},
			random: () => 0,
		});
		client.start();
		stream.connections[0].hooks.onLine(JSON.stringify({ id: "wrong", result: { type: "pong" } }));
		assert.equal(stream.connections[0].closed, true);
		assert.equal(timers.length, 1);
		timers[0]();
		assert.equal(stream.connections.length, 2);
		client.close();
	});

	it("reconnects with a fresh readiness signal after the server drops the stream", () => {
		const stream = fakeStream();
		const ready: number[] = [];
		const timers: (() => void)[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			onEvent: () => {},
			onReady: (attempt) => ready.push(attempt),
			transport: stream.transport,
			setTimer: (fn) => {
				timers.push(fn);
				return () => {};
			},
			random: () => 1,
		});
		client.start();
		stream.ack();
		stream.connections[0].hooks.onClose(new Error("server closed"));
		timers[0]();
		stream.ack(1);
		assert.deepEqual(ready, [1, 2]);
		assert.notEqual(JSON.parse(stream.connections[1].payload).id, JSON.parse(stream.connections[0].payload).id);
		client.close();
	});

	it("drops the oldest event when the backlog overflows", async () => {
		const stream = fakeStream();
		const seen: string[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			queueLimit: 2,
			onEvent: async (event) => {
				if (first) {
					first = false;
					await gate;
				}
				seen.push(String((event.payload.data as { pane_id?: string }).pane_id));
			},
			transport: stream.transport,
		});
		client.start();
		stream.ack();
		for (const pane of ["p1", "p2", "p3", "p4"]) {
			stream.connections[0].hooks.onLine(
				JSON.stringify({ event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: pane } }),
			);
		}
		release?.();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(seen, ["p1", "p3", "p4"]);
		client.close();
	});

	it("stops reconnecting after close and tolerates repeated close", () => {
		const stream = fakeStream();
		const timers: (() => void)[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			onEvent: () => {},
			transport: stream.transport,
			setTimer: (fn) => {
				timers.push(fn);
				return () => {};
			},
		});
		client.start();
		stream.ack();
		client.close();
		client.close();
		stream.connections[0].hooks.onClose();
		assert.equal(timers.length, 0);
		client.start();
		assert.equal(stream.connections.length, 1);
	});

	it("ignores an unparsable line", async () => {
		const stream = fakeStream();
		const seen: string[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			onEvent: (event) => {
				seen.push(event.event);
			},
			transport: stream.transport,
		});
		client.start();
		stream.ack();
		stream.connections[0].hooks.onLine("not json");
		stream.connections[0].hooks.onLine(JSON.stringify({ event: "pane_focused", data: { type: "pane_focused" } }));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(seen, ["pane_focused"]);
		client.close();
	});

	it("re-evaluates a params provider on every open", () => {
		const stream = fakeStream();
		let pane = "w1:p2";
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			params: () => ({ subscriptions: [{ type: "pane.agent_status_changed", pane_id: pane }] }),
			onEvent: () => {},
			transport: stream.transport,
			random: () => 1,
		});
		client.start();
		assert.equal(JSON.parse(stream.connections[0].payload).params.subscriptions[0].pane_id, "w1:p2");
		pane = "w1:p3";
		client.resubscribe();
		assert.equal(JSON.parse(stream.connections[1].payload).params.subscriptions[0].pane_id, "w1:p3");
		client.close();
	});

	it("resubscribe reopens immediately without a backoff wait", () => {
		const stream = fakeStream();
		const timers: (() => void)[] = [];
		const client = new SubscriptionClient({
			endpoint: "/tmp/x.sock",
			source: "custom:test",
			onEvent: () => {},
			transport: stream.transport,
			setTimer: (fn) => {
				timers.push(fn);
				return () => {};
			},
			random: () => 1,
		});
		client.start();
		stream.ack();
		client.resubscribe();
		assert.equal(stream.connections.length, 2, "a new connection opened at once");
		assert.equal(timers.length, 0, "no backoff timer was scheduled");
		stream.ack(1);
		client.close();
	});
});
