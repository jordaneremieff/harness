import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { resolveAgentControlDispatch } from "./durable-agents.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { AgentManager } from "./manager.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const model = { provider: testModel.provider, modelId: testModel.id };
const ADMITTING = [
	"submit",
	"task-submit",
	"passive-submit",
	"report",
	"rewind",
	"fork",
	"compact",
	"configure",
	"command",
	"reset",
	"timer-schedule",
	"profile-update",
	"spawn",
	"place",
	"resolve-agent",
	"interrupt-continue",
] as const;

function threadStorage(fixture: ReturnType<typeof runtimeFixture>, primary: string) {
	return new AgentCatalog(fixture.root).createThreadStorage({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		packageDir: fixture.metadata.packageDir,
		model,
		thinkingLevel: "off",
		trust: false,
		ownerId: primary,
	}).record;
}

it("a Durable agent's controls and routes never reach a thread storage", { timeout: 60000 }, async (t) => {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close());
	const fixture = runtimeFixture(t);
	const primary = randomUUID();
	const threads = threadStorage(fixture, primary);
	const peer = new AgentCatalog(fixture.root).create({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		packageDir: fixture.metadata.packageDir,
		model,
		thinkingLevel: "off",
		trust: true,
	});
	runtime = await createDurableRuntime({ ...fixture.metadata, model }, { modelRuntime: await createTestRuntime() });
	const dispatch = resolveAgentControlDispatch();
	const acquired: string[] = [];
	t.mock.method(AgentManager.prototype, "connectNative", async (sessionId: string) => {
		acquired.push(sessionId);
		throw new Error("writer acquisition requested");
	});
	const senderIdentity = fixture.metadata.storageId;
	const refusal = `${threads.storageId} is a thread storage of ${primary}; it holds threads and runs no agent work. Use agent_collaborate with a threadId it holds, or message its owner ${primary}`;
	for (const method of [
		"submit",
		"rewind",
		"fork",
		"compact",
		"configure",
		"command",
		"reset",
		"timer-schedule",
		"profile-update",
	] as const)
		await assert.rejects(
			dispatch(method, { sessionId: threads.storageId, senderIdentity, ownerId: senderIdentity, message: "work" }),
			{ message: refusal },
			method,
		);
	await assert.rejects(dispatch("attach", { sessionId: threads.storageId, senderIdentity, model }), {
		message: refusal,
	});
	const recipient = (field: string, identity: string) =>
		`${field} ${identity} is a thread storage of ${primary}; it holds threads and receives no agent input. Name its owner ${primary} instead`;
	await assert.rejects(dispatch("report", { sessionId: threads.storageId, senderIdentity, message: "note" }), {
		message: recipient("recipient", threads.storageId),
	});
	for (const replyTo of [threads.storageId, `${threads.storageId}:3`])
		await assert.rejects(
			dispatch("submit", {
				sessionId: peer.storageId,
				senderIdentity,
				ownerId: senderIdentity,
				message: "work",
				replyTo,
			}),
			{ message: recipient("replyTo", replyTo) },
		);
	assert.deepEqual(acquired, [], "no refused control acquires a host");
	// A caller that started before it learned the refusal sends the route itself; the admitting host refuses it.
	for (const [method, params] of [
		["task-submit", { message: "work", requester: senderIdentity, replyTo: threads.storageId }],
		["task-submit", { message: "work", requester: threads.storageId }],
		["submit", { message: "work", ownerId: threads.storageId }],
		["report", { message: "note", ownerId: threads.storageId }],
		[
			"timer-schedule",
			{ message: "later", ownerId: threads.storageId, deliverAt: Date.now() + 60_000, mode: "followUp" },
		],
	] as const)
		await assert.rejects(
			runtime.request(method, { sessionId: fixture.metadata.storageId, ...params }, randomUUID()),
			{ message: recipient("recipient", threads.storageId) },
			method,
		);
	const status = (await runtime.request("status", { sessionId: fixture.metadata.storageId }, randomUUID())) as {
		state?: string;
		pendingMessageCount?: number;
	};
	assert.equal(status.pendingMessageCount ?? 0, 0, "no refused route left an input behind");
});

it("a thread storage's host serves threads and observation and admits no agent work or input", {
	timeout: 60000,
}, async (t) => {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close());
	const fixture = runtimeFixture(t);
	const primary = randomUUID();
	const threads = threadStorage(fixture, primary);
	runtime = await createDurableRuntime(hostMetadata(threads), { modelRuntime: await createTestRuntime() });
	const refusal = `${threads.storageId} is a thread storage of ${primary}; it holds threads and runs no agent work. Use agent_collaborate with a threadId it holds, or message its owner ${primary}`;
	for (const method of ADMITTING)
		await assert.rejects(
			runtime.request(
				method,
				{
					sessionId: threads.storageId,
					message: "work",
					ownerId: primary,
					requester: primary,
					senderIdentity: primary,
				},
				randomUUID(),
			),
			{ message: refusal },
			method,
		);
	await assert.rejects(runtime.request("attach", { sessionId: threads.storageId, model }, randomUUID()), {
		message: refusal,
	});
	const created = (await runtime.request(
		"collaboration-mutate",
		{
			action: "create",
			sessionId: threads.storageId,
			senderIdentity: primary,
			origin: "model",
			requestId: randomUUID(),
			title: "Review",
			purpose: "Test",
			authority: "Task",
			source: "Test",
			restrictions: "Local",
			acceptance: "Verified",
		},
		randomUUID(),
	)) as { threadId: string };
	assert.ok(created.threadId.startsWith(`${threads.storageId}/`));
	const listed = (await runtime.request("collaboration-list", { sessionId: threads.storageId }, randomUUID())) as {
		items: unknown[];
	};
	assert.equal(listed.items.length, 1);
	await runtime.request("attach", { sessionId: threads.storageId }, randomUUID());
	await runtime.request("recovery-state", {}, randomUUID());
	const inspected = (await runtime.request(
		"inspect",
		{ sessionId: threads.storageId, view: "history" },
		randomUUID(),
	)) as {
		entries: unknown[];
	};
	assert.deepEqual(inspected.entries, [], "its root conversation holds no input");
});

it("a thread storage's Durable host refuses an admission that bypasses its runtime", { timeout: 60000 }, async (t) => {
	const fixture = runtimeFixture(t);
	const primary = randomUUID();
	const threads = threadStorage(fixture, primary);
	const host = await DurableHost.open({
		...hostOptions(threads.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), threads.cwd),
		storageId: threads.storageId,
		threadStorageOwner: primary,
	});
	t.after(() => host.close());
	for (const method of ["submit", "task-submit", "passive-submit", "report", "timer-schedule", "rewind", "command"])
		await assert.rejects(
			host.request(method, { sessionId: threads.storageId, message: "work", ownerId: primary, origin: "model" }),
			{
				message: `${threads.storageId} is a thread storage of ${primary}; it holds threads and runs no agent work. Use agent_collaborate with a threadId it holds, or message its owner ${primary}`,
			},
			method,
		);
	assert.equal((await host.inspect()).submissions.length, 0);
	assert.ok(await host.request("status", { sessionId: threads.storageId }));
});
