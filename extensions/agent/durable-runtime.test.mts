/**
 * Production durable-runtime SIGKILL tests.
 *
 * Each test launches the real `durable-runner.ts` through `acquireHost` with a
 * fixture agent home whose settings load the faux provider and unsafe effect
 * tool from `testdata/durable-runtime`. The test kills the host process at a
 * durable checkpoint, relaunches through `acquireHost`, and checks resumption,
 * deduplication, the single unsafe effect, the retained result, and owner
 * delivery acknowledgement.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { createPrimaryChannel, primaryEndpointPath } from "./primary-channel.ts";
import { PRIMARY_DELIVERY_CONTRACT } from "./version-contract.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { observeClaim } from "./claims.ts";
import { hostPaths } from "./host-protocol.ts";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import { observeDurableStorage } from "./durable-runtime.ts";
import { childCatalogRecord, killHost, markerFixture, runtimeFixture, trackHost, waitForReceipt } from "./durable-runtime-fixture.mts";
import { publishFixtureMarker } from "./testdata/durable-runtime/signal.ts";
import type { AwaitFact } from "./await-facts.ts";

interface SubmitResult {
	readonly submissionId: string | number;
	readonly deduped: boolean;
}

interface HistoryPage {
	readonly entries: readonly unknown[];
}

interface ReceiptsPage {
	readonly receipts: readonly unknown[];
}

interface AcknowledgeResult {
	readonly acknowledged: readonly unknown[];
}

interface SearchPage {
	readonly matches: readonly unknown[];
}

/** Reject when `ready` does not settle before the public deadline signal fires. */
async function within(ready: Promise<void>, timeoutMs: number, message: string): Promise<void> {
	const deadline = AbortSignal.timeout(timeoutMs);
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(new Error(message));
		deadline.addEventListener("abort", onAbort, { once: true });
		ready.then(
			() => {
				deadline.removeEventListener("abort", onAbort);
				resolve();
			},
			(error) => {
				deadline.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function publishedAwait(client: HostConnection, sessionId: string, predicate: (fact: AwaitFact) => boolean): Promise<AwaitFact> {
	assert.ok(client.subscribeChanges);
	let resolve!: (fact: AwaitFact) => void; let reject!: (error: unknown) => void;
	const ready = new Promise<AwaitFact>((yes, no) => { resolve = yes; reject = no; });
	const signal = AbortSignal.timeout(15000);
	const stalled = () => { void client.request("status", { sessionId }).then((value) => reject(new Error(`Await observation deadline: ${JSON.stringify(value)}`)), reject); };
	signal.addEventListener("abort", stalled, { once: true });
	const stop = await client.subscribeChanges(() => {
		void client.request("status", { sessionId }).then((value) => {
			const fact = (value as { conversation?: { awaiting?: AwaitFact } }).conversation?.awaiting;
			if (fact !== undefined && predicate(fact)) resolve(fact);
		}, reject);
	}, signal);
	try { return await ready; } finally { stop(); signal.removeEventListener("abort", stalled); }
}

for (const locality of ["local", "foreign"] as const) it(`propagates native retry facts for a ${locality} producer and clears them on abort`, { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true, retry: true });
	const source = await acquireHost(f.metadata, { env: f.env(locality === "local" ? "await-local" : "retry") }); trackHost(t, source.pid);
	let consumer: HostConnection | undefined;
	try {
		if (locality === "local") {
			const ready = publishedAwait(source, f.metadata.storageId, (fact) => fact.producers.some((producer) => producer.execution !== undefined));
			await source.request("submit", { message: "START_AWAIT_LOCAL", requestId: "retry-owner", ownerId: f.ownerId, origin: "operator" });
			const fact = await ready;
			const execution = fact.producers.find((producer) => producer.execution)?.execution; assert.ok(execution);
			assert.deepEqual(execution.results, fact.results.map((item) => item.result));
			assert.equal(fact.results[0].status, "pending"); assert.equal(execution.attempt, 1); assert.equal(execution.maxAttempts, 21);
			assert.match(execution.error, /429.*Weekly\/Monthly Limit Exhausted/u);
			const producer = execution.results[0].sessionId;
			await source.request("abort", { sessionId: producer });
			await waitForReceipt(source, f.ownerId, fact.heldInputs[0], 5000);
			assert.deepEqual(await source.request("await-state", { sessionId: producer, results: execution.results }), {});
			const status = await source.request("status", { sessionId: f.metadata.storageId }) as { conversation: { awaiting?: AwaitFact } };
			assert.equal(status.conversation.awaiting, undefined);
		} else {
			const record = new AgentCatalog(f.root).create({ cwd: f.cwd, agentDir: f.agentDir, packageDir: f.metadata.packageDir, model: f.metadata.model, thinkingLevel: "off", name: "retry consumer", trust: true, ownerId: f.ownerId }, "retry-consumer");
			consumer = await acquireHost(hostMetadata(record), { env: f.env("await-reference") }); trackHost(t, consumer.pid);
			const admitted = await source.request("submit", { message: "HELD", requestId: "retry-source", ownerId: record.storageId, origin: "operator" }) as SubmitResult;
			const reference = { sessionId: f.metadata.storageId, submissionId: Number(admitted.submissionId), requestId: "retry-source" };
			const ready = publishedAwait(consumer, record.storageId, (fact) => fact.producers.some((producer) => producer.execution !== undefined));
			const requested = await consumer.request("submit", { message: `AWAIT_REFERENCE:${JSON.stringify(reference)}`, requestId: "retry-consumer", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
			const fact = await ready; const producer = fact.producers[0]; assert.ok(producer.execution);
			assert.deepEqual(producer.execution.results, [reference]); assert.equal(fact.results[0].status, "pending");
			assert.equal(producer.execution.model?.provider, f.metadata.model.provider); assert.ok(producer.observedAt > 0);
			const queued = await source.request("submit", { message: "QUEUED", requestId: "queued-source", ownerId: record.storageId, origin: "operator", whenBusy: "followUp" }) as SubmitResult;
			const unrelated = await source.request("await-state", { results: [{ ...reference, submissionId: Number(queued.submissionId), requestId: "queued-source" }] });
			assert.deepEqual(unrelated, {}, "a queued input does not own the active retry");
			await source.request("abort", { sessionId: f.metadata.storageId });
			const settled = await waitForReceipt(consumer, f.ownerId, requested.submissionId, 5000);
			assert.equal(settled.status, "done"); assert.equal(settled.answer, "AWAIT_FINISHED");
			const status = await consumer.request("status", { sessionId: record.storageId }) as { conversation: { awaiting?: AwaitFact } };
			assert.equal(status.conversation.awaiting, undefined);
		}
	} finally { await consumer?.close().catch(() => {}); await source.close().catch(() => {}); }
});

it("observes a foreign native await in one hop and releases the selected source request through RPC", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const remoteRecord = new AgentCatalog(f.root).create({ cwd: f.cwd, agentDir: f.agentDir, packageDir: f.metadata.packageDir, model: f.metadata.model, thinkingLevel: "off", name: "foreign await observer", trust: true, ownerId: f.ownerId }, "foreign-observer");
	const source = await acquireHost(f.metadata, { env: f.env("await-local") }); trackHost(t, source.pid);
	const consumer = await acquireHost(hostMetadata(remoteRecord), { env: f.env("await-reference") }); trackHost(t, consumer.pid);
	try {
		const sourceReady = publishedAwait(source, f.metadata.storageId, () => true);
		const admitted = await source.request("submit", { message: "START_AWAIT_LOCAL", requestId: "source-original", ownerId: remoteRecord.storageId, origin: "operator" }) as SubmitResult;
		const own = await sourceReady;
		const consumerReady = publishedAwait(consumer, remoteRecord.storageId, (fact) => fact.producers.some((item) => item.sessionId === f.metadata.storageId && item.awaiting?.runId === own.runId));
		const reference = { sessionId: f.metadata.storageId, submissionId: Number(admitted.submissionId), requestId: "source-original" };
		const requested = await consumer.request("submit", { message: `AWAIT_REFERENCE:${JSON.stringify(reference)}`, requestId: "consumer-original", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const observed = await consumerReady;
		const producer = observed.producers.find((item) => item.sessionId === f.metadata.storageId); assert.ok(producer?.awaiting);
		assert.deepEqual(producer.awaiting.heldInputs, [Number(admitted.submissionId)]);
		assert.equal(producer.awaiting.results[0].status, "pending"); assert.equal("producers" in producer.awaiting, false);
		assert.equal(producer.source, "producer await-state"); assert.ok(producer.observedAt > 0); assert.equal(observed.coverage, "one hop; remote graph incomplete");
		assert.deepEqual(await source.request("await-release", { expectedRunId: own.runId + 1 }), { released: false });
		const released = await source.request("await-release", { expectedRunId: own.runId }) as { released: boolean; awaiting: AwaitFact };
		assert.equal(released.released, true); assert.equal(released.awaiting.runId, own.runId);
		const settled = await waitForReceipt(consumer, f.ownerId, requested.submissionId, 5000); assert.equal(settled.status, "done"); assert.equal(settled.answer, "AWAIT_FINISHED");
		const after = await source.request("await-state", {}); assert.deepEqual(after, {});
		const child = own.results[0].result;
		const childStatus = await source.request("status", { sessionId: child.sessionId }) as { conversation: { busy: boolean } };
		assert.equal(childStatus.conversation.busy, true, "release does not cancel or dispatch the producer");
	} catch (error) {
		const states = await Promise.allSettled([observeDurableStorage(f.metadata, "status", { sessionId: f.metadata.storageId }), observeDurableStorage(hostMetadata(remoteRecord), "status", { sessionId: remoteRecord.storageId })]);
		throw new Error(`${String(error)}\nNative source/consumer states: ${JSON.stringify(states).slice(0, 16000)}`);
	} finally { await consumer.close().catch(() => {}); await source.close().catch(() => {}); }
});

it("reads a cold observation without bootstrapping contributions", { timeout: 180000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	try {
		const submitted = await primary.request("submit", { message: "OBSERVE_ME", requestId: "observe-owner", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
	} finally {
		await primary.close().catch(() => {});
	}
	const marker = join(f.testDir, "observation-create.txt");
	process.env.DURABLE_TEST_CREATE_MARKER = marker;
	try {
		const observed = await observeDurableStorage(f.metadata, "status", { sessionId: f.metadata.storageId }) as { live: boolean; storageId: string; conversation?: unknown };
		assert.equal(observed.live, false);
		assert.equal(observed.storageId, f.metadata.storageId);
		assert.ok(observed.conversation, "the cold status carries the retained conversation");
	} finally {
		delete process.env.DURABLE_TEST_CREATE_MARKER;
	}
	assert.equal(existsSync(marker), false, "the cold read ran no contribution create");
});

it("spawns a cross-cwd child in an independent storage and delivers its result to the owner conversation", { timeout: 180000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const primary = await acquireHost(f.metadata, { env: f.env("spawn") });
	trackHost(t, primary.pid);
	try {
		const submitted = await primary.request("submit", { message: "SPAWN_CHILD: start the child and report back", requestId: "spawn-owner" }) as SubmitResult;
		assert.equal(submitted.deduped, false);
		await f.marker("delivered");
		const record = await childCatalogRecord(f);
		assert.notEqual(record.storageId, f.metadata.storageId, "the child lives in an independent storage");
		assert.equal(record.cwd, realpathSync(f.childCwd), "the child uses the requested working directory");
		const child = await acquireHost(hostMetadata(record));
		trackHost(t, child.pid);
		try {
			assert.notEqual(child.pid, primary.pid, "the child runs in its own host process");
			const found = await primary.request("inspect", { view: "search", query: "Agent result from", source: "user" }) as { matches: Array<{ excerpt: string }> };
			assert.equal(found.matches.length, 1, JSON.stringify(found));
			const excerpt = found.matches[0]?.excerpt ?? "";
			assert.match(excerpt, /CHILD_RESULT/u);
			const submission = /\(submissions (\d+)\)/u.exec(excerpt)?.[1];
			assert.ok(submission, excerpt);
			const result = await child.request("inspect", { view: "result", submissionId: Number(submission) }) as { answerEntryId: number };
			const deliveryRequest = `deliver:${record.storageId}:answer:${result.answerEntryId}`;
			const repeat = await primary.request("submit", { message: "DUPLICATE_DELIVERY", requestId: deliveryRequest, provenance: { classification: "automatic" } }) as SubmitResult;
			assert.equal(repeat.deduped, true, "the delivery request ID is retained and deduplicated");
			const after = await primary.request("inspect", { view: "search", query: "DUPLICATE_DELIVERY" }) as { matches: unknown[] };
			assert.equal(after.matches.length, 0, "the deduplicated submit wrote no new entry");
		} finally {
			await child.close().catch(() => {});
		}
	} finally {
		await primary.close().catch(() => {});
	}
});

it("receives a fixture marker from the notify socket without a marker file", async (t) => {
	const f = runtimeFixture(t);
	const pending = [f.marker("requested"), f.marker("requested")];
	await Promise.all([...pending, publishFixtureMarker(f.notifyPath, "requested")]);
	assert.equal(existsSync(join(f.testDir, "requested")), false, "the wait is the socket message, not the marker file");
	await publishFixtureMarker(f.notifyPath, "early");
	await f.marker("early");
});

it("holds a fixture publisher until the test releases its marker", async (t) => {
	const f = runtimeFixture(t);
	const markers = markerFixture(t, f.testDir);
	const release = markers.hold("host-start-gated");
	let published = false;
	const publication = publishFixtureMarker(markers.notifyPath, "host-start-gated").then(() => { published = true; });
	await markers.marker("host-start-gated");
	assert.equal(published, false, "the child remains at the gate after marker receipt");
	release();
	await publication;
	assert.equal(published, true);
});

for (const present of [false, true]) it(`reports file exists=${present} when a fixture marker never arrives`, async (t) => {
	const f = runtimeFixture(t);
	if (present) writeFileSync(join(f.testDir, "unpublished"), "not a signal");
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const rejected = assert.rejects(f.marker("unpublished"), new RegExp(`fixture marker unpublished; file exists=${present}`, "u"));
	t.mock.timers.tick(30000);
	await rejected;
});

it("resumes an outstanding model request after SIGKILL without a duplicate submission", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const first = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "complete the request", requestId: "kill-request", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	assert.equal(submitted.deduped, false);
	await f.marker("requested");
	killHost(first.pid);
	await first.close();

	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const repeat = await second.request("submit", { message: "complete the request", requestId: "kill-request", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		assert.equal(repeat.submissionId, submitted.submissionId, "the same request ID reuses the retained submission");
		assert.equal(repeat.deduped, true, "the repeated submit is deduplicated");
		const history = await second.request("inspect", { view: "history", source: "user", limit: 10 }) as HistoryPage;
		assert.equal(history.entries.length, 1, "recovery leaves one user entry");
		const acknowledged = await second.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] }) as AcknowledgeResult;
		assert.equal(acknowledged.acknowledged.length, 1, "the owner acknowledges the receipt once");
		const after = await second.request("receipts", { ownerId: f.ownerId }) as ReceiptsPage;
		assert.equal(after.receipts.length, 0, "an acknowledged receipt is not delivered again");
	} finally {
		await second.close();
	}
});

it("retires pending dead-owner delivery and recovers it through primary registration", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const owner = randomUUID();
	const other = randomUUID();
	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForProcessExit(dead, 5000);
	assert.ok(dead.pid);
	const endpoint = primaryEndpointPath(f.root, owner);
	mkdirSync(dirname(endpoint), { recursive: true });
	writeFileSync(endpoint, JSON.stringify({ version: PRIMARY_DELIVERY_CONTRACT, id: owner, serverId: randomUUID(), startedAt: new Date().toISOString(), hostname: hostname(), pid: dead.pid, socketPath: join(f.root, "dead.sock"), cwd: f.cwd }));
	const fallback = eventLog<unknown>();
	const channel = await createPrimaryChannel({ id: other, cwd: f.cwd, sessionsRoot: f.root, deliver: (message) => { fallback.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const first = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "survive owner restart", ownerId: owner, origin: "model", requestId: "offline-owner" }) as SubmitResult;
	await waitForReceipt(first, owner, submitted.submissionId);
	await fallback.waitForCount(1);
	await first.close();
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const catalog = new AgentCatalog(f.root);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
	await channel.close();
	const acquired: number[] = [];
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, acquire: async (metadata) => {
		const client = await acquireHost(metadata, { env: f.env("answer") });
		acquired.push(client.pid); trackHost(t, client.pid); return client;
	} });
	t.after(() => manager.close());
	await manager.registerPrimary(other, { cwd: f.cwd, signal: new AbortController().signal, send: (_text, details) => { fallback.push(details); } });
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(acquired.length, 1, "another primary reopens the marked storage");
	assert.equal(fallback.length, 1, "the recorded fallback never repeats at receiver re-registration");
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "retirement preserves the pending owner row");
	const delivered = eventLog<unknown>();
	await manager.registerPrimary(owner, { cwd: f.cwd, signal: new AbortController().signal, send: (_text, details) => { delivered.push(details); } });
	await delivered.waitForCount(1);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(acquired.length, 2);
	assert.equal(delivered.length, 1);
	assert.equal((delivered[0] as { liveOwner: boolean }).liveOwner, true);
	assert.equal((delivered[0] as { wake: boolean }).wake, true);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false);
});

it("preserves a crash recovery marker through primary startup and clears it after idle retirement", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(f.root);
	const ownerId = randomUUID();
	const first = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	let submitted: SubmitResult;
	try {
		submitted = await first.request("submit", { message: "recover the marked work", requestId: "marked-crash", ownerId, origin: "operator" }) as SubmitResult;
		await f.marker("requested");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
		killHost(first.pid);
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	} finally { await first.close(); }
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "SIGKILL leaves the due marker on disk");

	const acquired: string[] = [];
	let recoveredPid = 0;
	const manager = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		acquire: async (metadata) => {
			acquired.push(metadata.storageId);
			const connection = await acquireHost(metadata, { env: f.env("answer") });
			recoveredPid = connection.pid;
			trackHost(t, connection.pid);
			return connection;
		},
	});
	const controller = new AbortController();
	let receipt: Record<string, unknown> | undefined;
	let resolveDelivered: () => void = () => {};
	const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
	try {
		await manager.registerPrimary(ownerId, {
			cwd: f.cwd, signal: controller.signal,
			send: (_text, details) => {
				const value = details as Record<string, unknown>;
				if (value.storageId !== f.metadata.storageId || !(value.submissions as { submissionId: number }[]).some((member) => String(member.submissionId) === String(submitted.submissionId))) return;
				receipt = value;
				resolveDelivered();
			},
		});
		assert.deepEqual(acquired, [f.metadata.storageId], "primary startup recovers the marked storage");
		assert.notEqual(recoveredPid, first.pid);
		await within(delivered, 10000, "the recovered submission did not reach its primary");
		assert.equal(receipt?.status, "done");
		assert.match(String(receipt?.answer), /durable runtime answer/u);
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		assert.equal(controller.signal.aborted, false, "the primary remains registered through host retirement");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "completion, delivery acknowledgement, and clean idle retirement clear the marker");
	} finally {
		controller.abort();
		manager.close();
	}
});

for (const steerDuringRun of [false, true]) it(`relaunches a connected host after SIGKILL with ${steerDuringRun ? "steering" : "one input"} while its primary stays alive`, { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const ownerId = randomUUID();
	const controller = new AbortController();
	const pids: number[] = [];
	let resolveRecovered: () => void = () => {};
	const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
	const manager = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		acquire: async (metadata, options) => {
			assert.equal(options?.retryAttempts, 0, "the manager owns every automatic relaunch");
			const client = await acquireHost(metadata, { ...options, env: f.env(pids.length === 0 ? (steerDuringRun ? "effect" : "request") : "answer") });
			pids.push(client.pid);
			if (pids.length === 2) resolveRecovered();
			trackHost(t, client.pid);
			return client;
		},
	});
	const receipts: Record<string, unknown>[] = [];
	let resolveDelivered: () => void = () => {};
	const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
	try {
		await manager.registerPrimary(ownerId, {
			cwd: f.cwd, signal: controller.signal,
			send: (_text, details) => { receipts.push(details as Record<string, unknown>); resolveDelivered(); },
		});
		const submitted = await manager.control("submit", { sessionId: f.metadata.storageId, message: "recover without restarting the primary", requestId: "connected-crash", origin: "model" }, { id: ownerId, cwd: f.cwd }) as SubmitResult;
		await f.marker(steerDuringRun ? "effect" : "requested");
		const expectedIds = [submitted.submissionId];
		if (steerDuringRun) {
			const steered = await manager.control("submit", { sessionId: f.metadata.storageId, message: "include the correction", requestId: "crash-steer", whenBusy: "steer", origin: "model" }, { id: ownerId, cwd: f.cwd }) as SubmitResult;
			expectedIds.push(steered.submissionId);
		}
		assert.equal(manager.catalog.read(f.metadata.storageId).recoveryDue, true);
		killHost(pids[0] as number);
		await within(delivered, 15000, "the live primary received no recovered result").catch(async (error) => { throw new Error(`${String(error)}; pids=${JSON.stringify(pids)}; status=${JSON.stringify(await manager.status())}`); });
		await within(recovered, 10000, "the replacement connection did not become ready");
		assert.equal(controller.signal.aborted, false);
		assert.equal(pids.length, 2, "channel loss automatically launches one replacement");
		assert.notEqual(pids[1], pids[0]);
		const receipt = receipts[0];
		assert.ok(receipt);
		assert.equal(receipt.status, "done");
		assert.deepEqual((receipt.submissions as { submissionId: number }[]).map((member) => String(member.submissionId)), expectedIds.map(String));
		assert.match(String(receipt?.answer), /durable runtime answer/u);
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		assert.equal(receipts.length, 1, "the host retires after one notice and acknowledgement of every input");
		assert.equal(manager.catalog.read(f.metadata.storageId).recoveryDue, false);
		const history = await manager.control("inspect", { sessionId: f.metadata.storageId, view: "history", source: "user", limit: 10 }, { id: ownerId, cwd: f.cwd }) as HistoryPage;
		assert.equal(history.entries.length, expectedIds.length, "relaunch resumes retained submissions without another input");
	} finally { controller.abort(); manager.close(); }
});

it("does not rerun an unsafe effect after SIGKILL and delivers the retained result once", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const first = await acquireHost(f.metadata, { env: f.env("effect") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "run the effect", requestId: "kill-effect", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	assert.equal(submitted.deduped, false);
	await f.marker("effect");
	killHost(first.pid);
	await first.close();

	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const effects = () => readFileSync(join(f.testDir, "effect.txt"), "utf8").trim().split("\n").filter((line) => line !== "").length;
		assert.equal(effects(), 1, "the unsafe effect ran once before the kill");
		const repeat = await second.request("submit", { message: "run the effect", requestId: "kill-effect", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		assert.equal(repeat.submissionId, submitted.submissionId);
		assert.equal(repeat.deduped, true, "the repeated submit is deduplicated");
		assert.equal(effects(), 1, "the resumed and deduplicated request reran no effect");
		const interrupted = await second.request("inspect", { view: "search", query: "interrupted" }) as SearchPage;
		assert.ok(interrupted.matches.length >= 1, "the interrupted tool result is retained");
	} finally {
		await second.close();
	}
});

for (const stop of ["SIGTERM", "close"] as const) for (const mode of ["request", "effect"] as const) it(`retains pending ${mode} work through ${stop} process shutdown`, { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(f.root);
	const first = await acquireHost(f.metadata, { env: f.env(mode) });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "retain pending native work", requestId: "process-stop", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	await f.marker(mode === "request" ? "requested" : "effect");
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
	if (stop === "SIGTERM") process.kill(first.pid, "SIGTERM");
	else await first.request("close").catch(() => undefined);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	await first.close();
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "process exit retains the recovery marker");
	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid);
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		if (mode === "effect") {
			assert.equal(readFileSync(join(f.testDir, "effect.txt"), "utf8").trim().split("\n").length, 1);
			const interrupted = await second.request("inspect", { view: "search", query: "interrupted" }) as SearchPage;
			assert.ok(interrupted.matches.length >= 1, "native recovery records the interrupted unsafe effect");
		}
	} finally { await second.close(); }
});

it("marks recovery due before admission and reports the recovery state", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(dirname(dirname(f.storagePath)));
	const primary = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, primary.pid);
	try {
		assert.deepEqual(await primary.request("recovery-state", {}), { workPending: false, deliveriesPending: false, deliveriesActive: false });
		const submitted = await primary.request("submit", { message: "RECOVERY_MARK", requestId: "recovery-mark" }) as SubmitResult;
		assert.ok(submitted.submissionId);
		await f.marker("requested");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "admission marks the record before the request completes");
		const busy = await primary.request("recovery-state", {}) as { workPending: boolean; deliveriesPending: boolean };
		assert.equal(busy.workPending, true);
	} finally {
		await primary.close().catch(() => {});
	}
	process.kill(primary.pid, "SIGTERM");
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const view = catalog.read(f.metadata.storageId).view;
	assert.ok(view, "the gated host flushed a catalog view before release");
	assert.ok(view.rows.some((row) => row.storageId === f.metadata.storageId), "the view carries this storage's row");
});

it("publishes a bounded catalog view and clears recovery due on a clean close", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(dirname(dirname(f.storagePath)));
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	const pid = primary.pid;
	try {
		const submitted = await primary.request("submit", { message: "VIEW_SOURCE", requestId: "view-source", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "the admitted request marked recovery due");
		await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] });
	} finally {
		await primary.close().catch(() => {});
	}
	// SIGTERM inside the coalescing window: the clean close must flush the last view.
	process.kill(pid, "SIGTERM");
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const view = catalog.read(f.metadata.storageId).view;
	assert.ok(view, "the clean close flushed the final catalog view");
	assert.ok(view.rows.some((row) => row.storageId === f.metadata.storageId), "the view carries this storage's rows");
	assert.equal(view.coverage.complete, true);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "a clean idle close clears the marker");
});

for (const pendingDelivery of [false, true]) it(`exits after a failed reload with pending delivery=${pendingDelivery} and serves controls after acquisition`, { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const runner = join(f.testDir, "failed-reload.mts");
	const hostModule = new URL("./durable-host.ts", import.meta.url).href;
	const runtimeModule = new URL("./durable-runtime.ts", import.meta.url).href;
	const signalModule = new URL("./testdata/durable-runtime/signal.ts", import.meta.url).href;
	writeFileSync(runner, `
		import { writeFileSync } from "node:fs";
		import { DurableHost } from ${JSON.stringify(hostModule)};
		import { publishFixtureMarker } from ${JSON.stringify(signalModule)};
		const original = DurableHost.open;
		let opens = 0;
		DurableHost.open = async function (...args) {
			if (++opens === 2) throw new Error("forced reload open failure");
			return original.apply(this, args);
		};
		// Record the runtime state before the process handles the failed request.
		const { createDurableRuntime } = await import(${JSON.stringify(runtimeModule)});
		const { runHost } = await import(${JSON.stringify(new URL("./host-process.ts", import.meta.url).href)});
		const metadata = JSON.parse(process.argv[2]);
		const host = await runHost(async () => {
			const runtime = await createDurableRuntime(metadata);
			const request = runtime.request;
			runtime.request = async (...args) => {
				try { return await request(...args); }
				catch (error) {
					if (args[0] === "command" && args[1]?.name === "reload") {
						let nextError;
						try { await request("status", {}, "after-failure"); }
						catch (next) { nextError = next.message; }
						writeFileSync(${JSON.stringify(join(f.testDir, "reload-state.json"))}, JSON.stringify({ shutdownRequired: runtime.shutdownRequired ?? false, idle: runtime.isIdle(), nextError }));
						await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "reload-failed");
					}
					throw error;
				}
			};
			return runtime;
		}, { metadata, exit: () => process.exit(0) });
		await host.done;
	`);
	const first = await acquireHost(f.metadata, { runner, env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "0" }, retryAttempts: 0 });
	trackHost(t, first.pid);
	let submission: SubmitResult | undefined;
	try {
		if (pendingDelivery) {
			submission = await first.request("submit", { message: "retain this delivery", requestId: "reload-delivery", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
			await waitForReceipt(first, f.ownerId, submission.submissionId);
			await first.request("recovery-state");
		}
		await assert.rejects(first.request("command", { name: "reload" }), /forced reload open failure/u);
		await f.marker("reload-failed");
		const state = JSON.parse(readFileSync(join(f.testDir, "reload-state.json"), "utf8"));
		assert.equal(state.idle, false, "a closed native host does not retire as idle");
		assert.match(state.nextError, /closed/u, "later controls cannot use the torn-down runtime");
		assert.equal(state.shutdownRequired, true, "the failed runtime requires process shutdown instead of retaining its live claim");
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		const paths = hostPaths(f.metadata);
		assert.equal(observeClaim(paths.claim, paths.identity).kind, "dead", "process death leaves a replaceable writer claim");
		assert.equal(new AgentCatalog(f.root).read(f.metadata.storageId).recoveryDue, true, "failure retains recovery due, including an unacknowledged delivery");
	} finally { await first.close().catch(() => {}); }
	const second = await acquireHost(f.metadata, { env: f.env("answer"), retryAttempts: 0 });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid);
		assert.equal((await second.request("status") as { storageId: string }).storageId, f.metadata.storageId);
		await second.request("configure", { name: "after failed reload" });
		if (submission) {
			const receipt = await waitForReceipt(second, f.ownerId, submission.submissionId);
			assert.equal(receipt.status, "done");
			await second.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submission.submissionId] });
		}
	} finally { await second.close().catch(() => {}); }
});

it("keeps change notifications after reload replaces the durable host", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	let unsubscribe: (() => void) | undefined;
	try {
		let notifications = 0;
		let reloaded = false;
		let resolveVerified: () => void = () => {};
		let rejectGuard: (error: unknown) => void = () => {};
		const verified = new Promise<void>((resolve) => {
			resolveVerified = resolve;
		});
		const failed = new Promise<void>((_resolve, reject) => {
			rejectGuard = reject;
		});
		let checking = false;
		let checkAgain = false;
		/** One guarded async check per change event: reload while idle, then verify the configured name. */
		const advance = async (): Promise<void> => {
			const status = (await primary.request("status", { sessionId: f.metadata.storageId })) as { conversation?: { name?: string } };
			if (status.conversation?.name === "after reload") {
				resolveVerified();
				return;
			}
			if (reloaded) return;
			const outcome = (await primary.request("command", { name: "reload", invocationId: "reload-changes" })) as { reloaded?: boolean };
			if (outcome.reloaded !== true) return;
			reloaded = true;
			await primary.request("configure", { sessionId: f.metadata.storageId, name: "after reload" });
		};
		const runGuard = (): void => {
			if (checking) {
				checkAgain = true;
				return;
			}
			checking = true;
			void (async () => {
				try {
					for (;;) {
						await advance();
						if (!checkAgain) return;
						checkAgain = false;
					}
				} catch (error) {
					rejectGuard(error);
				} finally {
					checking = false;
				}
			})();
		};
		const subscribeChanges = primary.subscribeChanges?.bind(primary);
		assert.ok(subscribeChanges, "the acquired connection exposes change subscriptions");
		unsubscribe = await subscribeChanges(() => {
			notifications += 1;
			runGuard();
		});
		await Promise.race([within(verified, 30000, "no change notification carried the configured name after reload"), failed]);
		assert.equal(reloaded, true, "the reload completed after the guarded idle check");
		assert.ok(notifications >= 2, "the initial snapshot and a post-reload commit notified the persistent listener");
	} finally {
		unsubscribe?.();
		await primary.close().catch(() => {});
	}
});

it("repairs an unavailable retained model through attach on an idle host", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	// The runner reads the passed metadata; the on-disk catalog record is not consulted for the open.
	const unavailable = { provider: "absent", modelId: "missing-model" };
	const metadata = { ...f.metadata, model: unavailable };
	const primary = await acquireHost(metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	try {
		const before = (await primary.request("status", { sessionId: metadata.storageId })) as { conversation?: { agent?: { model?: { provider?: string; modelId?: string } } } };
		assert.deepEqual(before.conversation?.agent?.model, unavailable, "the retained unavailable identity is reported before repair");
		const repaired = (await primary.request("attach", { sessionId: metadata.storageId, model: { provider: "durable-runtime-fixture", modelId: "fixture-model" } })) as { conversation?: { agent?: { model?: { provider?: string; modelId?: string } } } };
		assert.deepEqual(repaired.conversation?.agent?.model, { provider: "durable-runtime-fixture", modelId: "fixture-model" }, "attach repairs the stored identity with the fixture model");
	} finally {
		await primary.close().catch(() => {});
	}
});

it("preserves a conversation's provider session and request options across turns, tool rounds, and host restart", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { transport: "sse" });
	writeFileSync(join(f.testDir, "input.txt"), "Provider request fixture input\n");
	const recorded = () => readFileSync(join(f.testDir, "session-options.jsonl"), "utf8").trim().split("\n")
		.map((line) => JSON.parse(line) as { sessionId: string; transport: string; reasoning?: string });
	let providerSessionId: string | undefined;
	let requestCount = 0;
	const turn = async (host: HostConnection, requestId: string, reasoning?: string): Promise<void> => {
		const submitted = await host.request("submit", { message: requestId, requestId, ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(host, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		const requests = recorded();
		assert.equal(requests.length, requestCount + 2, "each turn reaches the provider before and after its tool round");
		for (const options of requests.slice(requestCount)) {
			assert.match(options.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu, "the provider session ID is a UUID");
			assert.notEqual(options.sessionId, f.metadata.storageId, "provider identity is distinct from storage identity");
			providerSessionId ??= options.sessionId;
			assert.deepEqual(options, { sessionId: providerSessionId, transport: "sse", ...(reasoning === undefined ? {} : { reasoning }) });
		}
		requestCount = requests.length;
		await host.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] });
	};
	const first = await acquireHost(f.metadata, { env: f.env("tool-round") });
	trackHost(t, first.pid);
	try {
		await turn(first, "thinking-off");
		await first.request("configure", { thinkingLevel: "high" });
		await turn(first, "thinking-high", "high");
		process.kill(first.pid, "SIGTERM");
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	} finally { await first.close(); }
	const second = await acquireHost(f.metadata, { env: f.env("tool-round") });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid, "the next turn uses a new host process");
		await turn(second, "thinking-high-after-restart", "high");
		await second.request("configure", { thinkingLevel: "off" });
		await turn(second, "thinking-off-after-restart");
	} finally { await second.close(); }
});
