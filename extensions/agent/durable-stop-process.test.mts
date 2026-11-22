import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import {
	killHost,
	processGone,
	runtimeFixture,
	trackHost,
	waitForProcessGone,
	waitForReceipt,
} from "./durable-runtime-fixture.mts";
import { acquireHost, type HostConnection, waitForHostRelease } from "./host-client.ts";
import { eventLog } from "./host-fixture.mts";
import type { HostMetadata } from "./host-protocol.ts";
import type { ResultReference } from "./result-schema.ts";

const CONTROL_MS = 5_000;
const STREAM_MS = 300;

async function submit(host: HostConnection, ownerId: string, message: string): Promise<number> {
	const { submissionId } = (await host.request(
		"submit",
		{
			message,
			requestId: message,
			ownerId,
			origin: "operator",
		},
		{ signal: AbortSignal.timeout(CONTROL_MS) },
	)) as { submissionId: number };
	assert.ok(submissionId);
	return submissionId;
}

/** Sample current state initially and again on each commit until the predicate holds. */
async function untilCommit<T>(
	host: HostConnection,
	label: string,
	read: (signal: AbortSignal) => Promise<T>,
	predicate: (value: T) => boolean,
): Promise<T> {
	assert.ok(host.subscribeChanges);
	const changes = eventLog<void>();
	const signal = AbortSignal.timeout(CONTROL_MS);
	const deadline = performance.now() + CONTROL_MS;
	const unsubscribe = await host.subscribeChanges(() => changes.push(undefined), signal);
	try {
		while (!signal.aborted) {
			const next = changes.length + 1;
			const value = await read(signal);
			if (predicate(value)) return value;
			await changes.waitForCount(next, Math.max(1, deadline - performance.now())).catch((cause: unknown) => {
				throw new Error(`${label}: last snapshot ${(JSON.stringify(value) ?? "undefined").slice(0, 1500)}`, { cause });
			});
		}
		throw new Error(`${label}: deadline passed`);
	} finally {
		unsubscribe();
	}
}

it("ends abort-resistant runs, keeps the stopped parent quiet, times out a silent stream and leaves a cold target offline", async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const settingsPath = join(f.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { extensions: string[] };
	settings.extensions[0] = fileURLToPath(new URL("./testdata/stop-process/provider.ts", import.meta.url));
	writeFileSync(
		settingsPath,
		JSON.stringify({
			...settings,
			retry: {
				enabled: true,
				maxRetries: 1,
				baseDelayMs: 1000,
				maxAgentDelayMs: 1000,
				provider: { timeoutMs: STREAM_MS },
			},
		}),
	);
	const env = { ...f.env("request"), PI_AGENT_IDLE_MINUTES: "0" };
	const open = async (context: TestContext, metadata: HostMetadata) => {
		const host = await acquireHost(metadata, { env, signal: AbortSignal.timeout(10_000) });
		trackHost(context, host.pid);
		context.after(() => host.close());
		return host;
	};
	const catalog = new AgentCatalog(f.root);
	const controllerMetadata = hostMetadata(
		catalog.create(
			{
				cwd: f.cwd,
				agentDir: f.agentDir,
				packageDir: f.metadata.packageDir,
				model: f.metadata.model,
				thinkingLevel: "off",
				name: "Stop controller",
				trust: true,
				ownerId: f.ownerId,
			},
			"stop-controller",
		),
	);
	const [parent, controller] = await Promise.all([open(t, f.metadata), open(t, controllerMetadata)]);
	const json = <T,>(name: string): T => JSON.parse(readFileSync(join(f.testDir, name), "utf8")) as T;
	const children = (tag: string): ResultReference[] => {
		const results = json<{ isError: boolean; details?: { result?: ResultReference } }[]>(`${tag}-spawns.json`);
		return results.map((result) => {
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.ok(result.details?.result, "spawn admitted an exact child input");
			return result.details.result;
		});
	};
	const result = async (host: HostConnection, reference: ResultReference, signal = AbortSignal.timeout(CONTROL_MS)) =>
		(await host.request("inspect", { ...reference, view: "result" }, { signal })) as {
			status: string;
			reason?: string;
		};
	const assertAborted = async (host: HostConnection, reference: ResultReference) => {
		const stopped = await result(host, reference);
		assert.equal(stopped.status, "unanswered", JSON.stringify(stopped));
		assert.equal(stopped.reason, "aborted", JSON.stringify(stopped));
	};
	const acknowledge = async (host: HostConnection, id: number) => {
		await host.request(
			"acknowledge",
			{ ownerId: f.ownerId, submissionIds: [id] },
			{
				signal: AbortSignal.timeout(CONTROL_MS),
			},
		);
	};
	const abort = async (caller: HostConnection, tag: string, target: string, timeoutMs: number) => {
		const id = await submit(caller, f.ownerId, `FIXTURE ABORT ${tag} ${target}`);
		const receipt = await waitForReceipt(caller, f.ownerId, id, timeoutMs);
		assert.equal(receipt.status, "done", JSON.stringify(receipt));
		const tool = json<{ isError: boolean; details: { cold?: boolean; settled?: boolean; pendingTasks?: number[] } }>(
			`stop-${tag}.json`,
		);
		assert.equal(tool.isError, false, JSON.stringify(tool));
		await acknowledge(caller, id);
		return tool.details;
	};
	const requests = () =>
		readFileSync(join(f.testDir, "requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sessionId?: string; command: string; tag: string });

	const spawn = await submit(parent, f.ownerId, "FIXTURE SPAWN single");
	await f.marker("child-requested");
	assert.equal((await waitForReceipt(parent, f.ownerId, spawn, CONTROL_MS)).status, "done");
	await acknowledge(parent, spawn);
	const [child] = children("single");
	assert.ok(child);
	await abort(parent, "child", child.sessionId, 10_000);
	await assertAborted(parent, child);

	const cascade = await submit(parent, f.ownerId, "FIXTURE SPAWN cascade");
	await Promise.all([f.marker("cascade-parent-requested"), f.marker("left-requested"), f.marker("right-requested")]);
	const parentSession = requests().findLast((request) => request.tag === "cascade")?.sessionId;
	assert.ok(parentSession);
	const generationRequests = () => requests().filter((request) => request.sessionId === parentSession).length;
	const before = generationRequests();
	const cascadeChildren = children("cascade");
	assert.equal(cascadeChildren.length, 2);
	await abort(controller, "cascade", f.metadata.storageId, 17_000);
	await assertAborted(parent, { sessionId: f.metadata.storageId, submissionId: cascade });
	for (const child of cascadeChildren) await assertAborted(parent, child);
	// Clear the fixture's own operator receipt, not the receipts routed to the stopped parent.
	await acknowledge(parent, cascade);
	await untilCommit(
		parent,
		"stopped parent and child receipt deliveries did not settle",
		async (signal) => {
			return (await parent.request("recovery-state", {}, { signal })) as {
				workPending: boolean;
				deliveriesPending: boolean;
				deliveriesActive: boolean;
			};
		},
		(state) => !state.workPending && !state.deliveriesPending && !state.deliveriesActive,
	);
	assert.equal(generationRequests(), before, "aborted child receipts did not start another parent provider request");

	const silent = await submit(controller, f.ownerId, "FIXTURE SILENT silent");
	await f.marker("silent-requested");
	const retry = await untilCommit(
		controller,
		"the silent provider did not enter a retry",
		async (signal) => {
			const status = (await controller.request("status", { sessionId: controllerMetadata.storageId }, { signal })) as {
				conversation?: { live?: { generation?: { retry?: { error: string } } } };
			};
			return status.conversation?.live?.generation?.retry;
		},
		(value) => value !== undefined,
	);
	assert.match(retry?.error ?? "", new RegExp(`timed out after ${STREAM_MS} ms`, "u"));
	const exhausted = await waitForReceipt(controller, f.ownerId, silent, CONTROL_MS);
	assert.equal(exhausted.status, "unanswered", JSON.stringify(exhausted));
	assert.equal(
		requests().filter((request) => request.command === "SILENT").length,
		2,
		"one actual retry reached the silent provider",
	);

	const offlineInput = await submit(parent, f.ownerId, "FIXTURE HANG offline");
	await f.marker("offline-requested");
	const queued = (await parent.request("submit", {
		message: "FIXTURE QUEUED later",
		requestId: "queued-at-stop",
		whenBusy: "followUp",
		ownerId: f.ownerId,
		origin: "operator",
	})) as { submissionId: number };
	const released = waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(CONTROL_MS) });
	killHost(parent.pid);
	await released;
	assert.ok(processGone(parent.pid), "the abort target has no running host at entry");
	const stopped = await abort(controller, "offline", f.metadata.storageId, 25_000);
	assert.equal(stopped.cold, true);
	assert.equal(stopped.settled, false, "the stop writer did not run the pending abort handlers");
	assert.ok(stopped.pendingTasks?.length);
	const retainedRequests = () =>
		requests().filter((request) => request.command === "HANG" && request.tag === "offline").length;
	assert.equal(retainedRequests(), 1, "the stop writer never resumed the retained provider request");
	const pids = new Set(readFileSync(join(f.testDir, "hosts.jsonl"), "utf8").trim().split("\n").map(Number));
	for (const pid of pids) {
		if (pid === parent.pid || pid === controller.pid) continue;
		assert.ok(await waitForProcessGone(pid), `cold abort left host ${pid} running`);
	}
	const reopened = await open(t, f.metadata);
	const recovered = await waitForReceipt(reopened, f.ownerId, offlineInput, CONTROL_MS);
	assert.equal(recovered.status, "unanswered");
	assert.equal(recovered.reason, "aborted");
	await assertAborted(reopened, { sessionId: f.metadata.storageId, submissionId: queued.submissionId });
	assert.equal(retainedRequests(), 1, "normal recovery settled the mark without replaying the provider call");
});
