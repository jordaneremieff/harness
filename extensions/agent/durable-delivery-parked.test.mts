/** Results and reports that wait for an owner without a live session. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { deliveryState } from "./delivery-store.ts";
import { startDurableDelivery, type DurableDelivery, type PrimaryDiscovery } from "./durable-delivery.ts";
import { DurableHost } from "./durable-host.ts";
import {
	answerMessage,
	fixtureModelId,
	fixtureProvider,
	fixtureRegistry,
	hostOptions,
	scriptedRuntime,
} from "./durable-host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createPrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";

type TestContext = { after(fn: () => void | Promise<void>): void };

function fixtureRoot(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "parked-delivery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function openSource(t: TestContext, root: string, answers: number): Promise<DurableHost> {
	const storageId = randomUUID();
	const models = await scriptedRuntime(Array.from({ length: answers }, (_, index) => answerMessage(`answer ${index}`)));
	const host = await DurableHost.open({
		...hostOptions(join(root, `${storageId}.sqlite`), models, fixtureRegistry()),
		storageId,
		cwd: root,
	});
	t.after(() => host.close());
	return host;
}

async function settledResult(host: DurableHost, ownerId: string, requestId: string): Promise<SubmissionId> {
	const admitted = (await host.request(
		"submit",
		{ sessionId: host.storageId, message: `task ${requestId}`, requestId, ownerId, origin: "model" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await host.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	return admitted.submissionId;
}

function watch(
	t: TestContext,
	host: DurableHost,
	root: string,
	options: { listPrimaryChannels?: (sessionsRoot: string) => Promise<PrimaryDiscovery>; onIdle?: () => void } = {},
): { delivery: DurableDelivery; errors: string[] } {
	const errors: string[] = [];
	const delivery = startDurableDelivery({
		host,
		metadata: parseHostMetadata({
			storageId: host.storageId,
			cwd: root,
			agentDir: join(root, "agent"),
			packageDir: join(root, "package"),
			storagePath: join(root, `${host.storageId}.sqlite`),
			model: { provider: fixtureProvider, modelId: fixtureModelId },
			thinkingLevel: "off",
		}),
		catalog: new AgentCatalog(join(root, "catalog")),
		sessionsRoot: join(root, "sessions"),
		signal: new AbortController().signal,
		onError: (error) => errors.push(error.message),
		...options,
	});
	t.after(() => delivery.close());
	return { delivery, errors };
}

async function registerPrimary(t: TestContext, root: string): Promise<PrimaryDelivery[]> {
	const received: PrimaryDelivery[] = [];
	const channel = await createPrimaryChannel({
		id: randomUUID(),
		cwd: root,
		sessionsRoot: join(root, "sessions"),
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(() => channel.close());
	return received;
}

/** Counts completed passes, and resolves a waiter after the next pass that started on request. */
function passCounter(): {
	onIdle: () => void;
	passes: () => number;
	pass: (delivery: DurableDelivery) => Promise<void>;
} {
	let passes = 0;
	let waiter: (() => void) | undefined;
	return {
		onIdle: () => {
			passes += 1;
			waiter?.();
		},
		passes: () => passes,
		pass: async (delivery) => {
			const done = new Promise<void>((resolve) => {
				waiter = resolve;
			});
			delivery.refresh();
			await done;
			waiter = undefined;
		},
	};
}

/** Resolves when every listed receipt is parked; timers run between reads. */
async function parkedReasons(host: DurableHost, ids: readonly SubmissionId[]): Promise<string[]> {
	for (;;) {
		const state = await deliveryState(host.harness, BACKGROUND_CONTEXT, true);
		const reasons = ids.map((id) => state?.receipts[String(id)]?.delivery);
		if (reasons.every((delivery) => delivery?.state === "parked"))
			return reasons.map((delivery) => delivery?.reason ?? "");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

it("states one fallback failure once in the parked reason of every row of an ended owner", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const count = 12;
	const host = await openSource(t, root, count);
	const ids: SubmissionId[] = [];
	for (let index = 0; index < count; index++) ids.push(await settledResult(host, owner, `parked-${index}`));
	const { errors } = watch(t, host, root);
	const reasons = await parkedReasons(host, ids);
	const failure = `no live owning session for ${owner} and no registered primary accepted delivery`;
	for (const reason of reasons) assert.equal(reason.split(failure).length - 1, 1, reason);
	assert.equal(new Set(reasons).size, 1, "every row of the owner states the same reason");
	for (const error of errors) assert.ok(error.split(failure).length - 1 <= 1, error);
});

it("gives a parked result to the primaries of its first complete broadcast and not to one that registers later", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const host = await openSource(t, root, 2);
	const id = await settledResult(host, owner, "for-an-ended-owner");
	const early = await registerPrimary(t, root);
	const counter = passCounter();
	const { delivery } = watch(t, host, root, { onIdle: counter.onIdle });
	await parkedReasons(host, [id]);
	await counter.pass(delivery);
	assert.equal(early.length, 1, "the registered primary received the informational copy");

	const late = await registerPrimary(t, root);
	await host.request(
		"submit",
		{ sessionId: host.storageId, message: "later work", requestId: "later" },
		BACKGROUND_CONTEXT,
	);
	await counter.pass(delivery);
	await counter.pass(delivery);
	assert.equal(late.length, 0, "a primary that registered after the broadcast received a copy of the old result");
	assert.equal(early.length, 1, "the first primary received no second copy");
	const state = await deliveryState(host.harness, BACKGROUND_CONTEXT, true);
	assert.equal(state?.receipts[String(id)]?.fallbackBroadcast, true);
	assert.equal(state?.receipts[String(id)]?.acknowledged, false, "a copy does not acknowledge the owner");
});

it("retries a parked result that no primary accepted when a primary registers", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const host = await openSource(t, root, 1);
	const id = await settledResult(host, owner, "nobody-listens");
	const counter = passCounter();
	const { delivery } = watch(t, host, root, { onIdle: counter.onIdle });
	await parkedReasons(host, [id]);
	const before = await deliveryState(host.harness, BACKGROUND_CONTEXT, true);
	assert.equal(before?.receipts[String(id)]?.fallbackBroadcast, undefined, "no primary accepted a copy yet");
	const late = await registerPrimary(t, root);
	await counter.pass(delivery);
	assert.equal(late.length, 1, "the first primary that registers receives the copy");
});

it("reads the primary endpoint directory once for each pass, not once for each parked row", {
	timeout: 60000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const count = 24;
	const host = await openSource(t, root, count);
	const ids: SubmissionId[] = [];
	for (let index = 0; index < count; index++) ids.push(await settledResult(host, owner, `parked-${index}`));
	let scans = 0;
	const counter = passCounter();
	const { delivery } = watch(t, host, root, {
		onIdle: counter.onIdle,
		listPrimaryChannels: async () => {
			scans += 1;
			return { ids: [], complete: true, visited: 0 };
		},
	});
	await parkedReasons(host, ids);
	await counter.pass(delivery);
	const scansBefore = scans;
	const passesBefore = counter.passes();
	for (let round = 0; round < 5; round++) await counter.pass(delivery);
	const passes = counter.passes() - passesBefore;
	assert.ok(passes >= 5);
	assert.ok(
		scans - scansBefore <= passes,
		`${scans - scansBefore} directory reads in ${passes} passes with ${count} parked rows`,
	);
});
