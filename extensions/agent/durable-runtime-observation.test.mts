import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { AssistantEntry, ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { resolveAgentControlDispatch } from "./durable-agents.ts";
import { DurableHost } from "./durable-host.ts";
import { DurableObservation } from "./durable-observation.ts";
import {
	answerMessage,
	completed,
	fixtureRegistry,
	fixtureRuntime,
	hostOptions,
	pending,
} from "./durable-host-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { hostPaths } from "./host-protocol.ts";
import { AgentManager } from "./manager.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("native foreign observation reads a settled storage without its cwd or a writer launch", {
	timeout: 60000,
}, async (t) => {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close());
	const fixture = runtimeFixture(t);
	const model = { provider: testModel.provider, modelId: testModel.id };
	const target = new AgentCatalog(fixture.root).create(
		{
			cwd: fixture.childCwd,
			agentDir: fixture.agentDir,
			packageDir: fixture.metadata.packageDir,
			model,
			thinkingLevel: "off",
			trust: true,
		},
		"primary",
	);
	const writer = await DurableHost.open({
		...hostOptions(target.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), target.cwd),
		storageId: target.storageId,
	});
	let submissionId: number;
	try {
		const admitted = await writer.submit({
			message: "RETAINED_FOREIGN_INPUT",
			requestId: "retained-foreign",
			origin: "operator",
		});
		submissionId = admitted.submissionId;
		await writer.wait(admitted.submissionId);
	} finally {
		await writer.close();
	}
	rmSync(target.cwd, { recursive: true });
	const before = statSync(target.storagePath, { bigint: true });
	const paths = hostPaths(target);
	assert.equal(existsSync(paths.claim), false);
	runtime = await createDurableRuntime({ ...fixture.metadata, model }, { modelRuntime: await createTestRuntime() });
	const dispatch = resolveAgentControlDispatch();
	const senderIdentity = `${fixture.metadata.storageId}:2`;
	const control = AgentManager.prototype.control;
	const observed: Array<{ method: string; caller: string; signal?: AbortSignal }> = [];
	t.mock.method(
		AgentManager.prototype,
		"control",
		async function (this: AgentManager, ...args: Parameters<typeof control>) {
			observed.push({ method: args[0], caller: args[2].id, signal: args[3]?.signal });
			return control.apply(this, args);
		},
	);
	const acquire = t.mock.method(AgentManager.prototype, "connectNative", async () => {
		throw new Error("writer acquisition requested");
	});
	const params = { sessionId: target.storageId, senderIdentity };
	const result = (await dispatch("inspect", { ...params, view: "result", submissionId })) as { view: string };
	assert.equal(result.view, "result");
	assert.match(JSON.stringify(result), /durable answer/u);
	const history = (await dispatch("inspect", { ...params, view: "history", limit: 1 })) as {
		entries: unknown[];
		nextCursor?: Record<string, unknown>;
	};
	assert.equal(history.entries.length, 1);
	assert.ok(history.nextCursor);
	const page = (await dispatch("inspect", { ...params, view: "history", cursor: history.nextCursor, limit: 1 })) as {
		entries: unknown[];
	};
	assert.equal(page.entries.length, 1);
	assert.notDeepEqual(page.entries, history.entries);
	const status = (await dispatch("status", params)) as { live: boolean; conversation?: unknown; pid?: number };
	assert.equal(status.live, false);
	assert.ok(status.conversation);
	assert.equal(status.pid, undefined);
	const profile = (await dispatch("profile-read", params)) as { identity: string };
	assert.equal(profile.identity, target.storageId);
	const controller = new AbortController();
	controller.abort(new Error("observation cancelled"));
	const controlsBeforeAbort = observed.length;
	await assert.rejects(
		dispatch("inspect", { ...params, view: "history" }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
		/observation cancelled/u,
	);
	assert.ok(observed.every((item) => item.caller === senderIdentity));
	assert.equal(observed.length, controlsBeforeAbort, "an already cancelled observation starts no manager control");
	assert.equal(acquire.mock.callCount(), 0);

	const entered = gate();
	const release = gate();
	const disposed = gate();
	const controlAborted = gate();
	const coldAbort = new AbortController();
	// The writer closed and left no write-ahead log bytes, so the cold read opens the storage in place.
	const open = DurableObservation.openSettled;
	t.mock.method(DurableObservation, "openSettled", async (...args: Parameters<typeof open>) => {
		const snapshot = await open(...args);
		const close = snapshot.close.bind(snapshot);
		snapshot.close = async () => {
			try {
				await close();
			} finally {
				disposed.resolve();
			}
		};
		entered.resolve();
		await release.promise;
		return snapshot;
	});
	const controlDuringRead = AgentManager.prototype.control;
	t.mock.method(
		AgentManager.prototype,
		"control",
		async function (this: AgentManager, ...args: Parameters<typeof control>) {
			try {
				return await controlDuringRead.apply(this, args);
			} finally {
				if (args[3]?.signal === coldAbort.signal) controlAborted.resolve();
			}
		},
	);
	let settled = false;
	const cancelled = dispatch(
		"inspect",
		{ ...params, view: "history" },
		withAbortSignal(coldAbort.signal, BACKGROUND_CONTEXT),
	).then(
		(value) => {
			settled = true;
			return value;
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	try {
		await entered.promise;
		coldAbort.abort(new Error("cold read cancelled"));
		await controlAborted.promise;
		assert.equal(observed.at(-1)?.signal, coldAbort.signal);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, true, "the caller ends its wait before the cold snapshot opens");
		assert.equal(runtime.isIdle(), false, "the runtime retains cleanup ownership until the cold read ends");
	} finally {
		release.resolve();
	}
	assert.match(String(await cancelled), /cold read cancelled/u);
	await disposed.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(runtime.isIdle(), true, "the completed cleanup releases runtime activity");
	assert.equal(existsSync(paths.claim), false);
	assert.equal(existsSync(paths.socket), false);
	const after = statSync(target.storagePath, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeNs, before.mtimeNs);
	await assert.rejects(dispatch("attach", params), /writer acquisition requested/u);
	await assert.rejects(dispatch("submit", { ...params, message: "not admitted" }), /writer acquisition requested/u);
	assert.equal(acquire.mock.callCount(), 2, "attach and mutation retain writer acquisition");
});

it("a view publication reads again only the conversations with a stored change", { timeout: 60000 }, async (t) => {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close());
	const fixture = runtimeFixture(t);
	const model = { provider: testModel.provider, modelId: testModel.id };
	let native: DurableHost | undefined;
	const open = DurableHost.open;
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		native = await open(...args);
		return native;
	});
	const projection = DurableHost.prototype.catalogProjection;
	const reads: (readonly number[] | "every")[] = [];
	t.mock.method(
		DurableHost.prototype,
		"catalogProjection",
		function (this: DurableHost, ...args: Parameters<typeof projection>) {
			reads.push(args[1] === undefined ? "every" : [...args[1]]);
			return projection.apply(this, args);
		},
	);
	const opened = await createDurableRuntime(
		{ ...fixture.metadata, model },
		{ modelRuntime: await createTestRuntime() },
	);
	runtime = opened;
	const published = () =>
		new Promise<void>((resolve) => {
			const off = opened.onChange?.(() => {
				off?.();
				resolve();
			});
		});
	await published();
	assert.deepEqual(reads, ["every"], "the first publication reads every conversation");
	assert.ok(native);
	const next = published();
	await native.harness.commit(
		(tx) => tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [answerMessage()] }),
		BACKGROUND_CONTEXT,
	);
	await next;
	assert.deepEqual(reads.slice(1), [[ROOT_CONVERSATION_ID]], "the next one reads the conversation of the new entry");
	assert.equal(opened.publishedView?.rows[0]?.latestReply, "durable answer");
});

it("a complete view follows a partial one without another commit", { timeout: 60000 }, async (t) => {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close());
	const fixture = runtimeFixture(t);
	const model = { provider: testModel.provider, modelId: testModel.id };
	let hold = false;
	const models = await createTestRuntime();
	// The second request never ends: its turn runs, and no stored change names its conversation.
	const streamSimple = () => (hold ? pending(answerMessage("in flight")) : completed(answerMessage()));
	models.registerNativeProvider({
		id: testModel.provider,
		name: "Held request fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: streamSimple,
		streamSimple,
	});
	let native: DurableHost | undefined;
	const open = DurableHost.open;
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		native = await open(...args);
		return native;
	});
	const projection = DurableHost.prototype.catalogProjection;
	const reads: (readonly number[] | "every")[] = [];
	t.mock.method(
		DurableHost.prototype,
		"catalogProjection",
		function (this: DurableHost, ...args: Parameters<typeof projection>) {
			reads.push(args[1] === undefined ? "every" : [...args[1]]);
			return projection.apply(this, args);
		},
	);
	const opened = await createDurableRuntime(
		{ ...fixture.metadata, model },
		{ modelRuntime: models, completeViewIntervalMs: 1500 },
	);
	runtime = opened;
	const published = () =>
		new Promise<void>((resolve) => {
			const off = opened.onChange?.(() => {
				off?.();
				resolve();
			});
		});
	const row = (index: number) => opened.publishedView?.rows[index];
	assert.ok(native);
	const host = native;
	const first = await host.submit({ message: "First request", requestId: "first", origin: "operator" });
	await host.wait(first.submissionId, BACKGROUND_CONTEXT);
	const assistant = (await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.find(
		(item) => item.kind === "pi.assistant",
	);
	assert.ok(assistant);
	const fork = (await host.request("fork", { entryId: assistant.id })) as { conversationId: ConversationId };
	hold = true;
	await host.submit({ message: "Second request", requestId: "second", origin: "operator" });
	while (row(0)?.state !== "working" || row(1) === undefined) await published();

	// A change in the fork alone: the publication keeps the row of the root, whose turn still runs.
	let partial: readonly number[] | undefined;
	for (let attempt = 0; attempt < 5 && partial === undefined; attempt++) {
		const marker = `Marker ${attempt}`;
		await host.harness.commit(
			(tx) => tx.appendEntry(AssistantEntry, fork.conversationId, { model: [answerMessage(marker)] }),
			BACKGROUND_CONTEXT,
		);
		while (row(1)?.latestReply !== marker) await published();
		const last = reads.at(-1);
		if (last !== "every") partial = last;
	}
	assert.deepEqual(partial, [fork.conversationId]);
	const retained = row(0)?.durationMs;
	assert.equal(typeof retained, "number");

	// A stored change of the running turn can still name the root; only a read of every conversation counts.
	const deadline = new AbortController();
	const expired = pause(5000, "expired" as const, { signal: deadline.signal }).catch(() => "expired" as const);
	let outcome: "complete" | "expired" | undefined;
	while (outcome === undefined) {
		const next = await Promise.race([published().then(() => "published" as const), expired]);
		if (next === "expired") outcome = "expired";
		else if (reads.at(-1) === "every") outcome = "complete";
	}
	deadline.abort();
	assert.equal(outcome, "complete", "the commits stopped, and a view that reads every conversation followed");
	assert.ok(
		(row(0)?.durationMs ?? 0) > (retained ?? 0),
		`the running time of the root's turn moved on from ${retained} ms to ${row(0)?.durationMs} ms`,
	);
});
