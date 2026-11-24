/** Retransmission of a result to a live owner that cannot accept it yet. */
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
import { startDurableDelivery, type DurableDelivery } from "./durable-delivery.ts";
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
import { createPrimaryChannel } from "./primary-channel.ts";

type TestContext = { after(fn: () => void | Promise<void>): void };

/** The refusal of a primary that queued the notice and retains it at its next boundary. */
const AWAITS_RETENTION = "Primary delivery awaits a retained agent.peer entry; its source remains unacknowledged";

async function fixture(t: TestContext, answers: number, retryDelayMs: number, accepts: (attempt: number) => boolean) {
	const root = mkdtempSync(join(tmpdir(), "delivery-holds-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const storageId = randomUUID();
	const models = await scriptedRuntime(Array.from({ length: answers }, (_, index) => answerMessage(`answer ${index}`)));
	const host = await DurableHost.open({
		...hostOptions(join(root, `${storageId}.sqlite`), models, fixtureRegistry()),
		storageId,
		cwd: root,
	});
	t.after(() => host.close());
	const state = { attempts: 0, passes: 0, errors: [] as string[] };
	const owner = await createPrimaryChannel({
		id: randomUUID(),
		cwd: root,
		sessionsRoot: join(root, "sessions"),
		deliver: () => {
			state.attempts += 1;
			if (!accepts(state.attempts)) throw new Error(AWAITS_RETENTION);
		},
		promptTrust: async () => undefined,
	});
	t.after(() => owner.close());
	const delivery: DurableDelivery = startDurableDelivery({
		host,
		metadata: parseHostMetadata({
			storageId,
			cwd: root,
			agentDir: join(root, "agent"),
			packageDir: join(root, "package"),
			storagePath: join(root, `${storageId}.sqlite`),
			model: { provider: fixtureProvider, modelId: fixtureModelId },
			thinkingLevel: "off",
		}),
		catalog: new AgentCatalog(join(root, "catalog")),
		sessionsRoot: join(root, "sessions"),
		signal: new AbortController().signal,
		retryDelayMs,
		onIdle: () => {
			state.passes += 1;
		},
		onError: (error) => state.errors.push(error.message),
	});
	t.after(() => delivery.close());
	const submit = async (requestId: string, ownerId?: string): Promise<SubmissionId> => {
		const admitted = (await host.request(
			"submit",
			{
				sessionId: storageId,
				message: `task ${requestId}`,
				requestId,
				...(ownerId === undefined ? {} : { ownerId, origin: "model" }),
			},
			BACKGROUND_CONTEXT,
		)) as { submissionId: SubmissionId };
		await host.wait(admitted.submissionId, BACKGROUND_CONTEXT);
		return admitted.submissionId;
	};
	/** Resolves when `done` holds; timers and delivery passes run between its checks. */
	const until = async (done: () => boolean | Promise<boolean>): Promise<void> => {
		while (!(await done())) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	const acknowledged = async (id: SubmissionId): Promise<boolean> =>
		(await deliveryState(host.harness, BACKGROUND_CONTEXT, true))?.receipts[String(id)]?.acknowledged === true;
	return { owner, delivery, state, submit, until, acknowledged };
}

it("does not send a result again to a live owner that cannot accept it yet while the source commits other work", {
	timeout: 60000,
}, async (t) => {
	const f = await fixture(t, 11, 60_000, () => false);
	const result = await f.submit("owned-request", f.owner.id);
	await f.until(() => f.state.attempts === 1 && !f.delivery.busy);
	for (let index = 0; index < 10; index++) {
		const from = f.state.passes;
		await f.submit(`unrelated-${index}`);
		await f.until(() => f.state.passes > from && !f.delivery.busy);
	}
	assert.equal(f.state.attempts, 1, "each unrelated input of the source sent the same notice to the owner again");
	assert.equal(await f.acknowledged(result), false);
	assert.equal(f.state.errors.length, 1, "the refusal is reported once, not once for each pass");
	assert.match(f.state.errors[0], /active: transient transport failure: .*awaits a retained agent\.peer entry/u);
});

it("sends a held result again at its own time and acknowledges it when the owner accepts", {
	timeout: 60000,
}, async (t) => {
	const f = await fixture(t, 1, 20, (attempt) => attempt >= 3);
	const result = await f.submit("owned-request", f.owner.id);
	await f.until(() => f.acknowledged(result));
	assert.equal(f.state.attempts, 3, "two refusals, then the accepted attempt, with no commit of the source between");
});

it("sends a held result at once on an explicit refresh", { timeout: 60000 }, async (t) => {
	const f = await fixture(t, 1, 60_000, (attempt) => attempt >= 2);
	const result = await f.submit("owned-request", f.owner.id);
	await f.until(() => f.state.attempts === 1 && !f.delivery.busy);
	assert.equal(await f.acknowledged(result), false);
	f.delivery.refresh();
	await f.until(() => f.acknowledged(result));
	assert.equal(f.state.attempts, 2);
});
