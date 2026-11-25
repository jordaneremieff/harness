/** Results and reports that wait for an owner that cannot take them now. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createPrimaryChannel, primaryRefusal, type PrimaryDelivery } from "./primary-channel.ts";

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
	options: { onIdle?: () => void } = {},
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

async function registerPrimary(
	t: TestContext,
	root: string,
	options: { id?: string; sessionFile?: string; deliver?: (message: PrimaryDelivery) => void | Promise<void> } = {},
): Promise<{ received: PrimaryDelivery[]; close: () => Promise<void> }> {
	const received: PrimaryDelivery[] = [];
	const channel = await createPrimaryChannel({
		id: options.id ?? randomUUID(),
		cwd: root,
		sessionsRoot: join(root, "sessions"),
		...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
		deliver: (message) => {
			received.push(message);
			return options.deliver?.(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(() => channel.close());
	return { received, close: () => channel.close() };
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

async function acknowledged(host: DurableHost, id: SubmissionId): Promise<boolean> {
	return (await deliveryState(host.harness, BACKGROUND_CONTEXT, true))?.receipts[String(id)]?.acknowledged === true;
}

it("parks every row of an ended owner with one reason that names no other session", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const count = 12;
	const host = await openSource(t, root, count);
	const ids: SubmissionId[] = [];
	for (let index = 0; index < count; index++) ids.push(await settledResult(host, owner, `parked-${index}`));
	const { delivery, errors } = watch(t, host, root);
	const reasons = await parkedReasons(host, ids);
	assert.equal(new Set(reasons).size, 1, "every row of the owner states the same reason");
	assert.match(
		reasons[0],
		new RegExp(`primary session ${owner} has no live endpoint; .*reaches no other session`, "u"),
	);
	for (const error of errors) assert.match(error, /parked: primary session .* reaches no other session$/u);
	for (let attempt = 0; attempt < 200 && !delivery.summary().fresh; attempt++)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(delivery.summary().parkedRecipients, [owner]);
	assert.equal(delivery.summary().active, false, "parked rows keep no delivery active");
});

it("gives no copy of an ended owner's result to a registered primary, before or after registration", {
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
	const late = await registerPrimary(t, root);
	await host.request(
		"submit",
		{ sessionId: host.storageId, message: "later work", requestId: "later" },
		BACKGROUND_CONTEXT,
	);
	await counter.pass(delivery);
	assert.deepEqual([early.received.length, late.received.length], [0, 0], "no other session received the row");
	assert.equal(await acknowledged(host, id), false);
});

/** Write a saved session header for `id`, as Pi writes it with the first message. */
function saveTranscript(path: string, id: string): string {
	writeFileSync(path, `${JSON.stringify({ type: "session", id })}\n`);
	return path;
}

/** Wait for a condition while the watcher runs only the passes that its own observations start. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
	for (let attempt = 0; attempt < 250; attempt++) {
		if (await check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

it("parks a row for an owner without a saved transcript and delivers it at the watcher's next check of its owners", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const sessionFile = join(root, "owner-session.jsonl");
	const host = await openSource(t, root, 1);
	const id = await settledResult(host, owner, "for-a-new-session");
	const primary = await registerPrimary(t, root, { id: owner, sessionFile });
	const counter = passCounter();
	const { delivery } = watch(t, host, root, { onIdle: counter.onIdle });
	const [reason] = await parkedReasons(host, [id]);
	assert.match(reason, /has no saved transcript yet/u);
	for (let round = 0; round < 3; round++) await counter.pass(delivery);
	assert.equal(primary.received.length, 0, "an unsaved owner receives no attempt");
	assert.equal(delivery.summary().active, false, "the parked row arms no retry");

	saveTranscript(sessionFile, owner);
	// The retirement check and a recovery-state request validate parked recipients this way; no refresh is asked.
	delivery.summary(true);
	assert.equal(await eventually(() => acknowledged(host, id)), true);
	assert.equal(primary.received.length, 1);
	const details = primary.received[0].details as Record<string, unknown>;
	assert.deepEqual([details.originalOwnerId, details.deliveryRecipient, details.fallback], [owner, owner, undefined]);
});

it("parks the rows of an owner that keeps no transcript without an attempt, until it registers with one", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const host = await openSource(t, root, 1);
	const id = await settledResult(host, owner, "for-a-no-session-owner");
	const first = await registerPrimary(t, root, { id: owner });
	const counter = passCounter();
	const { delivery } = watch(t, host, root, { onIdle: counter.onIdle });
	const [reason] = await parkedReasons(host, [id]);
	assert.match(reason, /keeps no transcript/u);
	for (let round = 0; round < 3; round++) await counter.pass(delivery);
	assert.equal(first.received.length, 0, "a session without a transcript receives no attempt");

	await first.close();
	const second = await registerPrimary(t, root, {
		id: owner,
		sessionFile: saveTranscript(join(root, "s.jsonl"), owner),
	});
	delivery.summary(true);
	assert.equal(await eventually(() => acknowledged(host, id)), true, "a registration with a transcript takes the row");
	assert.equal(second.received.length, 1);
});

it("parks only the row whose content a primary refused, and tries it again after an explicit refresh", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const host = await openSource(t, root, 4);
	const refused = await settledResult(host, owner, "refused-row");
	let refuse = true;
	const primary = await registerPrimary(t, root, {
		id: owner,
		sessionFile: saveTranscript(join(root, "owner.jsonl"), owner),
		deliver: (message) => {
			const submissions = (message.details as { submissions?: { requestId?: string }[] }).submissions ?? [];
			if (refuse && submissions.some((item) => item.requestId === "refused-row"))
				throw primaryRefusal("copy", "this row carries a copy marker");
		},
	});
	const counter = passCounter();
	const { delivery } = watch(t, host, root, { onIdle: counter.onIdle });
	const [reason] = await parkedReasons(host, [refused]);
	assert.match(reason, /refused the row \(copy\)/u);
	const accepted = await settledResult(host, owner, "valid-row");
	assert.equal(await eventually(() => acknowledged(host, accepted)), true, "a later valid row still reaches the owner");
	const attempts = primary.received.length;
	// Commits of the source start passes; they do not lift a refusal under unchanged facts.
	const passes = counter.passes();
	await settledResult(host, randomUUID(), "unrelated-a");
	await settledResult(host, randomUUID(), "unrelated-b");
	assert.equal(await eventually(async () => counter.passes() >= passes + 2), true);
	assert.equal(await acknowledged(host, refused), false);
	assert.equal(primary.received.length, attempts, "the refused row is not tried again under the same facts");

	refuse = false;
	delivery.refresh();
	assert.equal(await eventually(() => acknowledged(host, refused)), true, "an explicit refresh tries the row again");
});

it("does not park a replacement registration for a refusal that the previous endpoint gave", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const owner = randomUUID();
	const host = await openSource(t, root, 1);
	const id = await settledResult(host, owner, "across-registrations");
	const sessionFile = saveTranscript(join(root, "owner.jsonl"), owner);
	const replacement: PrimaryDelivery[] = [];
	await registerPrimary(t, root, {
		id: owner,
		sessionFile,
		deliver: async () => {
			// The session registers again while this attempt is in flight; the old registration then refuses.
			const channel = await createPrimaryChannel({
				id: owner,
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				sessionFile,
				replaceOwn: true,
				deliver: (message) => {
					replacement.push(message);
				},
				promptTrust: async () => undefined,
			});
			t.after(() => channel.close());
			throw primaryRefusal("not-held", "this registration no longer holds the session");
		},
	});
	watch(t, host, root);
	assert.equal(await eventually(() => acknowledged(host, id)), true, "the replacement takes the row");
	assert.equal(replacement.length, 1);
});
