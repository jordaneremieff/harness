import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentCatalog } from "./catalog.ts";
import { mutateCollaboration, readCollaboration } from "./collaboration.ts";
import { onStoredCommit } from "./commit-observation.ts";
import { deliveryState } from "./delivery-store.ts";
import { editDeliveryFixture } from "./delivery-store-fixture.mts";
import { ThreadDeliveryDoc, recordReport, type DeliveryReport } from "./durable-controls.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { eventLog } from "./host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createPrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";

const frame = { title: "Parser contract", purpose: "Agree on the parser boundary", authority: "Operator task", source: "Current request", restrictions: "No publication", acceptance: "Review the boundary" };

/** One native source host with its delivery watcher, and one ordinary primary session that receives channel text. */
async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "thread-notice-delivery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessionsRoot = join(root, "sessions");
	const storagePath = join(root, "source.sqlite");
	const storageId = randomUUID();
	const host = await DurableHost.open({ ...hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId }, context);
	t.after(() => host.close().catch(() => undefined));
	const primary = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: primary, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const errors: Error[] = [];
	const start = () => {
		const watcher = startDurableDelivery({
			host,
			metadata: parseHostMetadata({ storageId, cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), storagePath, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" }),
			catalog: new AgentCatalog(root),
			sessionsRoot,
			signal: new AbortController().signal,
			acquire: async () => { throw new Error("A thread notice must not acquire a host"); },
			onError: (error) => { errors.push(error); },
		});
		t.after(() => watcher.close());
	};
	return { host, primary, received, errors, start };
}

/** Resolves on the stored commit that acknowledges every retained report; no polling. */
function delivered(host: DurableHost, count: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { unsubscribe(); reject(new Error("the reports were not acknowledged")); }, 10000);
		const check = (): void => {
			void deliveryState(host.harness, context, true).then((state) => {
				if (state?.reports.length !== count || state.reports.some((report) => !report.acknowledged)) return;
				clearTimeout(timer); unsubscribe(); resolve();
			}, reject);
		};
		const unsubscribe = onStoredCommit(host.harness, check);
		check();
	});
}

/** A retained thread report with a body above the delivery text bound; the thread producer itself never emits one. */
async function longThreadReport(host: DurableHost, ownerId: string, requestId: string, fields: Partial<DeliveryReport>): Promise<void> {
	const report = await recordReport(host.harness, { ownerId, senderIdentity: `${randomUUID()}:7`, message: "placeholder", requestId }, context);
	await host.harness.commit((tx) => editDeliveryFixture(tx, async (state) => {
		const index = state.reports.findIndex((item) => item.requestId === report.requestId);
		state.reports[index] = { ...report, threadId: "purpose-thread", threadTitle: "Shared review", direct: true, ...fields };
		(await tx.doc(ThreadDeliveryDoc, "purpose-thread", null)).pending += 1;
	}), context);
}

it("gives an ordinary session an addressed thread event with its typed read and no generic inspection advice", { timeout: 20000 }, async (t) => {
	const f = await fixture(t);
	const sender = randomUUID();
	const thread = await mutateCollaboration(f.host.harness, f.host.storageId, { action: "create", requestId: "create", senderIdentity: sender, origin: "operator", ...frame, notify: [f.primary] }, context);
	f.start();
	await f.received.waitForCount(1);
	await delivered(f.host, 1);
	const text = f.received[0].text;
	const call = { action: "read", threadId: thread.threadId, before: 2, limit: 1 };
	assert.match(text, /^Thread notice from agent/u);
	assert.ok(text.includes(`Full retained event: agent_collaborate(${JSON.stringify(call)})`), text);
	assert.doesNotMatch(text, /agent_inspect|\[cut\]|text truncated/u);
	const page = await readCollaboration(f.host.harness, { threadId: call.threadId, before: call.before, limit: call.limit }, context);
	assert.deepEqual(page.events.map((event) => [event.sequence, event.kind]), [[1, "create"]], "the emitted read selects the retained event");
	assert.deepEqual(f.errors, []);
});

it("cuts an oversized thread body at a word boundary and names only the typed thread read, for ordinary and native recipients", { timeout: 20000 }, async (t) => {
	const f = await fixture(t);
	const native = await f.host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, context);
	const body = "evidence ".repeat(2400);
	await longThreadReport(f.host, f.primary, "with-event", { message: body, operatorMessage: body, threadEvent: 7, passive: true });
	await longThreadReport(f.host, f.primary, "without-event", { message: body, passive: true });
	await longThreadReport(f.host, f.host.identity(native.id), "native-event", { message: body, threadEvent: 7, passive: true });
	f.start();
	await f.received.waitForCount(2);
	await delivered(f.host, 3);

	const withEvent = `Full retained event: agent_collaborate(${JSON.stringify({ action: "read", threadId: "purpose-thread", before: 8, limit: 1 })})`;
	const withoutEvent = `Event sequence unavailable; bounded thread read: agent_collaborate(${JSON.stringify({ action: "read", threadId: "purpose-thread", limit: 1 })})`;
	const texts = f.received.map((message) => message.text);
	const first = texts.find((value) => value.includes(withEvent));
	const second = texts.find((value) => value.includes(withoutEvent));
	assert.ok(first && second, JSON.stringify(texts.map((value) => value.slice(-200))));
	for (const [text, recovery] of [[first, withEvent], [second, withoutEvent]] as const) {
		assert.ok(text.endsWith(`evidence [cut]\n\n${recovery}`), text.slice(-260));
		assert.ok(text.length < body.length);
		assert.doesNotMatch(text, /agent_inspect|text truncated/u);
		assert.equal(text.split("agent_collaborate(").length, 2, "one recovery call");
	}
	const details = f.received.find((message) => message.text === first)?.details as Record<string, unknown>;
	assert.equal(details.textTruncated, true);
	assert.ok(String(details.operatorMessage).endsWith(`evidence [cut]\n\n${withEvent}`));
	assert.doesNotMatch(String(details.operatorMessage), /agent_inspect/u);

	const entries = await native.entries({ order: "ascending" }, 20, undefined, context);
	const stored = entries.items.map((entry) => entry.model?.[0]?.content).filter((content): content is string => typeof content === "string");
	assert.equal(stored.length, 1);
	assert.match(stored[0], /^Thread notice from /u);
	assert.ok(stored[0].endsWith(`evidence [cut]\n\n${withEvent}`), stored[0].slice(-260));
	assert.doesNotMatch(stored[0], /agent_inspect|text truncated/u);
	assert.deepEqual(f.errors, []);
});
