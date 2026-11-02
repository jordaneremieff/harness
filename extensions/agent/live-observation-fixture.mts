import { onStoredCommit } from "./commit-observation.ts";
/**
 * Live-observation fixture host for transport tests.
 *
 * Run as the child process, it takes the storage claim through runHost and
 * serves a real DurableHost over the public host service surface, including the
 * live observation methods. The runtime forwards commits as change
 * notifications so the host pump publishes frames.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DurableHost } from "./durable-host.ts";
import { fixtureProvider, fixtureModelId, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import { runHost, type HostRuntime } from "./host-process.ts";
import { publishFixtureMarker } from "./testdata/durable-runtime/signal.ts";

async function createRuntime(metadata: ReturnType<typeof parseHostMetadata>, retire: () => Promise<void>): Promise<HostRuntime> {
	const durable = await DurableHost.open({
		storagePath: metadata.storagePath,
		storageId: metadata.storageId,
		cwd: metadata.cwd,
		models: await fixtureRuntime("answer"),
		registry: fixtureRegistry(),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
		resume: true,
	});
	const openedMarker = join(metadata.cwd, "observation-opened");
	const snapshotMarker = join(metadata.cwd, "snapshot-gated");
	const rejectReopen = process.env.DURABLE_TEST_OBSERVATION_REOPEN === "fail" && existsSync(openedMarker);
	let finishSnapshot: (() => void) | undefined;
	const holdSnapshot = async (): Promise<void> => {
		writeFileSync(snapshotMarker, "held");
		const notifyPath = process.env.DURABLE_TEST_NOTIFY;
		if (!notifyPath) throw new Error("DURABLE_TEST_NOTIFY is required for a gated snapshot");
		await publishFixtureMarker(notifyPath, "snapshot-gated");
		if (process.env.DURABLE_TEST_RETIRE === "clean") {
			const finished = new Promise<void>((resolve) => { finishSnapshot = resolve; });
			setImmediate(() => { void retire(); });
			await finished;
		} else await new Promise(() => {});
	};
	return {
		request: async (method, params) => {
			const input = (params ?? undefined) as Record<string, unknown> | undefined;
			if (method === "snapshot" && input?.fixtureHold === true && !existsSync(snapshotMarker)) await holdSnapshot();
			if (method === "observe-open") {
				if (rejectReopen) {
					if (process.env.DURABLE_TEST_NOTIFY) await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "observation-reopen-refused");
					throw new Error("observation reopen refused");
				}
				writeFileSync(openedMarker, "opened");
			}
			return durable.request(method, input);
		},
		close: async () => {
			await durable.close();
			// Transport closure precedes completion of the interrupted local request.
			setImmediate(() => finishSnapshot?.());
		},
		isIdle: () => durable.isIdle(),
		onChange: (listener) => onStoredCommit(durable.harness, () => listener()),
	};
}

async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("live observation fixture requires metadata JSON as its only argument");
	const metadata = parseHostMetadata(JSON.parse(raw));
	const gate = process.env.DURABLE_TEST_HOST_START_GATE;
	if (gate) await publishFixtureMarker(gate, "host-start-gated");
	const host = await runHost(() => createRuntime(metadata, () => host.close()), { metadata });
	await host.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
}
