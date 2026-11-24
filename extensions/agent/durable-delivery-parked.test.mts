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
