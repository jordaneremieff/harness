/**
 * Host-process recovery decisions over one isolated store: which registrations launch a runner, open a writer or
 * start a scheduler, and how a waiting result reaches its exact recipient without the source's scheduler.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { deliverColdStorage, type ColdDeliveryResult } from "./cold-delivery.ts";
import { editDeliveryFixture } from "./delivery-store-fixture.mts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";
import { eventLog, waitForProcessExit, type EventLog } from "./host-fixture.mts";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { hostPaths, type HostMetadata } from "./host-protocol.ts";
import { AgentManager } from "./manager.ts";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { subscribeCatalogChanges } from "./catalog-events.ts";
import { savedTranscript } from "./primary-transcript-fixture.mts";
import { readRecipientHint, recipientHintPath, RecipientHintWriter } from "./recipient-hints.ts";

/** Runner launches by kind: a serving host through acquisition, a cold writer through delivery. */
interface Counts {
	readonly acquisitions: HostMetadata[];
	readonly launches: EventLog<HostConnection>;
	readonly coldDeliveries: Array<{ storageId: string; recipients: readonly string[]; result?: ColdDeliveryResult }>;
}

function fixture(t: TestContext, idleMinutes = "60", mode: "answer" | "request" = "answer") {
	const cleanup: Array<() => void | Promise<void>> = [];
	t.after(async () => {
		for (const close of cleanup.reverse()) await close();
	});
	const f = runtimeFixture(t);
	const env = {
		...f.env(mode),
		PI_AGENT_IDLE_MINUTES: idleMinutes,
		PI_AGENT_DIR: f.agentDir,
		PI_AGENT_SESSIONS_DIR: f.root,
	};
	const counts: Counts = { acquisitions: [], launches: eventLog<HostConnection>(), coldDeliveries: [] };
	const delivered = eventLog<ColdDeliveryResult>();
	const manager = () => {
		const created = new AgentManager({
			root: f.root,
			agentDir: f.agentDir,
			packageDir: f.metadata.packageDir,
			acquire: async (metadata, options) => {
				counts.acquisitions.push(metadata);
				const client = await acquireHost(metadata, { ...options, env });
				trackHost(t, client.pid);
				if (client.ownedExit !== undefined) counts.launches.push(client);
				return client;
			},
			deliverCold: async (metadata, recipients, options) => {
				const entry: Counts["coldDeliveries"][number] = { storageId: metadata.storageId, recipients };
				counts.coldDeliveries.push(entry);
				const outcome = await deliverColdStorage(metadata, recipients, { ...options, env });
				if ("result" in outcome) {
					entry.result = outcome.result;
					delivered.push(outcome.result);
				}
				return outcome;
			},
		});
		cleanup.push(() => created.close());
		return created;
	};
	return { ...f, env, counts, delivered, manager, cleanup: (close: () => void | Promise<void>) => cleanup.push(close) };
}

/** Seed a retained report independently of the hint under test. */
async function seedReport(f: ReturnType<typeof fixture>, recipient: string, text: string): Promise<void> {
	const host = await DurableHost.open(
		{
			storageId: f.metadata.storageId,
			storagePath: f.metadata.storagePath,
			cwd: f.cwd,
			models: await fixtureRuntime("answer"),
			registry: fixtureRegistry(),
			agent: { model: f.metadata.model },
			resume: false,
		},
		context,
	);
	try {
		await host.harness.commit(
			async (tx) =>
				editDeliveryFixture(tx, async (state) => {
					state.reports.push({
						sourceId: `report:${text}`,
						requestId: text,
						ownerId: recipient,
						senderIdentity: f.metadata.storageId,
						message: text,
						replyTo: null,
						acknowledged: false,
						createdAt: Date.now(),
					});
				}),
			context,
		);
	} finally {
		await host.close();
	}
}

/** Wait, on host change notices, until the host reports no runnable work. */
async function untilIdle(host: HostConnection): Promise<void> {
	assert.ok(host.subscribeChanges);
	const changes = eventLog<void>();
	const unsubscribe = await host.subscribeChanges(() => changes.push(undefined), AbortSignal.timeout(30000));
	try {
		for (;;) {
			const next = changes.length + 1;
			const state = (await host.request("recovery-state")) as { workPending: boolean };
			if (!state.workPending) return;
			await changes.waitForCount(next, 30000);
		}
	} finally {
		unsubscribe();
	}
}

/** Wait, on catalogue notices, which every hint publication sends, until the hints satisfy the check. */
async function untilHint(f: ReturnType<typeof fixture>, check: () => boolean): Promise<void> {
	const notices = eventLog<void>();
	const stop = subscribeCatalogChanges(
		join(f.root, "durable"),
		() => notices.push(undefined),
		() => {},
	);
	try {
		for (;;) {
			const next = notices.length + 1;
			if (check()) return;
			await notices.waitForCount(next, 15000);
		}
	} finally {
		stop();
	}
}

/** Raw task records, read without a Harness, so the read itself recovers nothing. */
async function taskRecords(metadata: HostMetadata): Promise<string> {
	const storage = await openNodeSqliteStorage(metadata.storagePath);
	try {
		const records = [];
		for (const status of ["pending", "running", "waiting", "sleeping", "completing", "terminal"] as const) {
			let cursor: Parameters<typeof storage.scanTasks>[2];
			do {
				const page = await storage.scanTasks({ status } as never, 64, cursor, context);
				records.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
		}
		return JSON.stringify(records.sort((a, b) => Number(a.id) - Number(b.id)));
	} finally {
		await storage.close(context);
	}
}

function primary(f: ReturnType<typeof fixture>, id: string, received?: string[]) {
	return {
		cwd: f.cwd,
		sessionFile: savedTranscript(f.root, id),
		signal: new AbortController().signal,
		send: (text: string) => {
			if (received === undefined) assert.fail(`an unrelated registration received ${text}`);
			received.push(text);
		},
	};
}

it("launches nothing for registrations that hold no hint, though the storage is marked due for its owner", {
	timeout: 30000,
}, async (t) => {
	const f = fixture(t);
	const owner = randomUUID();
	new RecipientHintWriter(f.root, f.metadata.storageId).publish(new Map([[owner, true]]));
	const manager = f.manager();
	manager.catalog.markRecoveryDue(f.metadata.storageId, true);
	await manager.registerPrimary(randomUUID(), primary(f, randomUUID()));
	await manager.registerPrimary(randomUUID(), primary(f, randomUUID()));
	assert.equal(f.counts.acquisitions.length, 0, "no runner launch");
	assert.equal(f.counts.coldDeliveries.length, 0, "no writer open");
	assert.equal(existsSync(hostPaths(f.metadata).socket), false, "no scheduler start");
	const ownerManager = f.manager();
	await ownerManager.registerPrimary(owner, primary(f, owner, []));
	await (ownerManager as unknown as { recoveryQueue: Promise<void> }).recoveryQueue;
	assert.equal(f.counts.launches.length, 0, "an execution hint without its retained request starts no runner");
	assert.equal(existsSync(f.metadata.storagePath), false);
});

it("delivers without a scheduler when an execution hint outlives the owner's input", async (t) => {
	const f = fixture(t),
		owner = randomUUID();
	await seedReport(f, owner, "retained result");
	new RecipientHintWriter(f.root, f.metadata.storageId).publish(new Map([[owner, true]]));
	const received: string[] = [];
	await f.manager().registerPrimary(owner, primary(f, owner, received));
	await f.delivered.waitForCount(1, 15000);
	assert.equal(f.counts.launches.length, 0);
	assert.equal(received.length, 1);
});

it("delivers a waiting report through a cold writer that leaves another owner's waiting work unchanged", {
	timeout: 60000,
}, async (t) => {
	const f = fixture(t);
	const absent = randomUUID(),
		recipient = randomUUID();
	const first = await acquireHost(f.metadata, { env: f.env });
	trackHost(t, first.pid);
	await first.request("timer-schedule", {
		sessionId: f.metadata.storageId,
		message: "LATER_WORK",
		deliverAt: Date.now() + 3_600_000,
		mode: "followUp",
		origin: "operator",
		ownerId: absent,
		scheduleId: "absent-owner-timer",
		requestId: "absent-owner-timer-delivery",
	});
	await first.request("report", {
		ownerId: recipient,
		message: "RESULT_FOR_RECIPIENT",
		requestId: "recipient-report",
		senderIdentity: f.metadata.storageId,
	});
	await first.request("recovery-state");
	assert.equal(readRecipientHint(f.root, absent, f.metadata.storageId)?.execution, true);
	assert.equal(readRecipientHint(f.root, recipient, f.metadata.storageId)?.execution, false);
	process.kill(first.pid, "SIGKILL");
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const before = await taskRecords(f.metadata);
	assert.match(before, /agent\.timer/u);

	const unrelated = f.manager();
	await unrelated.registerPrimary(randomUUID(), primary(f, randomUUID()));
	assert.equal(f.counts.coldDeliveries.length + f.counts.acquisitions.length, 0);

	const received: string[] = [];
	const manager = f.manager();
	await manager.registerPrimary(recipient, primary(f, recipient, received));
	await f.delivered.waitForCount(1, 30000);
	assert.equal(f.counts.launches.length, 0, "delivery-only demand launches no serving host");
	assert.deepEqual(
		f.counts.coldDeliveries.map((entry) => [entry.storageId, entry.recipients]),
		[[f.metadata.storageId, [recipient]]],
	);
	assert.deepEqual(f.delivered[0], { scheduling: "paused", remaining: [] });
	assert.equal(received.length, 1);
	assert.match(received[0] ?? "", /RESULT_FOR_RECIPIENT/u);
	assert.equal(await taskRecords(f.metadata), before, "the other owner's task records are unchanged");
	assert.equal(existsSync(recipientHintPath(f.root, recipient, f.metadata.storageId)), false);
	assert.equal(readRecipientHint(f.root, absent, f.metadata.storageId)?.execution, true);
});

it("keeps a storage with work that its host stopped mid-run closed to cold delivery", { timeout: 60000 }, async (t) => {
	const f = fixture(t, "60", "request");
	const absent = randomUUID(),
		recipient = randomUUID();
	const first = await acquireHost(f.metadata, { env: f.env });
	trackHost(t, first.pid);
	await first.request("submit", {
		message: "hold this request open",
		ownerId: absent,
		origin: "operator",
		requestId: "interrupted-work",
	});
	await f.marker("requested");
	await first.request("report", {
		ownerId: recipient,
		message: "RESULT_BEHIND_INTERRUPTED_WORK",
		requestId: "recipient-report",
		senderIdentity: f.metadata.storageId,
	});
	await first.request("recovery-state");
	process.kill(first.pid, "SIGKILL");
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const before = await taskRecords(f.metadata);
	assert.match(before, /"status":"running"/u);
	const manager = f.manager();
	await manager.registerPrimary(recipient, primary(f, recipient, []));
	await f.delivered.waitForCount(1, 30000);
	assert.deepEqual(f.delivered[0], { interrupted: true, scheduling: "paused", remaining: [recipient] });
	assert.equal(await taskRecords(f.metadata), before, "an interrupted task keeps its restart count");
	assert.equal(f.counts.launches.length, 0);
	assert.equal(readRecipientHint(f.root, recipient, f.metadata.storageId)?.execution, false);
	const status = (await manager.status()) as { notes?: unknown };
	assert.match(JSON.stringify(status), /stopped while it ran/u);
});

it("publishes a recipient's hint before the admission commits and withdraws it after acknowledgement", {
	timeout: 60000,
}, async (t) => {
	const f = fixture(t);
	const owner = randomUUID(),
		refused = randomUUID();
	const host = await acquireHost(f.metadata, { env: f.env });
	trackHost(t, host.pid);
	const submitted = (await host.request("submit", {
		message: "answer this",
		ownerId: owner,
		origin: "operator",
		requestId: "hinted-work",
	})) as { submissionId: number };
	assert.notEqual(readRecipientHint(f.root, owner, f.metadata.storageId), undefined, "the hint precedes the answer");
	let receipt: { submissionId: number } | undefined;
	while (receipt === undefined) {
		const page = (await host.request("receipts", { ownerId: owner, wait: true })) as {
			receipts: Array<{ submissionId: number }>;
		};
		receipt = page.receipts.find((row) => row.submissionId === submitted.submissionId);
	}
	await untilIdle(host);
	await untilHint(f, () => readRecipientHint(f.root, owner, f.metadata.storageId)?.execution === false);
	await host.request("acknowledge", { ownerId: owner, submissionIds: [receipt.submissionId] });
	await untilHint(f, () => readRecipientHint(f.root, owner, f.metadata.storageId) === undefined);

	const hints = join(f.root, ".recipient-hints");
	chmodSync(hints, 0o500);
	try {
		await assert.rejects(
			host.request("submit", { message: "refused", ownerId: refused, origin: "operator", requestId: "refused-work" }),
			/EACCES/u,
		);
	} finally {
		chmodSync(hints, 0o700);
	}
	const pending = (await host.request("receipts", { ownerId: refused })) as {
		pending?: unknown[];
		receipts: unknown[];
	};
	assert.deepEqual(pending.receipts, []);
	assert.equal(readRecipientHint(f.root, refused, f.metadata.storageId), undefined);
	await host.close();
});

it("starts one runner when launchers in two processes acquire the same cold storage at once", {
	timeout: 60000,
}, async (t) => {
	const f = fixture(t);
	const countFile = join(f.root, "launches.txt");
	const fixturePath = fileURLToPath(new URL("./launch-race-fixture.mts", import.meta.url));
	const acquirer = () => {
		const child = spawn(process.execPath, [fixturePath, "acquire", JSON.stringify(f.metadata)], {
			env: { ...process.env, ...f.env, LAUNCH_COUNT_FILE: countFile },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			output += String(chunk);
		});
		return waitForProcessExit(child).then(() => {
			const pid = /HOST (\d+)/u.exec(output)?.[1];
			assert.ok(pid, output);
			return Number(pid);
		});
	};
	const pids = await Promise.all([acquirer(), acquirer()]);
	for (const pid of new Set(pids)) trackHost(t, pid);
	const launches = readFileSync(countFile, "utf8").trim().split("\n");
	assert.equal(launches.length, 1, `one runner process: ${launches.join(", ")}`);
	assert.deepEqual(pids, [Number(launches[0]), Number(launches[0])]);
});

it("refuses a vanished sponsor under the runner's writer lease without scheduling other work", async (t) => {
	const f = fixture(t);
	const ownerId = randomUUID();
	await seedReport(f, ownerId, "retained");
	const before = await taskRecords(f.metadata);
	const runner = fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const result = spawnSync(
		process.execPath,
		[
			runner,
			JSON.stringify(f.metadata),
			"recover",
			JSON.stringify({ ownerId, conversationId: 1, requestId: "vanished" }),
		],
		{ env: { ...process.env, ...f.env }, encoding: "utf8", timeout: 15000 },
	);
	assert.match(result.stderr, /no longer owes the sponsored request/u);
	assert.notEqual(result.status, 0);
	assert.equal(await taskRecords(f.metadata), before);
});

it("lets a running Durable host resume a child that holds unfinished work for it", { timeout: 60000 }, async (t) => {
	const f = fixture(t);
	const child = hostMetadata(
		new AgentCatalog(f.root).create(
			{
				cwd: f.cwd,
				agentDir: f.agentDir,
				packageDir: f.metadata.packageDir,
				model: f.metadata.model,
				thinkingLevel: "off",
				name: "Child with work for its parent",
				trust: true,
				ownerId: f.metadata.storageId,
			},
			"child-of-parent",
		),
	);
	const first = await acquireHost(child, { env: f.env });
	trackHost(t, first.pid);
	await first.request("timer-schedule", {
		sessionId: child.storageId,
		message: "child timer",
		deliverAt: Date.now() + 3600000,
		mode: "followUp",
		origin: "operator",
		ownerId: f.metadata.storageId,
		scheduleId: "child-timer",
		requestId: "child-request",
	});
	await first.request("recovery-state");
	process.kill(first.pid, "SIGKILL");
	await waitForHostRelease(child, { signal: AbortSignal.timeout(10000) });
	new RecipientHintWriter(f.root, child.storageId).publish(new Map([[f.metadata.storageId, true]]));
	const unrelated = f.manager();
	await unrelated.registerPrimary(randomUUID(), primary(f, randomUUID()));
	assert.equal(f.counts.acquisitions.length, 0, "an unrelated registration leaves the child cold");
	const retired = readFileSync(hostPaths(child).claim, "utf8");
	const parent = await acquireHost(f.metadata, { env: f.env });
	trackHost(t, parent.pid);
	await untilHint(f, () => readFileSync(hostPaths(child).claim, "utf8") !== retired);
	await parent.close();
});
