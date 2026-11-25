import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { connectTransport } from "../../transport/index.ts";
import { connectHost, type HostConnection } from "./host-client.ts";
import { eventLog, fixtureMetadata } from "./host-fixture.mts";
import { HOST_CONTRACT_MEMBER, hostPaths } from "./host-protocol.ts";
import { runHost, type HostRuntime } from "./host-process.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { manualClock } from "./observation-clock-fixture.mts";
import { observeClaim } from "./claims.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(
	t: { after(fn: () => void | Promise<void>): void },
	runtime: HostRuntime,
	idleMs = 10,
	clock?: ReturnType<typeof manualClock>,
) {
	const root = mkdtempSync(join(tmpdir(), "host-retirement-"));
	let cleanup = async (): Promise<void> => {};
	t.after(async () => {
		await cleanup();
		rmSync(root, { recursive: true, force: true });
	});
	const metadata = fixtureMetadata(root);
	const checks = eventLog<{ fire(): void; cancelled: boolean }>();
	const host = await runHost(() => runtime, {
		metadata,
		idleMs,
		observationClock: clock,
		announceReady: () => {},
		scheduleIdleCheck: (fire) => {
			const entry = { fire, cancelled: false };
			checks.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
	});
	cleanup = () => host.close().catch(() => {});
	return { metadata, host, checks };
}

async function rawClient(
	t: { after(fn: () => void | Promise<void>): void },
	metadata: ReturnType<typeof fixtureMetadata>,
) {
	const paths = hostPaths(metadata);
	const link = await connectTransport({ serverId: paths.serverId, path: paths.socket });
	t.after(() => link.dispose());
	return {
		status: (requestId: string) =>
			link.request({ method: "status", requestId, contract: HOST_CONTRACT.operations.status }),
		fence: () => link.request({ method: HOST_CONTRACT_MEMBER, requestId: "fence" }),
		subscribe: () => link.subscribe("changes", undefined, () => {}),
	};
}

it("retires with passive clients and change subscriptions without cancelling their idle window", {
	timeout: 3000,
}, async (t) => {
	const f = await fixture(t, { request: async () => ({}), isIdle: () => true, close: async () => {} });
	const clients = await Promise.all([
		connectHost(f.metadata, { retryAttempts: 0 }),
		connectHost(f.metadata, { retryAttempts: 0 }),
	]);
	for (const client of clients) t.after(() => client.close());
	await Promise.all(
		clients.map((client) => {
			assert.ok(client.subscribeChanges);
			return client.subscribeChanges(() => {});
		}),
	);
	assert.equal(f.checks[0].cancelled, false, "passive attachment does not reset the idle interval");
	const lost = clients.map((client) => new Promise<void>((resolve) => client.onClose(resolve)));
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
	await Promise.all(lost);
	assert.equal(existsSync(hostPaths(f.metadata).claim), true);
	assert.equal(observeClaim(hostPaths(f.metadata).claim, hostPaths(f.metadata).identity).kind, "dead");
	assert.equal(existsSync(hostPaths(f.metadata).socket), false);
	assert.ok(clients.every((client) => client.closed));
});

it("retires both hosts in a passive peer connection cycle", { timeout: 3000 }, async (t) => {
	let toFirst: HostConnection | undefined;
	let toSecond: HostConnection | undefined;
	const first = await fixture(t, {
		request: async () => ({}),
		isIdle: () => true,
		close: async () => {
			await toSecond?.close();
		},
	});
	const second = await fixture(t, {
		request: async () => ({}),
		isIdle: () => true,
		close: async () => {
			await toFirst?.close();
		},
	});
	toFirst = await connectHost(first.metadata, { retryAttempts: 0 });
	toSecond = await connectHost(second.metadata, { retryAttempts: 0 });
	t.after(() => toFirst?.close());
	t.after(() => toSecond?.close());
	const lost = [toFirst, toSecond].map((client) => new Promise<void>((resolve) => client.onClose(resolve)));
	first.checks[first.checks.length - 1].fire();
	second.checks[second.checks.length - 1].fire();
	await Promise.all([first.host.done, second.host.done, ...lost]);
	assert.ok(toFirst.closed && toSecond.closed);
});

it("finishes an in-flight read and refuses paused reads only after the seal", { timeout: 3000 }, async (t) => {
	const started = deferred();
	const release = deferred();
	t.after(release.resolve);
	let reads = 0;
	const f = await fixture(t, {
		request: async () => {
			reads++;
			started.resolve();
			await release.promise;
			return { read: "x".repeat(512 * 1024) };
		},
		isIdle: () => true,
		close: async () => {},
	});
	const link = await rawClient(t, f.metadata);
	const reading = link.status("first");
	await started.promise;
	f.checks[0].fire();
	const refused = assert.rejects(link.status("second"), /shutting down/u);
	await link.fence();
	assert.equal(reads, 1);
	release.resolve();
	assert.deepEqual(await reading, { read: "x".repeat(512 * 1024) });
	await refused;
	await f.host.done;
	assert.equal(reads, 1);
	assert.equal(f.checks.length, 1, "the reply does not start another interval");
});

it("serves passive reads at the idle deadline when native work is already busy", { timeout: 3000 }, async (t) => {
	let attempted = false;
	const f = await fixture(t, {
		request: async () => ({ busy: true }),
		isIdle: () => false,
		tryRetire: async () => {
			attempted = true;
			return false;
		},
		close: async () => {},
	});
	const link = await rawClient(t, f.metadata);
	const reading = link.status("busy");
	f.checks[0].fire();
	assert.deepEqual(await reading, { busy: true });
	assert.equal(attempted, false, "known busy work skips the asynchronous check");
	assert.equal(f.checks.length, 2);
});

it("serves paused reads and subscriptions on the same writer after a refused check", { timeout: 3000 }, async (t) => {
	const checking = deferred();
	const checkDone = deferred();
	t.after(checkDone.resolve);
	let reads = 0;
	let busy = false;
	const f = await fixture(t, {
		request: async () => {
			reads++;
			return { busy };
		},
		isIdle: () => !busy,
		tryRetire: async (seal) => {
			checking.resolve();
			await checkDone.promise;
			return !busy && seal();
		},
		close: async () => {},
	});
	const link = await rawClient(t, f.metadata);
	const hello = await link.fence();
	f.checks[0].fire();
	await checking.promise;
	busy = true;
	const reading = link.status("during-check");
	const subscription = link.subscribe();
	void reading.catch(() => {});
	void subscription.catch(() => {});
	assert.deepEqual(await link.fence(), hello);
	assert.equal(reads, 0);
	checkDone.resolve();
	assert.deepEqual(await reading, { busy: true });
	await subscription;
	assert.deepEqual(await link.fence(), hello);
	assert.equal(reads, 1);
	assert.equal(f.checks.length, 2);
});

it("reopens passive admission after a refused release until real quiescence", { timeout: 3000 }, async (t) => {
	const checking = deferred();
	const checkDone = deferred();
	t.after(checkDone.resolve);
	let quiescent = () => {};
	let eligible = false;
	let checks = 0;
	const f = await fixture(
		t,
		{
			request: async () => ({ available: true }),
			isIdle: () => eligible,
			releaseRequested: true,
			onQuiescent: (listener) => {
				quiescent = listener;
				return () => {};
			},
			tryRetire: async (seal) => {
				checks++;
				if (eligible) return seal();
				checking.resolve();
				await checkDone.promise;
				return false;
			},
			close: async () => {},
		},
		0,
	);
	const link = await rawClient(t, f.metadata);
	await checking.promise;
	const reading = link.status("during-release");
	void reading.catch(() => {});
	await link.fence();
	checkDone.resolve();
	assert.deepEqual(await reading, { available: true });
	assert.deepEqual(await link.status("after-release-check"), { available: true });
	assert.equal(checks, 1);
	eligible = true;
	quiescent();
	await f.host.done;
	assert.equal(checks, 2);
});

for (const resume of ["activity", "refused check"] as const)
	it(`publishes one deferred observation frame after ${resume}`, { timeout: 3000 }, async (t) => {
		const checking = deferred();
		const checkDone = deferred();
		t.after(checkDone.resolve);
		let changed = () => {};
		let active = () => {};
		let revision = 1;
		let frameReads = 0;
		const clock = manualClock();
		const f = await fixture(
			t,
			{
				request: async (method, params) => {
					if (method === "observe-open") return { token: (params as { token: string }).token };
					if (method !== "observe-frame") return {};
					frameReads++;
					return {
						scope: "tasks",
						storageId: "fixture",
						revision,
						observedAt: new Date().toISOString(),
						tasks: [],
						labels: [],
						coverage: { complete: true, live: true },
					};
				},
				isIdle: () => true,
				tryRetire: async () => {
					checking.resolve();
					await checkDone.promise;
					return false;
				},
				onObservationChange: (listener) => {
					changed = listener;
					return () => {};
				},
				onActivity: (listener) => {
					active = listener;
					return () => {};
				},
				close: async () => {},
			},
			10,
			clock,
		);
		const client = await connectHost(f.metadata, { retryAttempts: 0 });
		t.after(() => client.close());
		assert.ok(client.observe);
		const observation = await client.observe({ scope: "tasks", sessionId: f.metadata.storageId });
		const delivered = deferred();
		observation.onFrame((frame) => {
			if (frame?.revision === 2) delivered.resolve();
		});
		clock.advance(0);
		await new Promise<void>(setImmediate);
		f.checks[0].fire();
		await checking.promise;
		const before = frameReads;
		revision++;
		changed();
		clock.advance(1000);
		await new Promise<void>(setImmediate);
		assert.equal(frameReads, before, "the change reaches the pump while admission is paused");
		if (resume === "activity") active();
		else checkDone.resolve();
		await f.checks.waitForCount(2);
		clock.advance(1000);
		await delivered.promise;
		assert.equal(frameReads, before + 1);
		checkDone.resolve();
	});

it("releases the last open observation token on retirement, even before subscription", {
	timeout: 3000,
}, async (t) => {
	let counter = 0;
	const tokens = new Set<string>();
	const f = await fixture(t, {
		request: async (method, params) => {
			if (method === "observe-open") {
				const token = `token-${++counter}`;
				tokens.add(token);
				return { token };
			}
			if (method === "observe-close") tokens.delete((params as { token: string }).token);
			return {};
		},
		isIdle: () => true,
		close: async () => {
			assert.equal(tokens.size, 0);
		},
	});
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const first = (await client.request("observe-open", { scope: "tasks" })) as { token: string };
	await client.request("observe-open", { scope: "tasks" });
	await client.request("observe-close", first);
	assert.equal(tokens.size, 1);
	assert.equal(f.checks.length, 1, "observation setup and close do not reset the deadline");
	f.checks[0].fire();
	await f.host.done;
	assert.equal(tokens.size, 0);
});

it("releases a token after observation subscription setup fails", { timeout: 3000 }, async (t) => {
	const f = await fixture(t, {
		request: async (method) => (method === "observe-open" ? { token: "bad-frame" } : {}),
		isIdle: () => true,
		close: async () => {},
	});
	const paths = hostPaths(f.metadata);
	const client = await connectTransport({ serverId: paths.serverId, path: paths.socket });
	t.after(() => client.dispose());
	await client.request({
		method: "observe-open",
		params: { scope: "tasks" },
		requestId: "open",
		contract: HOST_CONTRACT.operations["observe-open"],
	});
	await assert.rejects(client.subscribe("observation", "bad-frame", () => {}));
	// A normal change subscription is not a conversation or task observation.
	await client.subscribe("changes", undefined, () => {});
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

for (const [method, params] of [
	["submit", { message: "new work" }],
	["attach", { model: { provider: "fixture", modelId: "selected" } }],
] as const)
	it(`lets a concurrent ${method} invalidate an asynchronous retirement check`, { timeout: 3000 }, async (t) => {
		const checking = deferred();
		const release = deferred();
		t.after(release.resolve);
		let closed = false;
		const f = await fixture(t, {
			request: async () => ({}),
			isIdle: () => true,
			tryRetire: async (seal) => {
				checking.resolve();
				await release.promise;
				return seal();
			},
			close: async () => {
				closed = true;
			},
		});
		const client = await connectHost(f.metadata, { retryAttempts: 0 });
		t.after(() => client.close());
		f.checks[f.checks.length - 1].fire();
		await checking.promise;
		const count = f.checks.length;
		await client.request(method, params);
		release.resolve();
		await f.checks.waitForCount(count + 1);
		assert.equal(closed, false, "an active request invalidates the old idle generation");
		f.checks[f.checks.length - 1].fire();
		await f.host.done;
	});

it("cleans an observation opened after its attachment disconnects", { timeout: 3000 }, async (t) => {
	const opening = deferred();
	const release = deferred();
	t.after(release.resolve);
	let released = false;
	const f = await fixture(t, {
		request: async (method) => {
			if (method === "observe-open") {
				opening.resolve();
				await release.promise;
				return { token: "late-token" };
			}
			if (method === "observe-close") released = true;
			return {};
		},
		isIdle: () => true,
		close: async () => {
			assert.equal(released, true);
		},
	});
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	const pending = client.request("observe-open", { scope: "tasks" });
	const failed = assert.rejects(pending);
	await opening.promise;
	await client.close();
	await failed;
	f.checks[f.checks.length - 1].fire();
	release.resolve();
	await f.host.done;
});

for (const boundary of ["observe-open", "observe-frame"] as const)
	it(`releases an observation aborted during ${boundary} setup`, { timeout: 3000 }, async (t) => {
		const entered = deferred();
		const release = deferred();
		t.after(release.resolve);
		const tokens = new Set<string>();
		const frame = {
			scope: "tasks",
			storageId: "fixture",
			revision: 1,
			observedAt: new Date().toISOString(),
			tasks: [],
			labels: [],
			coverage: { complete: true, live: true },
		};
		const f = await fixture(t, {
			request: async (method, params) => {
				const token = (params as { token?: string } | undefined)?.token;
				if (method === "observe-open" && token) tokens.add(token);
				if (method === boundary) {
					entered.resolve();
					await release.promise;
				}
				if (method === "observe-close" && token) tokens.delete(token);
				if (method === "observe-frame") return frame;
				return { token, frame };
			},
			isIdle: () => true,
			close: async () => {
				assert.equal(tokens.size, 0);
			},
		});
		const client = await connectHost(f.metadata, { retryAttempts: 0 });
		t.after(() => client.close());
		assert.ok(client.observe);
		const controller = new AbortController();
		const opening = client.observe({ scope: "tasks", sessionId: f.metadata.storageId }, { signal: controller.signal });
		await entered.promise;
		controller.abort();
		release.resolve();
		await assert.rejects(opening, /abort/u);
		f.checks[f.checks.length - 1].fire();
		await f.host.done;
	});

it("marks a failed live frame unavailable and releases its token without closing the client", {
	timeout: 3000,
}, async (t) => {
	let fail = false;
	const listeners = new Set<() => void>();
	const frame = {
		scope: "tasks",
		storageId: "fixture",
		revision: 1,
		observedAt: new Date().toISOString(),
		tasks: [],
		labels: [],
		coverage: { complete: true, live: true },
	};
	const f = await fixture(t, {
		request: async (method, params) => {
			if (method === "observe-frame" && fail) throw new Error("observation source closed");
			if (method === "observe-frame") return frame;
			if (method === "observe-open") return { token: (params as { token: string }).token, frame };
			return {};
		},
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isIdle: () => true,
		close: async () => {},
	});
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.ok(client.observe);
	const observation = await client.observe({ scope: "tasks", sessionId: f.metadata.storageId });
	const unavailable = deferred();
	observation.onFrame((_frame, _fresh, state) => {
		if (state === "unavailable") unavailable.resolve();
	});
	fail = true;
	for (const listener of listeners) listener();
	await unavailable.promise;
	assert.equal(client.closed, false);
	await client.request("status");
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("leaves retirement disabled at zero even with passive clients", async (t) => {
	const f = await fixture(t, { request: async () => ({}), isIdle: () => true, close: async () => {} }, 0);
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("status");
	assert.equal(f.checks.length, 0);
});
