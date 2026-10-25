import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { resolveAgentControlDispatch } from "./durable-agents.ts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { eventLog } from "./host-fixture.mts";
import { waitForHostRelease } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import { installSourceRoutes, sourceHostOptions } from "./source-route.ts";
import type { ProducerAwaitFact } from "./await-facts.ts";
import type { ResultReference } from "./result-reference.ts";
import { HOST_CONTRACT } from "./version-contract.ts";

const currentSource = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const packageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const targetPackageDir = process.env.PI_AGENT_EXISTING_PACKAGE_TEST_ROOT ? realpathSync(process.env.PI_AGENT_EXISTING_PACKAGE_TEST_ROOT) : packageDir;
function restoreEnvironment(previous: Map<string, string | undefined>): void {
	for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
type DeliveryCommunication = { kind: string; sender: { identity: string }; metadata: { requestId?: string; producerRequestId?: string; references?: { requestId: string; submissionId: number }[] } };
function communications(frames: readonly unknown[]): DeliveryCommunication[] {
	return frames.flatMap(frame => ((frame as { entries?: { communication?: { state: string; value?: DeliveryCommunication } }[] }).entries ?? []).flatMap(entry => entry.communication?.state === "ready" && entry.communication.value ? [entry.communication.value] : []));
}
async function crossRootDeliveries(runtime: Awaited<ReturnType<typeof createDurableRuntime>>, manager: AgentManager, sourceId: string, targetId: string, caller: ReturnType<typeof runtimeFixture>): Promise<void> {
	const target = await manager.connectNative(targetId);
	const forked = await target.request("fork", { sessionId: targetId, name: "exact reply recipient" }) as { identity: string };
	assert.ok(forked.identity.startsWith(`${targetId}:`));
	const frames = eventLog<unknown>();
	const stop = await manager.observeLive(forked.identity, "conversation", frame => frames.push(frame));
	assert.ok(stop);
	const seen = (kind: string, requestId: string) => communications(frames).find(value => value.kind === kind && value.sender.identity === sourceId && (value.metadata.requestId === requestId || value.metadata.producerRequestId === requestId || value.metadata.references?.some(reference => reference.requestId === requestId)));
	const waitDelivery = async (kind: string, requestId: string) => frames.waitFor(() => seen(kind, requestId) !== undefined).catch(error => { throw new Error(`Missing ${kind}/${requestId}: ${JSON.stringify(communications(frames)).slice(-2000)}; last frame ${JSON.stringify(frames.at(-1)).slice(0, 2000)}`, { cause: error }); });
	const submit = async (requestId: string, minutes = 0) => runtime.request("task-submit", { sessionId: sourceId, requester: targetId, replyTo: forked.identity, message: requestId, origin: "model", requestId, checkInMinutes: minutes }, requestId) as Promise<{ result: ResultReference }>;
	const finish = async (reference: ResultReference) => {
		await runtime.request("abort", { sessionId: sourceId }, `abort:${reference.requestId}`);
		await runtime.request("receipts", { sessionId: sourceId, ownerId: forked.identity, result: reference, wait: true }, `receipts:${reference.requestId}`, AbortSignal.timeout(15000));
	};
	try {
		Object.assign(process.env, caller.env("answer"));
		await resolveAgentControlDispatch()("report", { sessionId: forked.identity, senderIdentity: sourceId, message: "Cross-root report", requestId: "source-report" }, BACKGROUND_CONTEXT);
		await waitDelivery("report", "source-report");
		const answer = await submit("source-output");
		await waitDelivery("result", "source-output");
		assert.equal(seen("result", "source-output")?.metadata.references?.[0].submissionId, answer.result.submissionId);
		const requester = await target.request("snapshot", { sessionId: targetId }) as { entries: unknown[] };
		assert.equal(communications([requester]).some(value => value.sender.identity === sourceId && value.metadata.references?.some(reference => reference.requestId === "source-output")), false);
		Object.assign(process.env, caller.env("request"));
		const checkIn = await submit("source-check-in", 0.001);
		await waitDelivery("check-in", "source-check-in");
		await finish(checkIn.result);
		Object.assign(process.env, caller.env("retry"));
		const retry = await submit("source-retry");
		await frames.waitFor(() => communications(frames).some(value => value.kind === "report" && value.sender.identity === sourceId && value.metadata.requestId?.startsWith("provider-retry-burst:") === true)).catch(error => { throw new Error(`Missing native retry report: ${JSON.stringify(communications(frames)).slice(-4000)}`, { cause: error }); });
		await runtime.request("receipts", { sessionId: sourceId, ownerId: forked.identity, result: retry.result, wait: true }, "retry-settled", AbortSignal.timeout(15000));
	} finally { stop(); Object.assign(process.env, caller.env("answer")); }
}
const sources = [currentSource, ...(process.env.PI_AGENT_EXISTING_SOURCE_TEST_ROOT ? [realpathSync(process.env.PI_AGENT_EXISTING_SOURCE_TEST_ROOT)] : [])];

for (const targetSource of sources) test(`native cross-root send, exact await, observations and reopen use target source ${targetSource === currentSource ? "current" : "configured"}`, { timeout: 90000 }, async t => {
	const originalTarget = runtimeFixture(t, { withAgentExtension: true, packageDir: targetPackageDir });
	const targetRoot = targetSource === currentSource ? join(originalTarget.root, "previous-managed") : originalTarget.root;
	const { record: targetRecord } = new AgentCatalog(targetRoot).createHandled({ cwd: originalTarget.cwd, agentDir: originalTarget.agentDir, packageDir: targetPackageDir, model: originalTarget.metadata.model, thinkingLevel: "off", trust: true }, "expert", "Retain the expert role.");
	const target = { ...originalTarget, root: targetRoot, metadata: hostMetadata(targetRecord) };
	const caller = runtimeFixture(t, { withAgentExtension: true, retry: true, retryDelayMs: 1 });
	const callerSettings = JSON.parse(readFileSync(join(caller.agentDir, "settings.json"), "utf8"));
	callerSettings.retry.maxRetries = 1;
	writeFileSync(join(caller.agentDir, "settings.json"), JSON.stringify(callerSettings));
	const callerRoot = join(caller.root, "managed");
	const callerRecord = new AgentCatalog(callerRoot).create({ cwd: caller.cwd, agentDir: caller.agentDir, packageDir, model: caller.metadata.model, thinkingLevel: "off", trust: true });
	const targetSettings = JSON.parse(readFileSync(join(target.agentDir, "settings.json"), "utf8"));
	targetSettings.extensions[1] = join(targetSource, "extensions", "agent", "index.ts");
	writeFileSync(join(target.agentDir, "settings.json"), JSON.stringify(targetSettings));
	const route = { root: target.root, sourceRoot: targetSource, packageDir: targetPackageDir };
	await installSourceRoutes(callerRoot, [route]);
	const env = { ...caller.env("answer"), PI_AGENT_IDLE_MINUTES: "0", PI_HARNESS_FILE: undefined, DURABLE_TEST_HTTP: undefined };
	const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	const runtime = await createDurableRuntime(hostMetadata(callerRecord));
	const dispatch = resolveAgentControlDispatch();
	const manager = new AgentManager({ root: callerRoot, agentDir: caller.agentDir, packageDir: join(caller.root, "unused-caller-installation") });
	let targetPid: number | undefined;
	try {
		// The target's public runner needs no bridge helper from its source generation.
		assert.equal(sourceHostOptions(route).runner, join(targetSource, "extensions", "agent", "durable-runner.ts"));
		Object.assign(process.env, target.env("answer"), { PI_AGENT_IDLE_MINUTES: "0", DURABLE_TEST_HTTP: "1" });
		const client = await manager.connectNative(target.metadata.storageId);
		targetPid = client.pid;
		assert.equal(client.metadata.packageDir, targetPackageDir);
		assert.equal(client.metadata.agentDir, target.agentDir);
		const loaded = JSON.parse(readFileSync(join(target.testDir, `load-proof-${client.pid}.json`), "utf8"));
		assert.equal(realpathSync(loaded.packageDir), targetPackageDir);
		assert.equal(loaded.modelRuntime, true);
		if (client.runtimeContract.operations.compact?.request !== HOST_CONTRACT.operations.compact.request) {
			await assert.rejects(manager.control("compact", { sessionId: target.metadata.storageId, wait: false }, { id: callerRecord.storageId, cwd: caller.cwd }), /contract|version|incompatible/u);
		}
		assert.equal(await manager.resolveTarget("@expert"), target.metadata.storageId);
		const reused = await manager.spawn({ handle: "expert", role: "Do not replace the retained role." }, { id: callerRecord.storageId, cwd: caller.cwd }) as { sessionId: string; created: boolean; profile: { role: string } };
		assert.equal(reused.sessionId, target.metadata.storageId);
		assert.equal(reused.created, false);
		assert.equal(reused.profile.role, "Retain the expert role.");
		const frames = eventLog<unknown>();
		const stopFrames = await manager.observeLive(target.metadata.storageId, "conversation", frame => frames.push(frame));
		assert.ok(stopFrames);
		const facts = eventLog<ProducerAwaitFact>();
		const abort = new AbortController();
		const observed = dispatch("observe-producer-await", { sessionId: target.metadata.storageId, publish: async (fact: ProducerAwaitFact) => { facts.push(fact); } }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
		await facts.waitForCount(1);
		assert.equal(facts[0].unavailable, undefined);
		const send = async (requestId: string) => {
			const admitted = await dispatch("submit", { sessionId: "@expert", message: "Native cross-root input", senderIdentity: callerRecord.storageId, replyTo: callerRecord.storageId, requestId, origin: "model" }, BACKGROUND_CONTEXT) as { result: ResultReference };
			assert.equal(admitted.result.sessionId, target.metadata.storageId);
			return admitted.result;
		};
		const reference = await send("cross-root-first");
		const exact = await dispatch("receipts", { sessionId: reference.sessionId, ownerId: callerRecord.storageId, result: reference, wait: true }, withAbortSignal(AbortSignal.timeout(15000), BACKGROUND_CONTEXT)) as { outcome: { status: string; submissionId: number } };
		assert.equal(exact.outcome.status, "done");
		assert.equal(exact.outcome.submissionId, reference.submissionId);
		if (targetSource !== currentSource) {
			const pending = await client.request("receipts", { ownerId: callerRecord.storageId, wait: false }) as { receipts: { submissionId: number; acknowledged: boolean }[] };
			assert.ok(pending.receipts.some(receipt => receipt.submissionId === reference.submissionId && !receipt.acknowledged), "the original source retains its reverse outcome when the new namespace is outside its catalogue");
		}
		await frames.waitFor(items => items.length > 1);
		await facts.waitForCount(2);
		const inventory = await client.request("status", { sessionId: target.metadata.storageId }) as { inventory: { contributions: { source: string }[] } };
		assert.ok(inventory.inventory.contributions.some(item => item.source === join(targetSource, "extensions", "agent", "index.ts")));
		abort.abort(); await observed; stopFrames();
		await crossRootDeliveries(runtime, manager, callerRecord.storageId, target.metadata.storageId, caller);
		Object.assign(process.env, caller.env("await-reference"));
		const admittedAwait = await runtime.request("submit", { sessionId: callerRecord.storageId, message: `AWAIT_REFERENCE:${JSON.stringify(reference)}`, origin: "operator", requestId: "native-await" }, "native-await") as { submissionId: number };
		const callerOutcome = await dispatch("await-native", { result: { sessionId: callerRecord.storageId, submissionId: admittedAwait.submissionId, requestId: "native-await" } }, withAbortSignal(AbortSignal.timeout(15000), BACKGROUND_CONTEXT)) as { status: string; answer: string };
		assert.equal(callerOutcome.status, "done");
		assert.match(callerOutcome.answer, /AWAIT_FINISHED/u);
		const nativeAwait = JSON.parse(readFileSync(join(caller.testDir, "await-return.json"), "utf8"));
		assert.notEqual(nativeAwait.result.isError, true);
		const awaitText = typeof nativeAwait.result.content === "string" ? nativeAwait.result.content : nativeAwait.result.content.map((part: { text?: string }) => part.text ?? "").join("");
		const awaitReply = JSON.parse(awaitText) as { results: { status: string; result: ResultReference }[]; unresolved: ResultReference[] };
		assert.equal(awaitReply.results[0].status, "done");
		assert.deepEqual(awaitReply.results[0].result, reference);
		assert.deepEqual(awaitReply.unresolved, []);
		const closing = client.request("close").catch(() => undefined);
		await closing;
		await waitForHostRelease(client.metadata, { after: closing });
		await client.close();
		Object.assign(process.env, target.env("answer"));
		const reopened = await manager.connectNative(target.metadata.storageId);
		assert.notEqual(reopened.pid, targetPid);
		targetPid = reopened.pid;
		const reopenedLoad = JSON.parse(readFileSync(join(target.testDir, `load-proof-${reopened.pid}.json`), "utf8"));
		assert.equal(realpathSync(reopenedLoad.packageDir), targetPackageDir);
		const second = await send("cross-root-reopened");
		const result = await dispatch("receipts", { sessionId: second.sessionId, ownerId: callerRecord.storageId, result: second, wait: true }, withAbortSignal(AbortSignal.timeout(15000), BACKGROUND_CONTEXT)) as { outcome: { status: string; submissionId: number } };
		assert.equal(result.outcome.status, "done");
		assert.equal(result.outcome.submissionId, second.submissionId);
		assert.equal((await manager.catalog.page({ limit: 20 })).records.length, 1);
		await assert.rejects(dispatch("status", { sessionId: randomUUID() }, BACKGROUND_CONTEXT), /exact native target is not retained/u);
	} finally {
		await runtime.close();
		try { const client = await manager.connectNative(target.metadata.storageId, false); const closing = client.request("close").catch(() => undefined); await closing; await waitForHostRelease(client.metadata, { after: closing }); } catch { if (targetPid) { try { process.kill(targetPid, "SIGKILL"); } catch {} } }
		manager.close();
		restoreEnvironment(previous);
	}
});

test("target source options reject missing source without falling back to the caller runner", () => {
	assert.throws(() => sourceHostOptions({ root: currentSource, sourceRoot: join(currentSource, "absent-source"), packageDir }));
	assert.ok(existsSync(join(currentSource, "extensions", "agent", "durable-runner.ts")));
});
