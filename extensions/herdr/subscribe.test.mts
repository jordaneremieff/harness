import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamHooks, SubscriptionEvent } from "./socket.ts";
import {
	AttentionLoop,
	AttentionManager,
	isForeignWorkspace,
	parseAgentStatus,
} from "./subscribe.ts";

function statusEvent(overrides: Record<string, unknown> = {}): SubscriptionEvent {
	return {
		event: "pane_agent_status_changed",
		payload: {
			event: "pane_agent_status_changed",
			data: {
				type: "pane_agent_status_changed",
				pane_id: "w1:p2",
				workspace_id: "w1",
				agent_status: "blocked",
				agent: "claude",
				display_agent: "reviewer",
				...overrides,
			},
		},
	};
}

function createdEvent(paneId: string, workspaceId = "w1"): SubscriptionEvent {
	return {
		event: "pane_created",
		payload: { event: "pane_created", data: { type: "pane_created", pane: { pane_id: paneId, workspace_id: workspaceId } } },
	};
}

function closedEvent(paneId: string): SubscriptionEvent {
	return {
		event: "pane_closed",
		payload: { event: "pane_closed", data: { type: "pane_closed", pane_id: paneId, workspace_id: "w1" } },
	};
}

function recorder(now: () => number = () => 0) {
	const notified: string[] = [];
	const statuses: (string | undefined)[] = [];
	const loop = new AttentionLoop({
		paneId: "w1:p1",
		workspaceId: "w1",
		notify: (message) => notified.push(message),
		setStatus: (text) => statuses.push(text),
		now,
	});
	return { loop, notified, statuses };
}

describe("parseAgentStatus", () => {
	it("reads the pane, workspace, state, and display label", () => {
		const change = parseAgentStatus(statusEvent());
		assert.deepEqual(change, {
			paneId: "w1:p2",
			workspaceId: "w1",
			status: "blocked",
			agent: "claude",
			label: "reviewer",
		});
	});

	it("falls back to the agent kind and then the pane id", () => {
		assert.equal(parseAgentStatus(statusEvent({ display_agent: null, title: null }))?.label, "claude");
		assert.equal(parseAgentStatus(statusEvent({ display_agent: null, title: null, agent: null }))?.label, "w1:p2");
	});

	it("ignores an unrelated event and a malformed payload", () => {
		assert.equal(parseAgentStatus({ event: "pane_focused", payload: {} }), undefined);
		assert.equal(parseAgentStatus(statusEvent({ agent_status: 7 })), undefined);
	});

	it("flags a workspace other than the session's own", () => {
		assert.equal(isForeignWorkspace("w2", "w1"), true);
		assert.equal(isForeignWorkspace("w1", "w1"), false);
		assert.equal(isForeignWorkspace("w2", undefined), false);
	});
});

describe("AttentionLoop", () => {
	it("announces a blocked sibling once", () => {
		const { loop, notified, statuses } = recorder();
		assert.equal(loop.handle(statusEvent()), true);
		assert.equal(loop.handle(statusEvent()), false);
		assert.deepEqual(notified, ["reviewer blocked"]);
		assert.deepEqual(statuses, ["herdr: reviewer blocked"]);
	});

	it("announces again after the agent leaves the state", () => {
		let clock = 0;
		const { loop, notified } = recorder(() => clock);
		loop.handle(statusEvent());
		loop.handle(statusEvent({ agent_status: "working" }));
		clock = 10000;
		loop.handle(statusEvent());
		assert.deepEqual(notified, ["reviewer blocked", "reviewer blocked"]);
	});

	it("ignores its own pane and a foreign workspace", () => {
		const { loop, notified } = recorder();
		assert.equal(loop.handle(statusEvent({ pane_id: "w1:p1" })), false);
		assert.equal(loop.handle(statusEvent({ pane_id: "w2:p1", workspace_id: "w2" })), false);
		assert.deepEqual(notified, []);
	});

	it("ignores states that need no attention", () => {
		const { loop, notified } = recorder();
		loop.handle(statusEvent({ agent_status: "working" }));
		loop.handle(statusEvent({ agent_status: "idle" }));
		assert.deepEqual(notified, []);
	});

	it("announces a finished sibling", () => {
		const { loop, notified } = recorder();
		loop.handle(statusEvent({ agent_status: "done" }));
		assert.deepEqual(notified, ["reviewer done"]);
	});

	it("throttles notifications but keeps the status current", () => {
		let clock = 1000;
		const { loop, notified, statuses } = recorder(() => clock);
		loop.handle(statusEvent());
		clock = 2000;
		loop.handle(statusEvent({ pane_id: "w1:p3", display_agent: "builder", agent_status: "done" }));
		assert.deepEqual(notified, ["reviewer blocked"]);
		assert.deepEqual(statuses, ["herdr: reviewer blocked", "herdr: builder done"]);
		clock = 20000;
		loop.handle(statusEvent({ pane_id: "w1:p4", display_agent: "tester", agent_status: "done" }));
		assert.deepEqual(notified, ["reviewer blocked", "tester done"]);
	});

	it("speaks again after a reconnect", () => {
		let clock = 0;
		const { loop, notified } = recorder(() => clock);
		loop.handle(statusEvent());
		loop.reset();
		clock = 10000;
		loop.handle(statusEvent());
		assert.deepEqual(notified, ["reviewer blocked", "reviewer blocked"]);
	});

	it("watches every workspace when none is known", () => {
		const notified: string[] = [];
		const loop = new AttentionLoop({
			paneId: "w1:p1",
			workspaceId: undefined,
			notify: (message) => notified.push(message),
			setStatus: () => {},
			now: () => 0,
		});
		loop.handle(statusEvent({ pane_id: "w2:p1", workspace_id: "w2" }));
		assert.deepEqual(notified, ["reviewer blocked"]);
	});
});

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
	const line = (index: number, event: SubscriptionEvent): void => {
		connections[index].hooks.onLine(JSON.stringify(event.payload));
	};
	return { connections, transport, ack, line };
}

function managerDeps(overrides: Partial<ConstructorParameters<typeof AttentionManager>[0]> = {}) {
	const notified: string[] = [];
	const statuses: (string | undefined)[] = [];
	const stream = fakeStream();
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const panes: { pane_id: string; workspace_id: string }[] = [
		{ pane_id: "w1:p2", workspace_id: "w1" },
		{ pane_id: "w1:p1", workspace_id: "w1" },
	];
	const client = {
		async request(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
			return { panes };
		},
		async send() {},
		nextSeq: () => 1,
	};
	const timers: (() => void)[] = [];
	const deps: ConstructorParameters<typeof AttentionManager>[0] = {
		client: client as never,
		endpoint: "/tmp/x.sock",
		source: "custom:pi-identity",
		paneId: "w1:p1",
		workspaceId: "w1",
		notify: (message) => notified.push(message),
		setStatus: (text) => statuses.push(text),
		now: () => 0,
		transport: stream.transport,
		setTimer: (fn) => {
			timers.push(fn);
			return () => {};
		},
		refreshDelayMs: 1,
		...overrides,
	};
	return { deps, notified, statuses, stream, calls, panes, timers };
}

/** Fire every coalesced refresh and let the pane.list round trip settle. */
async function fireRefreshes(timers: (() => void)[]): Promise<void> {
	while (timers.length > 0) {
		timers.shift()!();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("AttentionManager", () => {
	it("seeds the sibling set from pane.list and subscribes per pane", async () => {
		const { deps, stream, calls } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		assert.deepEqual(manager.watchedPanes(), ["w1:p2"]);
		assert.deepEqual(calls[0], { method: "pane.list", params: { workspace_id: "w1" } });
		const sent = JSON.parse(stream.connections[0].payload);
		assert.deepEqual(sent.params.subscriptions, [
			{ type: "pane.created" },
			{ type: "pane.closed" },
			{ type: "pane.agent_status_changed", pane_id: "w1:p2" },
		]);
		manager.close();
	});

	it("forwards a sibling status event to the loop", async () => {
		const { deps, notified, stream } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		stream.line(0, statusEvent());
		assert.deepEqual(notified, ["reviewer blocked"]);
		manager.close();
	});

	it("widens the probe set when a new pane appears", async () => {
		const { deps, stream, panes, timers } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		panes.push({ pane_id: "w1:p3", workspace_id: "w1" });
		stream.line(0, createdEvent("w1:p3"));
		await fireRefreshes(timers);
		assert.deepEqual(manager.watchedPanes(), ["w1:p2", "w1:p3"]);
		const second = JSON.parse(stream.connections[1].payload);
		assert.ok(second.params.subscriptions.some((s: { pane_id?: string }) => s.pane_id === "w1:p3"));
		manager.close();
	});

	it("narrows the probe set when a pane closes", async () => {
		const { deps, stream, panes, timers } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		panes.push({ pane_id: "w1:p3", workspace_id: "w1" });
		stream.line(0, createdEvent("w1:p3"));
		await fireRefreshes(timers);
		assert.equal(stream.connections.length, 2);
		stream.ack(1);
		panes.pop();
		stream.line(1, closedEvent("w1:p3"));
		await fireRefreshes(timers);
		assert.deepEqual(manager.watchedPanes(), ["w1:p2"]);
		manager.close();
	});

	it("ignores a pane created in another workspace", async () => {
		const { deps, stream, timers } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		stream.line(0, createdEvent("w2:p1", "w2"));
		await fireRefreshes(timers);
		assert.deepEqual(manager.watchedPanes(), ["w1:p2"]);
		assert.equal(stream.connections.length, 1, "no resubscribe for a foreign pane");
		manager.close();
	});

	it("does not resubscribe when the pane set did not change", async () => {
		const { deps, stream, timers } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		stream.line(0, createdEvent("w1:p2"));
		await fireRefreshes(timers);
		assert.equal(stream.connections.length, 1);
		manager.close();
	});

	it("converges when the subscribe replay echoes stale pane events", async () => {
		const { deps, stream, timers } = managerDeps();
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		// Every connect replays recent history: a pane long closed appears
		// as created, closed, and created again in one burst.
		stream.line(0, createdEvent("w1:p9"));
		stream.line(0, closedEvent("w1:p9"));
		stream.line(0, createdEvent("w1:p9"));
		await fireRefreshes(timers);
		assert.deepEqual(manager.watchedPanes(), ["w1:p2"], "the live pane list wins over the replay");
		assert.equal(stream.connections.length, 1, "one burst schedules one refresh and no resubscribe");
		manager.close();
	});

	it("heals an empty seed when pane.list recovers", async () => {
		let fail = true;
		const { deps, stream, timers } = managerDeps({
			client: {
				async request(_method: string, _params: Record<string, unknown>) {
					if (fail) {
						fail = false;
						throw new Error("down");
					}
					return { panes: [{ pane_id: "w1:p2", workspace_id: "w1" }] };
				},
				send: async () => {},
				nextSeq: () => 1,
			} as never,
		});
		const manager = new AttentionManager(deps);
		await manager.start();
		stream.ack();
		assert.deepEqual(manager.watchedPanes(), []);
		stream.line(0, createdEvent("w1:p2"));
		await fireRefreshes(timers);
		assert.deepEqual(manager.watchedPanes(), ["w1:p2"]);
		manager.close();
	});
});
